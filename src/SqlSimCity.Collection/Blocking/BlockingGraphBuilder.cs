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
/// Key properties this builder guarantees (requirement 4):
/// - MARS: a session's blocking_inputs facts are deduplicated to exactly one graph edge per
///   distinct blocked session id, so a session with several concurrent MARS requests cannot inflate
///   <see cref="BlockingGraphSummaryV1.BlockedSessionCount"/>.
/// - Traversal always continues to the true root -- the terminal session with no recorded blocker
///   of its own, or an explicit negative sentinel -- never stopping at an intermediate hop.
/// - An idle session holding an open transaction is retained as a node (tagged
///   <see cref="BlockingNodeV1.IsIdleWithOpenTransaction"/>) even though it has no active request,
///   because it can still be a true root blocker.
/// - -2/-3/-4/-5 sentinel values become their own terminal <see cref="BlockingNodeKind.Sentinel"/>
///   nodes rather than being merged into session 0 or discarded; -5 is never reported as a blocking
///   problem by itself (see <see cref="BlockingSentinelKind.UntrackedLatchOwner"/>'s own doc comment).
/// - A cycle (every hop resolves to a real session with a recorded blocker, looping back on itself)
///   is detected and reported explicitly in <see cref="BlockingGraphV1.Cycles"/>; every member is
///   marked both root and in-cycle, because a true acyclic root does not exist for that group.
/// - Every parallel waiting task (one row per exec_context_id) is preserved individually in the
///   returned waiting-task list; none are collapsed onto the request's coordinator wait.
/// </summary>
public static class BlockingGraphBuilder
{
    public static BlockingGraphV1 BuildGraph(
        IReadOnlyList<BlockingInputFact> facts,
        IReadOnlyList<WaitingTaskFact> waitingTasks)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(waitingTasks);

        // Dedupe MARS: first-seen blocked_request row per distinct session id becomes that
        // session's single graph parent. See the class doc comment for the accepted trade-off.
        var parentOf = new Dictionary<int, BlockingInputFact>();
        var idleOpenTransactionSessions = new HashSet<int>();
        foreach (var fact in facts)
        {
            if (fact.FactSource == "blocked_request" && fact.BlockingSessionId is not null and not 0)
            {
                parentOf.TryAdd(fact.SessionId, fact);
            }
            else if (fact.FactSource == "idle_open_transaction")
            {
                idleOpenTransactionSessions.Add(fact.SessionId);
            }
        }

        var nodes = new Dictionary<string, BlockingNodeV1>();
        var edges = new List<BlockingEdgeV1>();
        var rootOf = new Dictionary<int, string>();
        var state = new Dictionary<int, int>(); // 0 implied unvisited, 1 = in-progress, 2 = resolved
        var cycles = new List<IReadOnlyList<string>>();
        var inCycleSessions = new HashSet<int>();

        foreach (var startSession in parentOf.Keys)
        {
            if (state.GetValueOrDefault(startSession) == 2)
            {
                continue;
            }

            var path = new List<int>();
            var current = startSession;
            while (true)
            {
                if (!parentOf.TryGetValue(current, out var fact))
                {
                    // 'current' has no recorded blocker of its own: it is a true root.
                    ResolvePath(path, current, "session:" + current, rootOf, state);
                    break;
                }

                var existingState = state.GetValueOrDefault(current);
                if (existingState == 1)
                {
                    // Cycle: 'current' already appears earlier in this same walk.
                    var cycleStart = path.IndexOf(current);
                    var cycleSessions = path.Skip(cycleStart).ToList();
                    var cycleNodeIds = cycleSessions.Select(s => "session:" + s).ToList();
                    cycles.Add(cycleNodeIds);
                    foreach (var s in cycleSessions)
                    {
                        inCycleSessions.Add(s);
                        rootOf[s] = "session:" + s; // every cycle member is its own root for traversal purposes
                        state[s] = 2;
                    }

                    // Anything walked before entering the cycle feeds into the cycle's entry point.
                    ResolvePath(path.Take(cycleStart).ToList(), current, "session:" + current, rootOf, state);
                    break;
                }

                if (existingState == 2)
                {
                    ResolvePath(path, current, rootOf[current], rootOf, state);
                    break;
                }

                state[current] = 1;
                path.Add(current);

                var blockerRaw = fact.BlockingSessionId!.Value;
                if (blockerRaw <= 0)
                {
                    var sentinelNodeId = "sentinel:" + blockerRaw;
                    ResolvePath(path, current: -1, sentinelNodeId, rootOf, state, resolveCurrentToo: false);
                    break;
                }

                current = (int)blockerRaw;
            }
        }

