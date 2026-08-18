using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Reports a current root blocker: a real session at the head of a blocking chain that is stalling one
/// or more other sessions right now. Sentinel "owners" (orphaned/deferred/indeterminate/untracked latch,
/// including -5) are never reported as root blockers, because -5 in particular is commonly benign and is
/// not a blocking problem by itself.
/// </summary>
public sealed class RootBlockerRule : IFindingRule
{
    public string RuleId => "root-blocker";
    public string RuleVersion => "1";
    public string Title => "Current root blocker";
    public string Description =>
        "A real session is at the head of a live blocking chain and is currently stalling other sessions; sentinel owners (including -5) are excluded.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Live is not { } live)
            return RuleResult.NotEvaluated("No live incident snapshot was available.");
        var graph = live.BlockingGraph;
        if (graph.Nodes.Count == 0 || graph.RootNodeIds.Count == 0)
            return RuleResult.NotEvaluated("The live sample shows no blocking graph roots.");

        var nodesById = graph.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        var findings = new List<FindingV1>();
        var sawSentinelRoot = false;

        foreach (var rootId in graph.RootNodeIds)
        {
            if (!nodesById.TryGetValue(rootId, out var root))
                continue;
            if (root.Kind == BlockingNodeKind.Sentinel || root.Sentinel != BlockingSentinelKind.None)
            {
                sawSentinelRoot = true;
                continue;
            }
            if (root.DirectlyBlockedCount <= 0)
                continue;

            var downstream = CountDownstream(graph, rootId);
            var scope = new FindingScopeV1(bundle.TargetId, null, null, null,
                $"Session {root.SessionId?.ToString(CultureInfo.InvariantCulture) ?? rootId}")
            { ResourceId = rootId };
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Session {root.SessionId?.ToString(CultureInfo.InvariantCulture) ?? rootId} is a root blocker",
                RuleEvidence.LiveWindow(live),
                downstream >= 2 ? FindingSeverity.Serious : FindingSeverity.Notable,
                new MeasuredImpactV1(FindingImpactDimension.BlockedSessions, downstream.ToString(CultureInfo.InvariantCulture), "blocked sessions",
                    $"{root.DirectlyBlockedCount} directly blocked; {downstream} sessions downstream of this root at sample time."),
                RuleEvidence.Downgrade(FindingConfidence.High, live.Status),
                [new FindingEvidenceRefV1(FindingEvidenceKind.LiveBlockingNode, rootId,
                    $"Session {root.SessionId?.ToString(CultureInfo.InvariantCulture) ?? rootId}",
                    $"Root of a blocking chain; {root.DirectlyBlockedCount} directly blocked, idle-with-open-transaction: {root.IsIdleWithOpenTransaction}.")],
                ["This is a single point-in-time sample; the block may have already cleared.", RuleEvidence.SampleCaveat],
                ["A brief, expected lock during a normal transaction can appear as momentary blocking.",
                 "The root may be waiting on a resource itself that resolved between samples."],
                ["Re-check the live tab to see whether the block persists across samples.",
                 root.IsIdleWithOpenTransaction
                    ? "This root is idle with an open transaction; investigate the client that left the transaction open."
                    : "Identify the statement the root session is running."],
                "Read-only recommendation: investigate (do not kill blindly) the root session; SQLSimCity never terminates sessions or changes the server.",
                RuleEvidence.FromLive(live)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} current root blocker(s).", findings);
        return sawSentinelRoot
            ? RuleResult.NotEvaluated("The only blocking-graph roots were sentinel owners (e.g. -5), which are not blocker problems by themselves.")
            : RuleResult.NotEvaluated("No real session was a root blocker at sample time.");
    }

    private static int CountDownstream(BlockingGraphV1 graph, string rootId)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        queue.Enqueue(rootId);
        var blocked = new HashSet<string>(StringComparer.Ordinal);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            foreach (var edge in graph.Edges.Where(e => string.Equals(e.ToNodeId, current, StringComparison.Ordinal)))
            {
                if (!visited.Add(edge.FromNodeId))
                    continue;
                blocked.Add(edge.FromNodeId);
                queue.Enqueue(edge.FromNodeId);
            }
        }
        return blocked.Count;
    }
}

/// <summary>Reports sessions currently waiting for a memory grant (grant_time IS NULL), a real, current resource-semaphore queue.</summary>
public sealed class MemoryGrantQueueRule : IFindingRule
{
    public string RuleId => "memory-grant-queue";
    public string RuleVersion => "1";
    public string Title => "Current memory-grant queue";
    public string Description =>
        "One or more sessions are waiting for a query-memory grant at sample time (grant_time IS NULL), indicating current memory-grant pressure.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Live is not { } live)
            return RuleResult.NotEvaluated("No live incident snapshot was available.");

        var waiting = live.MemoryGrants.Where(grant => grant.IsWaitingForGrant).ToArray();
        if (waiting.Length == 0)
            return RuleResult.NotEvaluated("No session was waiting for a memory grant at sample time.");

        decimal requested = 0;
        var knownCount = 0;
        foreach (var grant in waiting)
            if (FindingImpact.TryParse(grant.RequestedKb, out var kb)) { requested += kb; knownCount++; }
        var anyRequestedKnown = knownCount > 0;

        var scope = new FindingScopeV1(bundle.TargetId, null, null, null, "Memory-grant queue")
        { ResourceId = "memory-grant-queue" };
        var finding = FindingFactory.Create(
            this,
            scope,
            $"{waiting.Length} session(s) waiting for a memory grant",
            RuleEvidence.LiveWindow(live),
            FindingSeverity.Notable,
            new MeasuredImpactV1(FindingImpactDimension.MemoryGrantKb,
                anyRequestedKnown ? FindingImpact.Format(requested) : null, "kilobytes",
                anyRequestedKnown
                    ? $"Requested {FindingImpact.Format(requested)} KB across {knownCount} of {waiting.Length} waiting session(s) with a known requested size."
                    : $"{waiting.Length} waiting session(s); requested size not exposed for these grants."),
            RuleEvidence.Downgrade(FindingConfidence.High, live.Status),
            waiting.Select(grant => new FindingEvidenceRefV1(FindingEvidenceKind.LiveMemoryGrant,
                grant.SessionId.ToString(CultureInfo.InvariantCulture),
                $"Session {grant.SessionId}",
                $"Waiting for grant; requested {grant.RequestedKb ?? "unknown"} KB, granted {(grant.GrantedKb ?? "none")}.")).ToArray(),
            ["Waiting is defined by grant_time IS NULL; this is a point-in-time sample of the resource-semaphore queue.", RuleEvidence.SampleCaveat],
            ["A transient burst of large-grant queries can queue briefly without a sustained problem.",
             "One oversized grant request can queue others without the server being under memory pressure overall."],
            ["Check the live tab for the requested vs granted sizes of the waiting sessions.",
             "Correlate with Resource Semaphore waits and overall server memory."],
            "Read-only recommendation: investigate the large-grant queries and workload concurrency; SQLSimCity never changes the server.",
            RuleEvidence.FromLive(live));

        return RuleResult.Firing($"{waiting.Length} session(s) waiting for a memory grant.", [finding]);
    }
}
