using SqlSimCity.Collection.Blocking;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Requirement 4 coverage: blocker root/chain traversal, cycle detection, MARS dedupe, sentinel
/// preservation, idle-open-transaction retention, and parallel-wait preservation, purely against
/// <see cref="BlockingGraphBuilder"/> so these properties are proven for both the fixture and live
/// collector without a database.
/// </summary>
public class BlockingGraphBuilderTests
{
    private static BlockingInputFact Blocked(int sessionId, long? blockingSessionId, string waitType = "LCK_M_X") =>
        new("blocked_request", sessionId, 0, blockingSessionId, waitType, 500, "KEY: 5:1", "suspended", 0, null, "SELECT", 5);

    [Fact]
    public void ChainOfThreeResolvesEveryLinkToTheTrueTerminalRoot()
    {
        // 30 waits on 20, 20 waits on 10, 10 blocks but is not itself blocked.
        var facts = new[] { Blocked(30, 20), Blocked(20, 10) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Equal(["session:10"], graph.RootNodeIds);
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:30", ToNodeId: "session:20" });
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:20", ToNodeId: "session:10" });
        var node10 = graph.Nodes.Single(n => n.NodeId == "session:10");
        Assert.True(node10.IsRoot);
        Assert.Equal(1, node10.DirectlyBlockedCount); // only session 20 is a *direct* blocked child
        Assert.Equal(2, graph.Summary.BlockedSessionCount);
    }

    [Fact]
    public void CycleMarksEveryMemberAsRootAndInCycleWithNoAcyclicRoot()
    {
        // 10 waits on 20, 20 waits on 10: a true deadlock-shaped cycle with no real root.
        var facts = new[] { Blocked(10, 20), Blocked(20, 10) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Single(graph.Cycles);
        Assert.Equal(2, graph.Cycles[0].Count);
        Assert.All(graph.Nodes.Where(n => n.SessionId is 10 or 20), n =>
        {
            Assert.True(n.InCycle);
            Assert.True(n.IsRoot);
        });
        Assert.Equal(1, graph.Summary.CycleCount);
    }

    [Theory]
    [InlineData(-2, BlockingSentinelKind.OrphanedDistributedTransaction)]
    [InlineData(-3, BlockingSentinelKind.DeferredRecoveryTransaction)]
    [InlineData(-4, BlockingSentinelKind.IndeterminateLatchOwner)]
    public void NegativeSentinelsBecomeTheirOwnTerminalNodeAndAreCountedAsRoots(int sentinelValue, BlockingSentinelKind expectedKind)
    {
        var facts = new[] { Blocked(10, sentinelValue) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        var sentinelNode = graph.Nodes.Single(n => n.Kind == BlockingNodeKind.Sentinel);
        Assert.Equal(expectedKind, sentinelNode.Sentinel);
        Assert.Equal($"sentinel:{sentinelValue}", sentinelNode.NodeId);
        Assert.Contains(sentinelNode.NodeId, graph.RootNodeIds);
        Assert.Equal(1, graph.Summary.SentinelRootCount);
    }

    [Fact]
    public void UntrackedLatchOwnerSentinelIsNeverReportedAsARootOrBlockerIncident()
    {
        // -5 (untracked latch owner) is commonly benign internal bookkeeping (see
        // BlockingSentinelKind.UntrackedLatchOwner's doc comment) -- it must be retained as a node
        // for diagnostics, but never counted as a root or a "blocker" incident by itself.
        var facts = new[] { Blocked(10, -5) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        var sentinelNode = graph.Nodes.Single(n => n.Kind == BlockingNodeKind.Sentinel);
        Assert.Equal(BlockingSentinelKind.UntrackedLatchOwner, sentinelNode.Sentinel);
        Assert.Equal("sentinel:-5", sentinelNode.NodeId);
        Assert.False(sentinelNode.IsIdleWithOpenTransaction);

        Assert.False(sentinelNode.IsRoot);
        Assert.DoesNotContain(sentinelNode.NodeId, graph.RootNodeIds);
        Assert.Equal(0, graph.Summary.SentinelRootCount);
        Assert.Equal(0, graph.Summary.RootBlockerCount);
        Assert.Equal(0, graph.Summary.BlockedSessionCount);
        Assert.Empty(graph.RootNodeIds);
    }

    [Fact]
    public void TwoDistinctMarsBlockersOnTheSameSessionAreBothPreservedAsSeparateEdges()
    {
        // Session 40 has two concurrent MARS requests (different request ids), each blocked on a
        // *different* session. Both relationships must survive as distinct edges; the
        // blocked-session summary still counts session 40 exactly once.
        var facts = new[]
        {
            new BlockingInputFact("blocked_request", 40, 1, 10, "LCK_M_S", 500, "KEY: 5:1", "suspended", 0, null, "SELECT", 5),
            new BlockingInputFact("blocked_request", 40, 2, 11, "LCK_M_U", 300, "KEY: 5:2", "suspended", 0, null, "UPDATE", 5),
        };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Equal(1, graph.Summary.BlockedSessionCount);
        Assert.Equal(2, graph.Edges.Count);
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:40", ToNodeId: "session:10" });
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:40", ToNodeId: "session:11" });
        Assert.Equal(2, graph.Edges.Select(e => e.EdgeId).Distinct().Count());
        Assert.Equal(["session:10", "session:11"], graph.RootNodeIds);
        Assert.Equal(2, graph.Summary.RootBlockerCount);
    }

    [Fact]
    public void ThreeParallelWaitingTasksOnOneSessionEachBecomeTheirOwnEdge()
    {
        // A parallel query's 3 worker threads (exec_context_id 0,1,2) each independently record
        // their own blocking_session_id in sys.dm_os_waiting_tasks. None may be dropped in favor
        // of a single "first match" edge.
        var waitingTasks = new[]
        {
            new WaitingTaskFact("0x1", 55, 0, 100, "CXPACKET", null, null, 10, "coordinator wait"),
            new WaitingTaskFact("0x2", 55, 1, 250, "LCK_M_S", null, null, 11, "worker 1 wait"),
            new WaitingTaskFact("0x3", 55, 2, 300, "LCK_M_S", null, null, 11, "worker 2 wait"),
        };
        var graph = BlockingGraphBuilder.BuildGraph([], waitingTasks);

        Assert.Equal(3, graph.Edges.Count);
        Assert.Equal(3, graph.Edges.Select(e => e.EdgeId).Distinct().Count());
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:55", ToNodeId: "session:10", ExecContextId: 0 });
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:55", ToNodeId: "session:11", ExecContextId: 1 });
        Assert.Contains(graph.Edges, e => e is { FromNodeId: "session:55", ToNodeId: "session:11", ExecContextId: 2 });

        // Session 11 is directly blocked by only one distinct session (55) despite two edges
        // reaching it, so the count is never inflated by parallel duplicates (requirement 4/9).
        var node11 = graph.Nodes.Single(n => n.SessionId == 11);
        Assert.Equal(1, node11.DirectlyBlockedCount);
        Assert.Equal(1, graph.Summary.BlockedSessionCount);
    }

    [Fact]
    public void CycleMemberWithAnEscapingParallelEdgeIsNotMisreportedAsADeadEndRoot()
    {
        // Session 10 has two parallel blockers: session 20 (which cycles back to 10) and session
        // 30 (a true acyclic root). The 10<->20 pair is still a real, reported cycle, but 10/20 are
        // not roots, because the component is not a sink -- it can escape to 30.
        var facts = new[]
        {
            Blocked(10, 20),
            new BlockingInputFact("blocked_request", 10, 2, 30, "LCK_M_S", 400, "KEY: 5:3", "suspended", 0, null, "SELECT", 5),
            Blocked(20, 10),
        };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Single(graph.Cycles);
        Assert.All(graph.Nodes.Where(n => n.SessionId is 10 or 20), n =>
        {
            Assert.True(n.InCycle);
            Assert.False(n.IsRoot);
        });

        var node30 = graph.Nodes.Single(n => n.SessionId == 30);
        Assert.True(node30.IsRoot);
        Assert.Equal(["session:30"], graph.RootNodeIds);
    }

    [Fact]
    public void MARSMultipleBlockedRowsForTheSameSessionAreDedupedToOneEdge()
    {
        // Same blocked session id appearing twice (two concurrent MARS requests both waiting)
        // must not double-count the blocked-session total or produce two edges to the same target.
        var facts = new[]
        {
            Blocked(40, 10, "LCK_M_S"),
            Blocked(40, 10, "LCK_M_S"),
        };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Equal(1, graph.Summary.BlockedSessionCount);
        Assert.Single(graph.Edges);
    }

    [Fact]
    public void IdleSessionHoldingAnOpenTransactionIsRetainedAsAPotentialRoot()
    {
        var idleBlocker = new BlockingInputFact(
            "idle_open_transaction", 99, null, null, null, null, null, "sleeping", 1, null, null, 5);
        var facts = new[] { Blocked(10, 99), idleBlocker };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        var idleNode = graph.Nodes.Single(n => n.SessionId == 99);
        Assert.True(idleNode.IsIdleWithOpenTransaction);
        Assert.True(idleNode.IsRoot);
    }

    [Fact]
    public void ParallelWaitingTasksAreNeverCollapsedOntoTheCoordinatorWait()
    {
        var waitingTasks = new[]
        {
            new WaitingTaskFact("0x1", 55, 0, 100, "CXPACKET", null, null, null, "coordinator wait"),
            new WaitingTaskFact("0x2", 55, 1, 250, "CXPACKET", null, null, null, "worker 1 wait"),
            new WaitingTaskFact("0x3", 55, 2, 300, "CXPACKET", null, null, null, "worker 2 wait"),
        };
        var built = BlockingGraphBuilder.BuildWaitingTasks(waitingTasks);

        Assert.Equal(3, built.Count);
        Assert.Equal(ExecutionContextKind.Coordinator, built.Single(t => t.ExecContextId == 0).ExecutionContext);
        Assert.Equal(2, built.Count(t => t.ExecutionContext == ExecutionContextKind.Worker));

        var graph = BlockingGraphBuilder.BuildGraph([], waitingTasks);
        Assert.Equal(2, graph.Summary.ParallelWaitTaskCount);
    }

    [Fact]
    public void DiamondShapeDoesNotInflateBlockedCountBeyondDistinctSessions()
    {
        // Two independent sessions (20, 21) both block on the same terminal root 10: this is not
        // a cycle and must not be miscounted as one.
        var facts = new[] { Blocked(20, 10), Blocked(21, 10) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        Assert.Equal(2, graph.Summary.BlockedSessionCount);
        Assert.Empty(graph.Cycles);
        Assert.Equal(["session:10"], graph.RootNodeIds);
        Assert.Equal(2, graph.Nodes.Single(n => n.SessionId == 10).DirectlyBlockedCount);
    }
}
