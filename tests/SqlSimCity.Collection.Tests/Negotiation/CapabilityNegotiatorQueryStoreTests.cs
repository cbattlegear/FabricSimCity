using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Negotiation;

/// <summary>
/// Covers every case in <c>fixtures/v1/database-query-store.json</c> through the real negotiator:
/// on (READ_WRITE), OFF, READ_ONLY (with a decoded quota reason), ERROR, permission-denied, and
/// unsupported-on-target. Uses <c>sqlserver-2022-onprem</c> as the driving target since its
/// compatibility level (160) is unrelated to any of these Query Store outcomes.
/// </summary>
public class CapabilityNegotiatorQueryStoreTests
{
    private static CapabilityNegotiator BuildNegotiator() => new(new FixtureProbeExecutor("sqlserver-2022-onprem"));

    [Fact]
    public async Task HealthyReadWriteReportsOnAndSupportedAvailability()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-sales"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-sales"];
        Assert.Equal(QueryStoreOperationalState.On, qs.OperationalState);
        Assert.Equal(CapabilityState.Supported, qs.Availability);
        Assert.Null(qs.ReadOnlyReason);
    }

    [Fact]
    public async Task OffReportsOffStateNotUnsupported()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-ledger"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-ledger"];
        Assert.Equal(QueryStoreOperationalState.Off, qs.OperationalState);
        // Query Store being turned OFF by policy is a distinct fact from the engine not supporting
        // it at all -- both must be independently visible, never conflated.
        Assert.Equal(CapabilityState.Supported, qs.Availability);
    }

    [Fact]
    public async Task ReadOnlyDecodesQuotaReasonBitIntoHumanReadableSentence()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-warehouse"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-warehouse"];
        Assert.Equal(QueryStoreOperationalState.ReadOnly, qs.OperationalState);
        Assert.NotNull(qs.ReadOnlyReason);
        Assert.Contains("max_storage_size_mb", qs.ReadOnlyReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ErrorReportsErrorOperationalState()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-telemetry"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-telemetry"];
        Assert.Equal(QueryStoreOperationalState.Error, qs.OperationalState);
    }

    [Fact]
    public async Task PermissionDeniedReportsPermissionDeniedAvailabilityOperationalStateUnknown()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-archive"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-archive"];
        Assert.Equal(CapabilityState.PermissionDenied, qs.Availability);
        Assert.Equal(QueryStoreOperationalState.Unknown, qs.OperationalState);
    }

    [Fact]
    public async Task UnsupportedOnTargetReportsUnsupportedAvailability()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:atlas-crm"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:atlas-crm"];
        Assert.Equal(CapabilityState.Unsupported, qs.Availability);
    }

    [Fact]
    public async Task UnknownDatabaseNameReportsNotProbedNeverFalseOrZero()
    {
        var negotiator = BuildNegotiator();
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db:does-not-exist"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["db:does-not-exist"];
        Assert.Equal(QueryStoreOperationalState.Unknown, qs.OperationalState);
        Assert.Null(qs.CurrentStorageBytes);
        Assert.Null(qs.MaxStorageBytes);
        Assert.Equal(CapabilityState.Unavailable, qs.Availability);
    }

    [Fact]
    public async Task StorageBytesSerializeLosslesslyAboveJavaScriptSafeInteger()
    {
        var profile = await BuildNegotiator().NegotiateAsync(
            new CapabilityNegotiationRequest("t", "db:atlas-sales"), CancellationToken.None);

        Assert.Equal("9007199255789568", profile.QueryStoreByDatabase["db:atlas-sales"].MaxStorageBytes);
    }

    [Fact]
    public async Task MegabyteConversionOverflowIsUnavailableRatherThanWrapped()
    {
        var executor = new FakeProbeExecutor
        {
            QueryStoreOptions = (_, _) => Task.FromResult<QueryStoreOptionsRow?>(
                new QueryStoreOptionsRow("READ_WRITE", "READ_WRITE", 0, long.MaxValue, 1, "AUTO")),
        };

        var profile = await new CapabilityNegotiator(executor).NegotiateAsync(
            new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);
        var state = profile.QueryStoreByDatabase["fixture_db"];

        Assert.Equal(CapabilityState.Unavailable, state.Availability);
        Assert.Null(state.CurrentStorageBytes);
        Assert.Contains("overflow", state.Evidence.Reason, StringComparison.OrdinalIgnoreCase);
    }
}
