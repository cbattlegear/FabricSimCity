using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Blocking;

/// <summary>Raw row shape for one <c>sessions.blocking_inputs</c> fact (see the probe's own header for field meaning).</summary>
public sealed record BlockingInputFact(
    string FactSource, // "blocked_request" | "idle_open_transaction"
    int SessionId,
    int? RequestId,
    long? BlockingSessionId,
    string? WaitType,
    long? WaitTimeMs,
    string? WaitResource,
    string? Status,
    int? OpenTransactionCount,
    DateTimeOffset? StartTime,
    string? Command,
    int? DatabaseId);

/// <summary>Raw row shape for one <c>sessions.waiting_tasks</c> row.</summary>
public sealed record WaitingTaskFact(
    string WaitingTaskAddress,
    int SessionId,
    int ExecContextId,
    long WaitDurationMs,
    string? WaitType,
    string? ResourceAddress,
    string? BlockingTaskAddress,
    long? BlockingSessionId,
    string? ResourceDescription);

/// <summary>
/// Builds a <see cref="BlockingGraphV1"/> and the flat <see cref="WaitingTaskV1"/> list purely from
/// the raw facts <c>sessions.blocking_inputs</c> and <c>sessions.waiting_tasks</c> return -- neither
/// probe walks a chain or computes a root itself (see their own headers); this is where that
/// application-layer logic lives, exactly once, so both the live and fixture collectors produce an
/// identical graph shape for identical facts.
///
/// Key properties this builder guarantees (requirement 4, revised per follow-up review item 9):
/// - MARS: distinct <c>(session, request, blocker)</c> relationships are all preserved as separate
///   edges -- a session with two concurrent MARS requests blocked on two *different* sessions gets
///   two edges, never just the first-seen one. <see cref="BlockingGraphSummaryV1.BlockedSessionCount"/>
///   still counts *distinct blocked sessions*, not edges, so MARS duplication cannot inflate it.
/// - Every parallel waiting task (one row per exec_context_id, each with its own
///   <c>blocking_session_id</c>) becomes its own edge; none are collapsed onto a single
///   representative or onto the request's coordinator wait.
/// - Traversal always continues to the true root(s) -- terminal sessions with no recorded blocker
///   of their own, or an explicit negative sentinel -- never stopping at an intermediate hop. A
///   node can have more than one outgoing edge, so this is general graph reachability, not a single
///   linked chain.
/// - An idle session holding an open transaction is retained as a node (tagged
///   <see cref="BlockingNodeV1.IsIdleWithOpenTransaction"/>) even though it has no active request,
///   because it can still be a true root blocker.
/// - -2/-3/-4/-5 sentinel values become their own terminal <see cref="BlockingNodeKind.Sentinel"/>
///   nodes rather than being merged into session 0 or discarded. -5
///   (<see cref="BlockingSentinelKind.UntrackedLatchOwner"/>) is commonly benign latch/spinlock
///   bookkeeping, not a blocking problem by itself, so it is excluded from
///   <see cref="BlockingNodeV1.IsRoot"/>, <see cref="BlockingGraphV1.RootNodeIds"/>, and
///   <see cref="BlockingGraphSummaryV1.SentinelRootCount"/> even though the node itself is retained
///   for diagnostics.
/// - A cycle (every hop resolves to a real session with a recorded blocker, looping back on itself)
///   is detected via strongly-connected-component analysis and reported explicitly in
///   <see cref="BlockingGraphV1.Cycles"/>. Every member is marked <see cref="BlockingNodeV1.InCycle"/>;
///   members are additionally marked <see cref="BlockingNodeV1.IsRoot"/> only when the whole
///   component has no edge escaping it, because only then does a true acyclic root not exist for
///   that group -- a member that also reaches a real root through a different parallel edge is not
///   misreported as a dead-end.
/// </summary>
public static class BlockingGraphBuilder
{
    private sealed record RelationshipEdge(
        int SessionId,
        int? RequestId,
        int? ExecContextId,
        long BlockerRaw,
        string? WaitType,
        string? WaitDurationMs);

    public static BlockingGraphV1 BuildGraph(
        IReadOnlyList<BlockingInputFact> facts,
        IReadOnlyList<WaitingTaskFact> waitingTasks)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(waitingTasks);

        var idleOpenTransactionSessions = new HashSet<int>();
        foreach (var fact in facts)
        {
            if (fact.FactSource == "idle_open_transaction")
            {
                idleOpenTransactionSessions.Add(fact.SessionId);
            }
        }

        var relationshipEdges = BuildRelationshipEdges(facts, waitingTasks);

