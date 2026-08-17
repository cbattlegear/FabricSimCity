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
    [InlineData(-5, BlockingSentinelKind.UntrackedLatchOwner)]
    public void NegativeSentinelsBecomeTheirOwnTerminalNodeNeverZeroOrNull(int sentinelValue, BlockingSentinelKind expectedKind)
    {
        var facts = new[] { Blocked(10, sentinelValue) };
        var graph = BlockingGraphBuilder.BuildGraph(facts, []);

        var sentinelNode = graph.Nodes.Single(n => n.Kind == BlockingNodeKind.Sentinel);
        Assert.Equal(expectedKind, sentinelNode.Sentinel);
        Assert.Equal($"sentinel:{sentinelValue}", sentinelNode.NodeId);
        Assert.Contains(sentinelNode.NodeId, graph.RootNodeIds);
        Assert.Equal(1, graph.Summary.SentinelRootCount);

        // -5 (untracked latch owner) must never itself be reported as a blocking *problem*: the
        // graph records it as an ordinary sentinel node with no extra "problem" flag anywhere.
        if (expectedKind == BlockingSentinelKind.UntrackedLatchOwner)
        {
            Assert.False(sentinelNode.IsIdleWithOpenTransaction);
        }
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
