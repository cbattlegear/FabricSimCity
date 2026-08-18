using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>Reports transaction-log space pressure for the current database from the live sample.</summary>
public sealed class LogSpacePressureRule : IFindingRule
{
    private const decimal SeriousPercent = 95m;
    private const decimal NotablePercent = 85m;

    public string RuleId => "log-space-pressure";
    public string RuleVersion => "1";
    public string Title => "Transaction log space pressure";
    public string Description =>
        "The current database's transaction log is highly utilized at sample time, risking a full-log condition that stops writes.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Live is not { } live)
            return RuleResult.NotEvaluated("No live incident snapshot was available.");
        var log = live.LogSpace;
        if (log.Status != DataStatus.Available || log.UsedLogSpacePercent is not { } percent)
            return RuleResult.NotEvaluated("Log-space utilization was not available in the live sample.");
        if (percent < NotablePercent)
            return RuleResult.NotEvaluated("Log-space utilization was below the pressure threshold.");

        var scope = new FindingScopeV1(bundle.TargetId, null, null, null, "Transaction log")
        { ResourceId = "log-space" };
        var finding = FindingFactory.Create(
            this,
            scope,
            $"Transaction log is {FindingImpact.Format(Math.Round(percent, 1))}% used",
            RuleEvidence.LiveWindow(live),
            percent >= SeriousPercent ? FindingSeverity.Serious : FindingSeverity.Notable,
            new MeasuredImpactV1(FindingImpactDimension.LogSpacePercent, FindingImpact.Format(Math.Round(percent, 2)), "percent",
                $"Used {log.UsedLogSpaceMb?.ToString(CultureInfo.InvariantCulture) ?? "?"} MB of {log.TotalLogSizeMb?.ToString(CultureInfo.InvariantCulture) ?? "?"} MB log."),
            RuleEvidence.Downgrade(FindingConfidence.High, live.Status),
            [new FindingEvidenceRefV1(FindingEvidenceKind.LiveLogSpace, "log-space", "Transaction log",
                $"{FindingImpact.Format(Math.Round(percent, 2))}% used at sample time.")],
            ["Log-space percent is an instantaneous gauge; it can move quickly with the next log backup or checkpoint.", RuleEvidence.SampleCaveat],
            ["A long-running transaction or a pending log backup can inflate usage transiently.",
             "Replication/CDC latency or an availability-group secondary can hold log truncation."],
            ["Check for the oldest active transaction and log_reuse_wait.",
             "Confirm the log-backup schedule is running for this database."],
            "Read-only recommendation: investigate what is holding log truncation; SQLSimCity never changes the server or runs backups.",
            RuleEvidence.FromLive(live));

        return RuleResult.Firing($"Transaction log is {FindingImpact.Format(Math.Round(percent, 1))}% used.", [finding]);
    }
}

/// <summary>
/// Reports a database file whose I/O stall is accumulating faster than wall-clock time between two
/// same-epoch samples, indicating current I/O queuing. Only a valid <see cref="CounterEpochState.Delta"/>
/// counts; a first sample or an epoch reset never fabricates a rate.
/// </summary>
public sealed class FileIoPressureRule : IFindingRule
{
    private const decimal StallMsPerSecondThreshold = 1000m;

    public string RuleId => "file-io-pressure";
    public string RuleVersion => "1";
    public string Title => "Database file I/O stall pressure";
    public string Description =>
        "A database file's read or write I/O stall is accumulating faster than one millisecond per millisecond between two comparable samples, indicating I/O queuing.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Live is not { } live)
            return RuleResult.NotEvaluated("No live incident snapshot was available.");
        if (live.FileIo.Status != DataStatus.Available || live.FileIo.Files.Count == 0)
            return RuleResult.NotEvaluated("No file I/O deltas were available in the live sample.");

        var findings = new List<FindingV1>();
        var anyDelta = false;

        foreach (var file in live.FileIo.Files)
        {
            var readRate = RateOf(file.IoStallReadMsDelta);
            var writeRate = RateOf(file.IoStallWriteMsDelta);
            if (readRate is not null || writeRate is not null)
                anyDelta = true;
            var worst = Math.Max(readRate ?? 0m, writeRate ?? 0m);
            if (worst < StallMsPerSecondThreshold)
                continue;

            var resourceId = $"file-io/{file.DatabaseId}/{file.FileId}";
            var scope = new FindingScopeV1(bundle.TargetId, file.DatabaseId.ToString(CultureInfo.InvariantCulture), null, null,
                $"{file.DatabaseName ?? $"db {file.DatabaseId}"} file {file.FileId}")
            { ResourceId = resourceId };
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"File {file.FileId} of {file.DatabaseName ?? $"db {file.DatabaseId}"} is I/O stalling",
                RuleEvidence.LiveWindow(live),
                FindingSeverity.Notable,
                new MeasuredImpactV1(FindingImpactDimension.IoStallMilliseconds, FindingImpact.Format(Math.Round(worst, 1)), "stall ms per second",
                    $"Read stall rate {Fmt(readRate)} ms/s, write stall rate {Fmt(writeRate)} ms/s over a {file.SampleWindowMs?.ToString(CultureInfo.InvariantCulture) ?? "?"} ms window."),
                RuleEvidence.Downgrade(FindingConfidence.Medium, live.Status),
                [new FindingEvidenceRefV1(FindingEvidenceKind.LiveFileIo, resourceId, $"{file.TypeDesc ?? "file"} {file.FileId}",
                    $"I/O stall accumulating at {FindingImpact.Format(Math.Round(worst, 1))} ms/s between two same-epoch samples.")],
                ["The rate is a delta across two samples of the same epoch; a first sample or engine restart never produces a rate.", RuleEvidence.SampleCaveat],
                ["A one-off backup, checkpoint, or index rebuild can spike file I/O briefly.",
                 "Shared storage contention from outside this server can raise stall without a query-side cause."],
                ["Correlate with PAGEIOLATCH waits and current heavy queries.",
                 "Check the underlying storage latency independently."],
                "Read-only recommendation: investigate storage latency and the queries driving I/O; SQLSimCity never changes the server.",
                RuleEvidence.FromLive(live)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} file(s) show I/O stall pressure.", findings);
        return anyDelta
            ? RuleResult.NotEvaluated("File I/O deltas were available but none exceeded the stall-rate threshold.")
            : RuleResult.NotEvaluated("No file had a valid two-sample I/O delta yet (first sample or epoch reset).");
    }

    private static decimal? RateOf(CounterDeltaV1 delta) =>
        delta.State == CounterEpochState.Delta ? delta.RatePerSecond : null;

    private static string Fmt(decimal? value) => value is { } v ? FindingImpact.Format(Math.Round(v, 1)) : "n/a";
}
