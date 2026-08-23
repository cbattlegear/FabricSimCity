using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.DatabaseCity;

/// <summary>One object reference's share of a compiled plan's estimated cost.</summary>
public sealed record PlanObjectCost(ShowplanObjectV1 Reference, decimal Cost);

/// <summary>
/// How one compiled plan's estimated cost divides between the objects it reads.
/// <para>
/// <see cref="UnattributedCost"/> is the part that reached no object at all -- compute over
/// constants, or a plan with no object reference anywhere. It is reported rather than folded into
/// the objects, because a share that landed nowhere must not inflate the ones that landed.
/// </para>
/// </summary>
public sealed record PlanCostSplit(
    IReadOnlyList<PlanObjectCost> Objects,
    decimal UnattributedCost,
    decimal TotalCost)
{
    public static readonly PlanCostSplit Empty = new([], 0m, 0m);

    /// <summary>False when the plan carried no usable cost estimate, so no share can be claimed.</summary>
    public bool HasCost => TotalCost > 0m;
}

/// <summary>
/// Divides a compiled plan's <em>estimated</em> cost between the objects the plan reads.
///
/// <para>
/// This is the optimizer's own arithmetic, not a measurement. Query Store records one wall-clock
/// total per query and says nothing about which table caused what, which is exactly why totals are
/// never divided elsewhere in this codebase. A cost estimate is different in kind: it is a real
/// artifact SQL Server produced and stored in the plan, and it is per-operator. Using it to spread a
/// measured total is therefore a *model*, and everything downstream is obliged to label it as one.
/// </para>
///
/// <para>
/// An operator's own cost is <c>EstimateCPU + EstimateIO</c>. It is deliberately not
/// <c>EstimatedTotalSubtreeCost</c>, which is cumulative -- summing that across operators counts
/// every child again at each ancestor, so a deep plan would attribute many times its own cost. The
/// subtree figure is used only as a fallback, as a parent-minus-children delta, for the rare plan
/// that carries no per-operator estimate at all.
/// </para>
///
/// <para>
/// Cost that lands on an operator naming no object is pushed <em>down</em> onto the objects in that
/// operator's subtree, in proportion to what those objects already cost. A hash join is expensive
/// because of the rows its inputs produced, so its cost belongs to the tables that produced them;
/// leaving it stranded at the join would under-count exactly the tables driving the query. Cost over
/// a subtree containing no object stays unattributed.
/// </para>
/// </summary>
public static class PlanCostAttribution
{
    /// <summary>
    /// Splits <paramref name="showplan"/>'s estimated cost per object reference. Returns
    /// <see cref="PlanCostSplit.Empty"/> when the plan has no operators or no cost estimate at all.
    /// </summary>
    public static PlanCostSplit Split(NormalizedShowplanV1 showplan)
    {
        ArgumentNullException.ThrowIfNull(showplan);
        var nodes = showplan.Nodes;
        if (nodes.Count == 0) return PlanCostSplit.Empty;

        var byId = new Dictionary<int, ShowplanNodeV1>(nodes.Count);
        foreach (var node in nodes) byId[node.NodeId] = node;

        var children = ChildIndex(nodes, byId, out var roots);
        var ownCosts = OwnCosts(nodes, children, byId);
        var order = PostOrder(nodes, children, roots, out var tops);

        var folded = new Dictionary<int, Subtree>(nodes.Count);
        foreach (var id in order)
        {
            if (!byId.TryGetValue(id, out var node)) continue;
            folded[id] = Fold(node, children.GetValueOrDefault(id), folded, ownCosts.GetValueOrDefault(id));
        }

        var total = new Subtree();
        foreach (var top in tops)
        {
            if (!folded.TryGetValue(top, out var subtree)) continue;
            total.Absorb(subtree);
        }

        // Dictionary enumeration order is not part of the contract, so the published order is fixed
        // here. A city that redraws itself differently on a second read is a city nobody can trust.
        var objects = total.ByObject
            .Select(entry => new PlanObjectCost(entry.Key, entry.Value))
            .OrderBy(entry => entry.Reference.Database ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Schema ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Table ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Index ?? string.Empty, StringComparer.Ordinal)
            .ToArray();

        var totalCost = total.Sum();
        return totalCost > 0m
            ? new PlanCostSplit(objects, total.Unattributed, totalCost)
            : PlanCostSplit.Empty;
    }

