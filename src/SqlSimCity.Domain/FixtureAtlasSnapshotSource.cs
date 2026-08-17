using System.Globalization;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class FixtureAtlasSnapshotSource : IAtlasSnapshotSource
{
    private static readonly DateTimeOffset CapturedAt = new(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);
    private static readonly AtlasSnapshotV1 Snapshot = BuildSnapshot();

    public AtlasSnapshotV1 GetCurrent() => Snapshot;

    private static AtlasSnapshotV1 BuildSnapshot()
    {
        var databases = new[]
        {
            Database("master", "master", Bytes(8L * 1024 * 1024), Bytes(5L * 1024 * 1024),
                Live(0, 0, 0, 0, DataStatus.Available, "Sample completed; no active work."),
                QueryStore(null, null, QueryStoreCapability.Unsupported, QueryStoreHealth.Unavailable,
                    DataStatus.Unsupported, "Query Store history is not available for this system database.")),
            Database("sales", "sales", Bytes(512L * 1024 * 1024 * 1024), Bytes(407L * 1024 * 1024 * 1024),
                Live(42, 13, 2, 184.25m, DataStatus.Available, "Live DMV sample is within its freshness window."),
                QueryStore(821_300, 21_400m, QueryStoreCapability.Available, QueryStoreHealth.Healthy,
                    DataStatus.Available, "Query Store is readable and collecting.")),
            Database("ledger", "ledger", Bytes(256L * 1024 * 1024 * 1024), Bytes(201L * 1024 * 1024 * 1024),
                Live(18, 7, 1, 92m, DataStatus.Stale, "The last DMV sample is older than the freshness window."),
                QueryStore(null, null, QueryStoreCapability.PermissionDenied, QueryStoreHealth.Unavailable,
                    DataStatus.PermissionDenied, "The fixture principal cannot read Query Store views.")),
            Database("warehouse", "warehouse", Bytes(256L * 1024 * 1024 * 1024), Bytes(119L * 1024 * 1024 * 1024),
                Live(11, 4, 0, 37.5m, DataStatus.Available, "Live DMV sample is within its freshness window."),
                QueryStore(315_004, 68_200m, QueryStoreCapability.Available, QueryStoreHealth.Healthy,
                    DataStatus.Available, "Query Store is readable and collecting.")),
            Database("telemetry", "telemetry", Bytes(2L * 1024 * 1024 * 1024 * 1024), Bytes(1_731L * 1024 * 1024 * 1024),
                Live(null, null, null, null, DataStatus.Disconnected, "The fixture target connection is unavailable."),
                QueryStore(1_202_009, 4_800m, QueryStoreCapability.Available, QueryStoreHealth.Stale,
                    DataStatus.Stale, "Historical aggregates predate the current connection outage.")),
            Database("archive", "archive", UnknownBytes("Allocation metadata was not visible to the fixture principal."),
                UnknownBytes("Used bytes cannot be derived without allocation metadata."),
                Live(null, null, null, null, DataStatus.PermissionDenied, "The fixture principal cannot read live activity DMVs."),
                QueryStore(null, null, QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable,
                    DataStatus.Disabled, "Query Store is disabled for this database.")),
            Database("scratch", "scratch", Bytes(0), Bytes(0),
                Live(0, 0, 0, 0, DataStatus.Available, "Sample completed; no active work."),
                QueryStore(null, null, QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable,
                    DataStatus.Disabled, "Query Store is disabled for this database.")),
            Database("crm", "crm", Bytes(64L * 1024 * 1024 * 1024), Bytes(51L * 1024 * 1024 * 1024),
                Live(null, null, null, null, DataStatus.Unknown, "The fixture contains no live sample for this database."),
                QueryStore(76_201, 12_700m, QueryStoreCapability.Available, QueryStoreHealth.ReadOnly,
                    DataStatus.Available, "Query Store is readable but currently in read-only mode.")),
        };

        var edges = new[]
        {
            Edge("sales-crm", "sales", "crm", EdgeConfidence.Confirmed,
                "Fixture dependency evidence names both databases.", DataStatus.Available),
            Edge("warehouse-sales", "warehouse", "sales", EdgeConfidence.Probable,
                "Matching workload labels suggest a cross-database flow; no direct dependency was observed.", DataStatus.Available),
            Edge("archive-ledger", "archive", "ledger", EdgeConfidence.Unknown,
                "An operator hint names a possible relationship, but the fixture has no corroborating evidence.", DataStatus.Unknown),
        };

        return new AtlasSnapshotV1(
            "1.0", "fixture-snapshot-20260817T170000Z",
            new AtlasTargetV1("fixture-target-primary", "Fixture SQL Server", "SQL Server fixture (no connection)"),
            CapturedAt, databases, edges);
    }

    private static DatabaseAtlasItemV1 Database(
        string id,
        string name,
        ByteMeasurementV1 allocated,
        ByteMeasurementV1 used,
        LiveActivityV1 live,
        QueryStoreHistoryV1 queryStore) =>
        new($"fixture-target-primary/database/{id}", name, allocated, used, live, queryStore);

    private static ByteMeasurementV1 Bytes(long value) => new(value.ToString(CultureInfo.InvariantCulture), MeasurementStatus.Known, null,
        new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available, CapturedAt, CapturedAt.AddHours(1),
            "Exact bytes supplied by the deterministic fixture."));

    private static ByteMeasurementV1 UnknownBytes(string reason) => new(null, MeasurementStatus.Unknown, reason,
        new EvidenceV1(EvidenceSource.Fixture, DataStatus.Unknown, CapturedAt, CapturedAt.AddHours(1), reason));

    private static LiveActivityV1 Live(
        int? sessions,
        int? requests,
        int? blocked,
        decimal? batches,
        DataStatus status,
        string reason)
    {
        var observedAt = status is DataStatus.Available ? CapturedAt.AddSeconds(-8) : CapturedAt.AddMinutes(-12);
        var freshUntil = status is DataStatus.Available ? CapturedAt.AddSeconds(22) : CapturedAt.AddMinutes(-10);
        return new LiveActivityV1(sessions, requests, blocked, batches,
            new EvidenceV1(EvidenceSource.LiveDmvSample, status, observedAt, freshUntil, reason));
    }

    private static QueryStoreHistoryV1 QueryStore(
        long? executions,
        decimal? duration,
        QueryStoreCapability capability,
        QueryStoreHealth health,
        DataStatus status,
        string reason) =>
        BuildQueryStore(executions, duration, capability, health, status, reason);

    private static QueryStoreHistoryV1 BuildQueryStore(
        long? executions,
        decimal? duration,
        QueryStoreCapability capability,
        QueryStoreHealth health,
        DataStatus status,
        string reason)
    {
        var observedAt = executions is null
            ? (DateTimeOffset?)null
            : status is DataStatus.Stale ? CapturedAt.AddHours(-2) : CapturedAt;
        var freshUntil = status is DataStatus.Available ? CapturedAt.AddMinutes(15) : CapturedAt.AddMinutes(-1);
        var executionCount = executions?.ToString(CultureInfo.InvariantCulture);
        var logicalReads8KiBPages = executions is null
            ? null
            : checked(executions.Value * 80).ToString(CultureInfo.InvariantCulture);
        return new QueryStoreHistoryV1(executionCount, logicalReads8KiBPages, duration,
            executions is null ? null : CapturedAt.AddHours(-24), observedAt,
            capability, health, reason,
            new EvidenceV1(EvidenceSource.QueryStoreAggregate, status, observedAt, freshUntil, reason));
    }

    private static AtlasEdgeV1 Edge(
        string id,
        string from,
        string to,
        EdgeConfidence confidence,
        string rationale,
        DataStatus status) =>
        new($"fixture-target-primary/edge/{id}", $"fixture-target-primary/database/{from}",
            $"fixture-target-primary/database/{to}", confidence, rationale,
            new EvidenceV1(EvidenceSource.InferredTopology, status, CapturedAt, CapturedAt.AddHours(1), rationale));
}