        // Build one edge per deduplicated blocked session (see class doc comment).
        foreach (var (sessionId, fact) in parentOf)
        {
            var blockerRaw = fact.BlockingSessionId!.Value;
            var toNodeId = blockerRaw <= 0 ? "sentinel:" + blockerRaw : "session:" + blockerRaw;
            var matchingTask = waitingTasks.FirstOrDefault(t =>
                t.SessionId == sessionId && t.BlockingSessionId == blockerRaw);
            edges.Add(new BlockingEdgeV1(
                EdgeId: $"edge:session:{sessionId}->{toNodeId}",
                FromNodeId: "session:" + sessionId,
                ToNodeId: toNodeId,
                WaitType: matchingTask?.WaitType ?? fact.WaitType,
                WaitDurationMs: (matchingTask?.WaitDurationMs ?? fact.WaitTimeMs)?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ExecutionContext: matchingTask is null ? null : matchingTask.ExecContextId == 0 ? ExecutionContextKind.Coordinator : ExecutionContextKind.Worker,
                ExecContextId: matchingTask?.ExecContextId));

            EnsureSessionNode(nodes, sessionId, idleOpenTransactionSessions);
            EnsureNode(nodes, toNodeId, blockerRaw <= 0
                ? (BlockingNodeKind.Sentinel, (int?)null, BlockingReferenceV1.FromRaw(blockerRaw).Sentinel)
                : (BlockingNodeKind.Session, (int?)blockerRaw, BlockingSentinelKind.None),
                idleOpenTransactionSessions);
        }

        // Retain every idle-open-transaction session as a node even if nothing currently blocks on
        // it yet, per requirement 4.
        foreach (var idleSession in idleOpenTransactionSessions)
        {
            EnsureSessionNode(nodes, idleSession, idleOpenTransactionSessions);
        }

        var directlyBlockedCount = edges
            .GroupBy(e => e.ToNodeId)
            .ToDictionary(g => g.Key, g => g.Count());

        var rootNodeIds = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var root in rootOf.Values)
        {
            rootNodeIds.Add(root);
        }

        foreach (var cycle in cycles)
        {
            foreach (var nodeId in cycle)
            {
                rootNodeIds.Add(nodeId);
            }
        }

        var finalNodes = nodes.Values.Select(n => n with
        {
            DirectlyBlockedCount = directlyBlockedCount.GetValueOrDefault(n.NodeId),
            InCycle = n.SessionId is { } sid3 && inCycleSessions.Contains(sid3),
            IsRoot = rootNodeIds.Contains(n.NodeId) && directlyBlockedCount.GetValueOrDefault(n.NodeId) > 0,
        }).OrderBy(n => n.NodeId, StringComparer.Ordinal).ToList();

        var effectiveRoots = finalNodes.Where(n => n.IsRoot).Select(n => n.NodeId).OrderBy(n => n, StringComparer.Ordinal).ToList();

        var parallelWaitTaskCount = waitingTasks.Count(t => t.ExecContextId != 0);
        var summary = new BlockingGraphSummaryV1(
            BlockedSessionCount: parentOf.Count,
            RootBlockerCount: effectiveRoots.Count(id => id.StartsWith("session:", StringComparison.Ordinal)),
            SentinelRootCount: effectiveRoots.Count(id => id.StartsWith("sentinel:", StringComparison.Ordinal)),
            CycleCount: cycles.Count,
            ParallelWaitTaskCount: parallelWaitTaskCount,
            Note: "This summary rolls up the graph for convenience only; every parallel worker wait " +
                  "remains individually present in the waiting-task list and is never collapsed onto " +
                  "its request's coordinator wait.");

        return new BlockingGraphV1(finalNodes, edges, effectiveRoots, cycles, summary);
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
            Blocking: BlockingReferenceV1.FromRaw(t.BlockingSessionId)))
        .ToList();

    private static void ResolvePath(
        IReadOnlyList<int> path,
        int current,
        string rootNodeId,
        Dictionary<int, string> rootOf,
        Dictionary<int, int> state,
        bool resolveCurrentToo = true)
    {
        foreach (var s in path)
        {
            rootOf[s] = rootNodeId;
            state[s] = 2;
        }

        if (resolveCurrentToo && current >= 0)
        {
            rootOf[current] = rootNodeId;
            state[current] = 2;
        }
    }

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