    private static Subtree Fold(
        ShowplanNodeV1 node,
        List<int>? childIds,
        Dictionary<int, Subtree> folded,
        decimal own)
    {
        var subtree = new Subtree();
        foreach (var childId in childIds ?? [])
            if (folded.TryGetValue(childId, out var child)) subtree.Absorb(child);

        if (node.ObjectReference is { } reference)
        {
            subtree.ByObject[reference] = subtree.ByObject.GetValueOrDefault(reference) + own;
            return subtree;
        }

        if (own <= 0m) return subtree;

        var basis = subtree.Sum();
        if (basis > 0m)
        {
            // Proportional pushdown includes the unattributed pool, so cost over a half-attributed
            // subtree does not silently become fully attributed on the way up.
            foreach (var key in subtree.ByObject.Keys.ToArray())
                subtree.ByObject[key] += own * subtree.ByObject[key] / basis;
            subtree.Unattributed += own * subtree.Unattributed / basis;
        }
        else if (subtree.ByObject.Count > 0)
        {
            // Free reads below an expensive operator: the objects are real but cost nothing on their
            // own, so the operator's cost divides evenly rather than vanishing into unattributed.
            var each = own / subtree.ByObject.Count;
            foreach (var key in subtree.ByObject.Keys.ToArray()) subtree.ByObject[key] += each;
        }
        else
        {
            subtree.Unattributed += own;
        }

        return subtree;
    }

    /// <summary>
    /// Per-operator cost, preferring <c>EstimateCPU + EstimateIO</c>. When a plan carries neither on
    /// any operator, falls back to each operator's subtree cost minus its children's, which
    /// reconstructs the same per-operator figure from the cumulative one.
    /// </summary>
    private static Dictionary<int, decimal> OwnCosts(
        IReadOnlyList<ShowplanNodeV1> nodes,
        Dictionary<int, List<int>> children,
        Dictionary<int, ShowplanNodeV1> byId)
    {
        var direct = new Dictionary<int, decimal>(nodes.Count);
        var sawDirect = false;
        foreach (var node in nodes)
        {
            var own = (node.EstimatedCpuCost ?? 0m) + (node.EstimatedIoCost ?? 0m);
            if (own > 0m) sawDirect = true;
            direct[node.NodeId] = own > 0m ? own : 0m;
        }

        if (sawDirect) return direct;

        var delta = new Dictionary<int, decimal>(nodes.Count);
        foreach (var node in nodes)
        {
            var below = 0m;
            foreach (var childId in children.GetValueOrDefault(node.NodeId) ?? [])
                if (byId.TryGetValue(childId, out var child)) below += child.EstimatedTotalSubtreeCost ?? 0m;
            var own = (node.EstimatedTotalSubtreeCost ?? 0m) - below;
            delta[node.NodeId] = own > 0m ? own : 0m;
        }

        return delta;
    }

    private static Dictionary<int, List<int>> ChildIndex(
        IReadOnlyList<ShowplanNodeV1> nodes,
        Dictionary<int, ShowplanNodeV1> byId,
        out List<int> roots)
    {
        var children = new Dictionary<int, List<int>>();
        roots = [];
        foreach (var node in nodes)
        {
            if (node.ParentNodeId is not { } parent || parent == node.NodeId || !byId.ContainsKey(parent))
            {
                roots.Add(node.NodeId);
                continue;
            }

            if (!children.TryGetValue(parent, out var bucket)) children[parent] = bucket = [];
            bucket.Add(node.NodeId);
        }

        foreach (var bucket in children.Values) bucket.Sort();
        roots.Sort();
        return children;
    }

    /// <summary>
    /// Children before parents, matching the direction rows flow through a plan. Operators stranded
    /// in a parent-link cycle are folded as their own tops rather than dropped, so a malformed plan
    /// loses no cost.
    /// </summary>
    private static List<int> PostOrder(
        IReadOnlyList<ShowplanNodeV1> nodes,
        Dictionary<int, List<int>> children,
        List<int> roots,
        out List<int> tops)
    {
        var order = new List<int>(nodes.Count);
        var seen = new HashSet<int>();
        var stack = new Stack<(int Id, bool Expanded)>();
        tops = [];

        var starts = new List<int>(roots.Count + nodes.Count);
        starts.AddRange(roots);
        foreach (var node in nodes) starts.Add(node.NodeId);

        foreach (var start in starts)
        {
            if (!seen.Add(start)) continue;
            tops.Add(start);
            stack.Push((start, false));
            while (stack.Count > 0)
            {
                var (id, expanded) = stack.Pop();
                if (expanded)
                {
                    order.Add(id);
                    continue;
                }

                stack.Push((id, true));
                var bucket = children.GetValueOrDefault(id);
                if (bucket is null) continue;
                for (var index = bucket.Count - 1; index >= 0; index -= 1)
                {
                    var child = bucket[index];
                    if (seen.Add(child)) stack.Push((child, false));
                }
            }
        }

        return order;
    }

    private sealed class Subtree
    {
        public Dictionary<ShowplanObjectV1, decimal> ByObject { get; } = [];

        public decimal Unattributed { get; set; }

        public decimal Sum()
        {
            var total = Unattributed;
            foreach (var value in ByObject.Values) total += value;
            return total;
        }

        public void Absorb(Subtree other)
        {
            foreach (var (key, value) in other.ByObject)
                ByObject[key] = ByObject.GetValueOrDefault(key) + value;
            Unattributed += other.Unattributed;
        }
    }
}
