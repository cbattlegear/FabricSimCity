using System.Globalization;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public static class PlanComparer
{
    public static PlanComparisonV1 Compare(NormalizedShowplanV1 left, NormalizedShowplanV1 right)
    {
        ArgumentNullException.ThrowIfNull(left);
        ArgumentNullException.ThrowIfNull(right);
        var leftNodes = PlanCanonicalizer.Flatten(left.Nodes);
        var rightNodes = PlanCanonicalizer.Flatten(right.Nodes);
        var changes = new List<PlanChangeV1>();
        CompareProperty(changes, "plan/optimization", left.Optimization.ToString(), right.Optimization.ToString());
        CompareProperty(changes, "plan/dispatcher", left.DispatcherExpression, right.DispatcherExpression);
        CompareProperty(changes, "plan/cardinalityEstimator", left.CardinalityEstimatorVersion, right.CardinalityEstimatorVersion);
        CompareProperty(changes, "plan/serialDesiredMemoryKiB", Format(left.SerialDesiredMemoryKiB), Format(right.SerialDesiredMemoryKiB));
        CompareProperty(changes, "plan/serialRequiredMemoryKiB", Format(left.SerialRequiredMemoryKiB), Format(right.SerialRequiredMemoryKiB));
        foreach (var path in leftNodes.Keys.Union(rightNodes.Keys).Order(StringComparer.Ordinal))
        {
            leftNodes.TryGetValue(path, out var before);
            rightNodes.TryGetValue(path, out var after);
            if (before is null || after is null)
            {
                changes.Add(new PlanChangeV1(
                    path, before is null ? "Added" : "Removed",
                    before?.PhysicalOperation, after?.PhysicalOperation));
                continue;
            }
            CompareProperty(changes, path + "/logical", before.LogicalOperation, after.LogicalOperation);
            CompareProperty(changes, path + "/physical", before.PhysicalOperation, after.PhysicalOperation);
            CompareProperty(changes, path + "/object", ObjectName(before.ObjectReference), ObjectName(after.ObjectReference));
            CompareProperty(changes, path + "/predicate", before.Predicate, after.Predicate);
            CompareProperty(changes, path + "/parallel", before.Parallel.ToString(), after.Parallel.ToString());
            CompareProperty(changes, path + "/estimatedRows", Format(before.EstimatedRows), Format(after.EstimatedRows));
            CompareProperty(changes, path + "/warnings", Warnings(before), Warnings(after));
        }

        return new PlanComparisonV1(
            "1.0", left.PlanId, right.PlanId,
            string.Equals(left.StructuralFingerprint, right.StructuralFingerprint, StringComparison.Ordinal),
            changes, "Normalized Query Store Showplan",
            "Structural topology/property comparison independent of NodeId numbering; runtime remains query-level aggregate evidence.");
    }

    private static void CompareProperty(
        List<PlanChangeV1> changes, string path, string? before, string? after)
    {
        if (!string.Equals(before, after, StringComparison.Ordinal))
            changes.Add(new PlanChangeV1(path, "Changed", before, after));
    }
    private static string? ObjectName(ShowplanObjectV1? value) => value is null
        ? null : $"{value.Database}.{value.Schema}.{value.Table}.{value.Index}";
    private static string Warnings(ShowplanNodeV1 value) => string.Join(
        ";", value.Warnings.Select(warning => $"{warning.Kind}:{warning.Detail}").Order(StringComparer.Ordinal));
    private static string? Format(decimal? value) => value?.ToString(CultureInfo.InvariantCulture);
}

internal static class PlanCanonicalizer
{
    public static StringBuilder Canonicalize(
        IEnumerable<ShowplanNodeV1> nodes,
        QueryOptimizationKind optimization,
        string? dispatcherExpression,
        string? cardinalityEstimatorVersion,
        decimal? serialDesiredMemoryKiB,
        decimal? serialRequiredMemoryKiB)
    {
        var builder = new StringBuilder()
            .Append(optimization).Append('|').Append(dispatcherExpression).Append('|')
            .Append(cardinalityEstimatorVersion).Append('|')
            .Append(Format(serialDesiredMemoryKiB)).Append('|')
            .Append(Format(serialRequiredMemoryKiB)).AppendLine();
        foreach (var pair in Flatten(nodes))
        {
            var node = pair.Value;
            builder.Append(pair.Key).Append('|')
                .Append(node.LogicalOperation).Append('|').Append(node.PhysicalOperation).Append('|')
                .Append(node.Parallel).Append('|').Append(node.ObjectReference?.Database).Append('|')
                .Append(node.ObjectReference?.Schema).Append('|').Append(node.ObjectReference?.Table).Append('|')
                .Append(node.ObjectReference?.Index).Append('|').Append(node.Predicate).Append('|')
                .Append(Format(node.EstimatedRows)).Append('|').Append(Format(node.EstimatedCpuCost)).Append('|')
                .Append(Format(node.EstimatedIoCost)).Append('|').Append(Format(node.EstimatedTotalSubtreeCost)).Append('|')
                .Append(string.Join(";", node.Warnings.Select(warning => $"{warning.Kind}:{warning.Detail}")
                    .Order(StringComparer.Ordinal))).AppendLine();
        }
        return builder;
    }

    private static string? Format(decimal? value) => value?.ToString(CultureInfo.InvariantCulture);

    public static IReadOnlyDictionary<string, ShowplanNodeV1> Flatten(IEnumerable<ShowplanNodeV1> nodeSequence)
    {
        var nodes = nodeSequence.ToArray();
        var roots = nodes.Where(node => node.ParentNodeId is null).ToArray();
        var root = roots.Length == 1
            ? roots[0] : throw new InvalidOperationException("A normalized plan must have exactly one root.");
        var byParent = nodes.Where(node => node.ParentNodeId is not null)
            .GroupBy(node => node.ParentNodeId!.Value)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var result = new SortedDictionary<string, ShowplanNodeV1>(StringComparer.Ordinal);
        Visit(root, "root", byParent, result);
        return result;
    }

    private static void Visit(
        ShowplanNodeV1 node,
        string path,
        IReadOnlyDictionary<int, ShowplanNodeV1[]> byParent,
        IDictionary<string, ShowplanNodeV1> output)
    {
        output.Add(path, node);
        if (!byParent.TryGetValue(node.NodeId, out var children)) return;
        for (var index = 0; index < children.Length; index++)
            Visit(children[index], $"{path}/{index}", byParent, output);
    }
}