        // Adjacency restricted to session->session hops (sentinels are always leaves) drives
        // strongly-connected-component analysis so a node with several parallel blockers is
        // handled as general graph reachability rather than a single linked chain.
        var sessionAdjacency = new Dictionary<int, List<int>>();
        foreach (var edge in relationshipEdges)
        {
            if (edge.BlockerRaw > 0)
            {
                var list = sessionAdjacency.TryGetValue(edge.SessionId, out var existing)
                    ? existing
                    : sessionAdjacency[edge.SessionId] = [];
                var blockerSession = (int)edge.BlockerRaw;
                if (!list.Contains(blockerSession))
                {
                    list.Add(blockerSession);
                }
            }
        }

        var (cycleMembership, sinkCycleSessions, cycles) = FindCycles(sessionAdjacency);

        var nodes = new Dictionary<string, BlockingNodeV1>();
        var edges = new List<BlockingEdgeV1>();

        foreach (var edge in relationshipEdges)
        {
            var toNodeId = edge.BlockerRaw <= 0 ? "sentinel:" + edge.BlockerRaw : "session:" + edge.BlockerRaw;
            var edgeIdSuffix = edge.ExecContextId is { } ctx ? "ctx:" + ctx : "req:" + (edge.RequestId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "na");
            edges.Add(new BlockingEdgeV1(
                EdgeId: $"edge:session:{edge.SessionId}:{edgeIdSuffix}->{toNodeId}",
                FromNodeId: "session:" + edge.SessionId,
                ToNodeId: toNodeId,
                WaitType: edge.WaitType,
                WaitDurationMs: edge.WaitDurationMs,
                ExecutionContext: edge.ExecContextId is { } ec ? (ec == 0 ? ExecutionContextKind.Coordinator : ExecutionContextKind.Worker) : null,
                ExecContextId: edge.ExecContextId));

            EnsureSessionNode(nodes, edge.SessionId, idleOpenTransactionSessions);
            EnsureNode(nodes, toNodeId, edge.BlockerRaw <= 0
                ? (BlockingNodeKind.Sentinel, (int?)null, BlockingReferenceV1.FromRaw(edge.BlockerRaw).Sentinel)
                : (BlockingNodeKind.Session, (int?)edge.BlockerRaw, BlockingSentinelKind.None),
                idleOpenTransactionSessions);
        }

        // Retain every idle-open-transaction session as a node even if nothing currently blocks on
        // it yet, per requirement 4.
        foreach (var idleSession in idleOpenTransactionSessions)
        {
            EnsureSessionNode(nodes, idleSession, idleOpenTransactionSessions);
        }

        // "Directly blocked by" counts distinct blocked *sessions* per target, not edges, so a
        // session with several parallel waiting tasks all blocked on the same target cannot
        // inflate the count (requirement 4's "avoid inflated blocked counts").
        var incidentEdges = edges.Where(edge => edge.ToNodeId != "sentinel:-5").ToArray();
        var directlyBlockedCount = incidentEdges
            .GroupBy(e => e.ToNodeId)
            .ToDictionary(g => g.Key, g => g.Select(e => e.FromNodeId).Distinct().Count());

        var sessionsWithOutgoingEdges = new HashSet<int>(relationshipEdges.Select(e => e.SessionId));

        var finalNodes = nodes.Values.Select(n =>
        {
            var inCycle = n.SessionId is { } sidForCycle && cycleMembership.Contains(sidForCycle);
            bool isRoot;
            if (n.Kind == BlockingNodeKind.Sentinel)
            {
                // -5 (untracked latch owner) is diagnostic only and must never render as a root.
                isRoot = n.Sentinel != BlockingSentinelKind.UntrackedLatchOwner;
            }
            else
            {
                var sid = n.SessionId!.Value;
                var isSinkCycleMember = sinkCycleSessions.Contains(sid);
                var hasNoOutgoingEdge = !sessionsWithOutgoingEdges.Contains(sid);
                isRoot = (isSinkCycleMember || hasNoOutgoingEdge) && directlyBlockedCount.GetValueOrDefault(n.NodeId) > 0;
            }

            return n with
            {
                DirectlyBlockedCount = directlyBlockedCount.GetValueOrDefault(n.NodeId),
                InCycle = inCycle,
                IsRoot = isRoot,
            };
        }).OrderBy(n => n.NodeId, StringComparer.Ordinal).ToList();

        var effectiveRoots = finalNodes.Where(n => n.IsRoot).Select(n => n.NodeId).OrderBy(n => n, StringComparer.Ordinal).ToList();

