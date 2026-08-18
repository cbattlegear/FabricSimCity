using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

public sealed class FixtureAtlasSnapshotSourceTests
{
    private static readonly string[] ExpectedNames =
        ["master", "sales", "ledger", "warehouse", "telemetry", "archive", "scratch", "crm"];

    private readonly AtlasSnapshotV1 _snapshot = new FixtureAtlasSnapshotSource().GetCurrent();

    [Fact]
    public void FixtureContainsExpectedStableDatabasesAndSemanticCases()
    {
        Assert.Equal("1.0", _snapshot.SchemaVersion);
        Assert.Equal(ExpectedNames, _snapshot.Databases.Select(database => database.Name));
        Assert.All(_snapshot.Databases, database =>
            Assert.StartsWith(_snapshot.Target.TargetId + "/database/", database.DatabaseId, StringComparison.Ordinal));

        var ledger = Database("ledger");
        var warehouse = Database("warehouse");
        var archive = Database("archive");
        var scratch = Database("scratch");

        Assert.Equal(ledger.Allocated.Bytes, warehouse.Allocated.Bytes);
        Assert.Equal("0", scratch.Allocated.Bytes);
        Assert.Equal(MeasurementStatus.Known, scratch.Allocated.Status);
        Assert.Null(archive.Allocated.Bytes);
        Assert.Equal(MeasurementStatus.Unknown, archive.Allocated.Status);
    }

    [Fact]
    public void FixtureDistinguishesCollectionFailuresAndEvidenceConfidence()
    {
        Assert.Equal(DataStatus.Stale, Database("ledger").LiveActivity.Evidence.Status);
        Assert.Equal(DataStatus.Disconnected, Database("telemetry").LiveActivity.Evidence.Status);
        Assert.Equal(DataStatus.PermissionDenied, Database("archive").LiveActivity.Evidence.Status);
        Assert.Equal(QueryStoreCapability.Unsupported, Database("master").QueryStore.Capability);
        Assert.Equal(QueryStoreCapability.Disabled, Database("scratch").QueryStore.Capability);
        Assert.Equal(QueryStoreCapability.PermissionDenied, Database("ledger").QueryStore.Capability);

        Assert.True(Database("sales").LiveActivity.Evidence.FreshUntil > _snapshot.GeneratedAt);
        Assert.True(Database("ledger").LiveActivity.Evidence.FreshUntil < _snapshot.GeneratedAt);
        Assert.Null(Database("telemetry").LiveActivity.ActiveSessions);
        Assert.Null(Database("archive").LiveActivity.ActiveSessions);
        Assert.Equal(0, Database("scratch").LiveActivity.ActiveSessions);
        Assert.NotEqual(Database("telemetry").LiveActivity.Evidence.Reason,
            Database("archive").LiveActivity.Evidence.Reason);

        Assert.Contains(_snapshot.Edges, edge => edge.Confidence == EdgeConfidence.Confirmed);
        Assert.Contains(_snapshot.Edges, edge => edge.Confidence == EdgeConfidence.Probable);
        Assert.Contains(_snapshot.Edges, edge => edge.Confidence == EdgeConfidence.Unknown);
        Assert.All(_snapshot.Edges, edge => Assert.False(string.IsNullOrWhiteSpace(edge.Rationale)));
    }

    [Fact]
    public void FixtureIsDeterministic()
    {
        Assert.Same(_snapshot, new FixtureAtlasSnapshotSource().GetCurrent());
    }

    private DatabaseAtlasItemV1 Database(string name) =>
        Assert.Single(_snapshot.Databases, database => database.Name == name);
}