        var blockedSessionCount = relationshipEdges
            .Where(edge => edge.BlockerRaw != -5)
            .Select(edge => edge.SessionId)
            .Distinct()
            .Count();
        var parallelWaitTaskCount = waitingTasks.Count(t => t.ExecContextId != 0);
        var summary = new BlockingGraphSummaryV1(
            BlockedSessionCount: blockedSessionCount,
            RootBlockerCount: effectiveRoots.Count(id => id.StartsWith("session:", StringComparison.Ordinal)),
            SentinelRootCount: effectiveRoots.Count(id => id.StartsWith("sentinel:", StringComparison.Ordinal)),
            CycleCount: cycles.Count,
            ParallelWaitTaskCount: parallelWaitTaskCount,
            Note: "This summary rolls up the graph for convenience only; every distinct MARS blocker " +
                  "relationship and every parallel worker wait remains individually present in the " +
                  "edges/waiting-task list and is never collapsed onto a single representative or " +
                  "onto its request's coordinator wait.");

        return new BlockingGraphV1(finalNodes, edges, effectiveRoots, cycles, summary);
    }

    /// <summary>
    /// Builds one relationship edge per distinct blocking fact, preferring the finer-grained
    /// per-exec-context <c>waiting_tasks</c> signal (requirement 9: "graph edges must preserve all
    /// parallel waiting tasks/exec_context_ids, not only first") and falling back to the
    /// request-level <c>blocking_inputs</c> fact only for a (session, blocker) pair that isn't
    /// already represented by a live wait row -- e.g. a probe/DMV timing race where
    /// blocking_session_id updated before the wait list did. Distinct MARS relationships
    /// (different request ids, different blockers, on the same session) are never discarded.
    /// </summary>
    private static List<RelationshipEdge> BuildRelationshipEdges(
        IReadOnlyList<BlockingInputFact> facts,
        IReadOnlyList<WaitingTaskFact> waitingTasks)
    {
        var edges = new List<RelationshipEdge>();
        var seenTaskEdgeKeys = new HashSet<(int SessionId, long BlockerRaw, int ExecContextId)>();
        var coveredSessionBlockerPairs = new HashSet<(int SessionId, long BlockerRaw)>();

        foreach (var task in waitingTasks)
        {
            if (task.BlockingSessionId is null or 0)
            {
                continue;
            }

            var blockerRaw = task.BlockingSessionId.Value;
            var key = (task.SessionId, blockerRaw, task.ExecContextId);
            if (!seenTaskEdgeKeys.Add(key))
            {
                continue;
            }

            coveredSessionBlockerPairs.Add((task.SessionId, blockerRaw));
            edges.Add(new RelationshipEdge(
                task.SessionId,
                RequestId: null,
                ExecContextId: task.ExecContextId,
                BlockerRaw: blockerRaw,
                WaitType: task.WaitType,
                WaitDurationMs: task.WaitDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        var seenBlockedRequestKeys = new HashSet<(int SessionId, int? RequestId, long BlockerRaw)>();
        foreach (var fact in facts)
        {
            if (fact.FactSource != "blocked_request" || fact.BlockingSessionId is null or 0)
            {
                continue;
            }

            var blockerRaw = fact.BlockingSessionId.Value;
            var key = (fact.SessionId, fact.RequestId, blockerRaw);
            if (!seenBlockedRequestKeys.Add(key))
            {
                continue; // exact duplicate row
            }

            if (coveredSessionBlockerPairs.Contains((fact.SessionId, blockerRaw)))
            {
                continue; // a waiting_tasks row already carries this (session, blocker) relationship
            }

            edges.Add(new RelationshipEdge(
                fact.SessionId,
                fact.RequestId,
                ExecContextId: null,
                BlockerRaw: blockerRaw,
                WaitType: fact.WaitType,
                WaitDurationMs: fact.WaitTimeMs?.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        return edges;
    }

    /// <summary>
    /// Tarjan's strongly-connected-components algorithm over the session-only adjacency map.
    /// Returns: every session that is a member of any size&gt;1 component or self-loop
    /// (<c>cycleMembership</c>); the subset of those whose component has no edge escaping it, i.e.
    /// no acyclic root exists for that group (<c>sinkCycleSessions</c>); and the ordered node-id
    /// list for each such component (<c>cycles</c>), for the deadlock-shaped case this project must
    /// report explicitly.
    /// </summary>
    private static (HashSet<int> CycleMembership, HashSet<int> SinkCycleSessions, List<IReadOnlyList<string>> Cycles)
        FindCycles(Dictionary<int, List<int>> sessionAdjacency)
    {
        var index = new Dictionary<int, int>();
        var lowLink = new Dictionary<int, int>();
        var onStack = new HashSet<int>();
        var stack = new Stack<int>();
        var components = new List<List<int>>();
        var counter = 0;

        var allSessions = new HashSet<int>(sessionAdjacency.Keys);
        foreach (var targets in sessionAdjacency.Values)
        {
            foreach (var t in targets)
            {
                allSessions.Add(t);
            }
        }

        foreach (var start in allSessions)
        {
            if (index.ContainsKey(start))
            {
                continue;
            }

            StrongConnect(start);
        }

        var cycleMembership = new HashSet<int>();
        var sinkCycleSessions = new HashSet<int>();
        var cycles = new List<IReadOnlyList<string>>();

        foreach (var component in components)
        {
            var isSelfLoop = component.Count == 1 && sessionAdjacency.GetValueOrDefault(component[0], []).Contains(component[0]);
            if (component.Count == 1 && !isSelfLoop)
            {
                continue; // trivial component: not a cycle
            }

            var componentSet = new HashSet<int>(component);
            foreach (var s in component)
            {
                cycleMembership.Add(s);
            }

            var isSink = component.All(s => sessionAdjacency.GetValueOrDefault(s, []).All(componentSet.Contains));
            if (isSink)
            {
                foreach (var s in component)
                {
                    sinkCycleSessions.Add(s);
                }
            }

            cycles.Add(component.OrderBy(s => s).Select(s => "session:" + s).ToList());
        }

        return (cycleMembership, sinkCycleSessions, cycles);

        void StrongConnect(int v)
        {
            index[v] = counter;
            lowLink[v] = counter;
            counter++;
            stack.Push(v);
            onStack.Add(v);

            foreach (var w in sessionAdjacency.GetValueOrDefault(v, []))
            {
                if (!index.TryGetValue(w, out var wIndex))
                {
                    StrongConnect(w);
                    lowLink[v] = Math.Min(lowLink[v], lowLink[w]);
                }
                else if (onStack.Contains(w))
                {
                    lowLink[v] = Math.Min(lowLink[v], wIndex);
                }
            }

            if (lowLink[v] != index[v])
            {
                return;
            }

            var component = new List<int>();
            int w2;
            do
            {
                w2 = stack.Pop();
                onStack.Remove(w2);
                component.Add(w2);
            } while (w2 != v);

            components.Add(component);
        }
    }

    public static IReadOnlyList<WaitingTaskV1> BuildWaitingTasks(IReadOnlyList<WaitingTaskFact> waitingTasks) =>
        waitingTasks.Select(t => new WaitingTaskV1(
            TaskId: string.IsNullOrEmpty(t.WaitingTaskAddress) ? $"wait:{t.SessionId}:{t.ExecContextId}" : t.WaitingTaskAddress,
            SessionId: t.SessionId,
            ExecutionContext: t.ExecContextId == 0 ? ExecutionContextKind.Coordinator : ExecutionContextKind.Worker,
            ExecContextId: t.ExecContextId,
            WaitType: t.WaitType,
            WaitDurationMs: t.WaitDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ResourceDescription: t.ResourceDescription,
            Blocking: BlockingReferenceV1.FromRaw(t.BlockingSessionId))
        {
            // Parsing is pure and free: it reports what the resource text already states and marks
            // hobt-scoped locks RequiresLookup rather than guessing an object.
            LockResource = LockResourceParser.Parse(t.ResourceDescription),
        })
        .ToList();

    private static void EnsureSessionNode(
        Dictionary<string, BlockingNodeV1> nodes,
        int sessionId,
        HashSet<int> idleOpenTransactionSessions) =>
        EnsureNode(nodes, "session:" + sessionId, (BlockingNodeKind.Session, sessionId, BlockingSentinelKind.None), idleOpenTransactionSessions);

    private static void EnsureNode(
        Dictionary<string, BlockingNodeV1> nodes,
        string nodeId,
        (BlockingNodeKind Kind, int? SessionId, BlockingSentinelKind Sentinel) shape,
        HashSet<int> idleOpenTransactionSessions)
    {
        if (nodes.ContainsKey(nodeId))
        {
            return;
        }

        nodes[nodeId] = new BlockingNodeV1(
            NodeId: nodeId,
            Kind: shape.Kind,
            SessionId: shape.SessionId,
            Sentinel: shape.Sentinel,
            IsRoot: false, // finalized after all edges are known
            IsIdleWithOpenTransaction: shape.SessionId is { } sid && idleOpenTransactionSessions.Contains(sid),
            InCycle: false, // finalized after all edges are known
            DirectlyBlockedCount: 0);
    }
}
