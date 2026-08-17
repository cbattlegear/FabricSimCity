using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Negotiation;

/// <summary>
/// Drives <see cref="CapabilityNegotiator"/> from the real, embedded
/// <c>fixtures/v1/target-capabilities.json</c> via <see cref="FixtureProbeExecutor"/>, covering the
/// platform/compatibility-level matrix requirement 4 and 9 ask for: 2019, 2022, 2025, Azure SQL
/// Database, and Azure SQL Managed Instance, including PSP's &gt;=160 gate, OPPO's &gt;=170 gate
/// plus its documented Managed Instance exclusion, and Azure SQL Database's database-scoped
/// visibility. Every fixture database name below ("db:atlas-sales") comes from the same shared
/// <c>fixtures/v1/database-query-store.json</c> the fixture executor also serves for Query Store
/// state-machine coverage.
/// </summary>
public class CapabilityNegotiatorFixtureMatrixTests
{
    private const string HealthyDatabase = "db:atlas-sales";

    private static CapabilityNegotiator BuildNegotiator(string targetId) =>
        new(new FixtureProbeExecutor(targetId));

    [Theory]
    [InlineData("sqlserver-2019-onprem", EnginePlatform.SqlServerOnPremises)]
    [InlineData("sqlserver-2022-onprem", EnginePlatform.SqlServerOnPremises)]
    [InlineData("sqlserver-2025-onprem", EnginePlatform.SqlServerOnPremises)]
    [InlineData("azure-sql-database", EnginePlatform.AzureSqlDatabase)]
    [InlineData("azure-sql-managed-instance", EnginePlatform.AzureSqlManagedInstance)]
    public async Task PlatformIsIdentifiedFromEngineEditionNotFromReleaseStringAlone(string targetId, EnginePlatform expectedPlatform)
    {
        var negotiator = BuildNegotiator(targetId);
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest(targetId, HealthyDatabase), CancellationToken.None);

        Assert.Equal(expectedPlatform, profile.Platform.Platform);
        Assert.Equal(CapabilityState.Supported, profile.Platform.Evidence.State);
    }

    [Theory]
    [InlineData("sqlserver-2019-onprem", CapabilityState.Unsupported)] // compat 150 < 160
    [InlineData("sqlserver-2022-onprem", CapabilityState.Supported)]   // compat 160, exactly at the PSP floor
    [InlineData("sqlserver-2025-onprem", CapabilityState.Supported)]
    [InlineData("azure-sql-database", CapabilityState.Supported)]
    [InlineData("azure-sql-managed-instance", CapabilityState.Supported)]
    public async Task ParameterSensitivePlanGatedOnCompatibilityLevel160NotMajorVersionAlone(string targetId, CapabilityState expected)
    {
        var negotiator = BuildNegotiator(targetId);
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest(targetId, HealthyDatabase), CancellationToken.None);

        Assert.Equal(expected, profile.ParameterSensitivePlan.State);
    }

    [Theory]
    [InlineData("sqlserver-2019-onprem", CapabilityState.Unsupported)] // compat 150 < 170
    [InlineData("sqlserver-2022-onprem", CapabilityState.Unsupported)] // compat 160 < 170
    [InlineData("sqlserver-2025-onprem", CapabilityState.Supported)]
    [InlineData("azure-sql-database", CapabilityState.Supported)]
    public async Task OptionalParameterPlanOptimizationGatedOnCompatibilityLevel170(string targetId, CapabilityState expected)
    {
        var negotiator = BuildNegotiator(targetId);
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest(targetId, HealthyDatabase), CancellationToken.None);

        Assert.Equal(expected, profile.OptionalParameterPlanOptimization.State);
    }

    [Fact]
    public async Task OptionalParameterPlanOptimizationManagedInstanceOverridesFixtureSupportedToUnsupported()
    {
        // fixtures/v1/target-capabilities.json records optionalParameterPlanOptimization as
        // "supported" for azure-sql-managed-instance, even though its compatibility level (170)
        // qualifies. The negotiator disagrees deliberately: OPPO's documented "Applies to" list
        // does not include Azure SQL Managed Instance, so this is a case where the fixture is a
        // realistic *probe input*, not a pre-approved expected output, and the negotiator's own
        // doc-verified platform policy is authoritative over it.
        var negotiator = BuildNegotiator("azure-sql-managed-instance");
        var profile = await negotiator.NegotiateAsync(
            new CapabilityNegotiationRequest("azure-sql-managed-instance", HealthyDatabase), CancellationToken.None);

        Assert.Equal(CapabilityState.Unsupported, profile.OptionalParameterPlanOptimization.State);
        Assert.Contains("Managed Instance", profile.OptionalParameterPlanOptimization.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("sqlserver-2019-onprem", CapabilityState.Unsupported)] // compat 150: no plan_type_desc/replica_group_id metadata
    [InlineData("sqlserver-2022-onprem", CapabilityState.Preview)]     // compat 160: metadata present, but never auto-promoted past Preview
    [InlineData("sqlserver-2025-onprem", CapabilityState.Preview)]
    public async Task ReadableSecondaryQueryStoreNeverExceedsPreviewEvenWhenMetadataConfirmed(string targetId, CapabilityState expected)
    {
        var negotiator = BuildNegotiator(targetId);
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest(targetId, HealthyDatabase), CancellationToken.None);

        Assert.Equal(expected, profile.ReadableSecondaryQueryStore.State);
        Assert.NotEqual(CapabilityState.Supported, profile.ReadableSecondaryQueryStore.State);
    }

    [Fact]
    public async Task AzureSqlDatabaseServerVisibilityIsDatabaseScopedNotServerWide()
    {
        var negotiator = BuildNegotiator("azure-sql-database");
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("azure-sql-database", HealthyDatabase), CancellationToken.None);

        Assert.Equal(VisibilityScope.DatabaseScoped, profile.ServerVisibility.Scope);
    }

    [Theory]
    [InlineData("sqlserver-2019-onprem")]
    [InlineData("sqlserver-2022-onprem")]
    [InlineData("azure-sql-managed-instance")]
    public async Task NonAzureSqlDatabaseTargetsServerVisibilityIsServerScoped(string targetId)
    {
        var negotiator = BuildNegotiator(targetId);
        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest(targetId, HealthyDatabase), CancellationToken.None);

        Assert.Equal(VisibilityScope.Server, profile.ServerVisibility.Scope);
    }

    [Fact]
    public async Task AzureSqlManagedInstanceLiveRequestsPermissionDeniedReflectedInWaitsAndLiveSessions()
    {
        // The fixture models azure-sql-managed-instance's liveRequests capability as
        // permission-denied; both the waits and live-session-enumeration features share that one
        // signal in this negotiation layer (documented simplification), so both must reflect it.
        var negotiator = BuildNegotiator("azure-sql-managed-instance");
        var profile = await negotiator.NegotiateAsync(
            new CapabilityNegotiationRequest("azure-sql-managed-instance", HealthyDatabase), CancellationToken.None);

        Assert.Equal(CapabilityState.PermissionDenied, profile.Waits.State);
        Assert.Equal(CapabilityState.PermissionDenied, profile.LiveSessions.State);
    }

    [Fact]
    public async Task AzureResourceMetricsOnlyPopulatedForAzureSqlDatabase()
    {
        var azureNegotiator = BuildNegotiator("azure-sql-database");
        var azureProfile = await azureNegotiator.NegotiateAsync(
            new CapabilityNegotiationRequest("azure-sql-database", HealthyDatabase), CancellationToken.None);
        Assert.NotNull(azureProfile.AzureResourceMetrics.CpuLimitCores);

        var onPremNegotiator = BuildNegotiator("sqlserver-2022-onprem");
        var onPremProfile = await onPremNegotiator.NegotiateAsync(
            new CapabilityNegotiationRequest("sqlserver-2022-onprem", HealthyDatabase), CancellationToken.None);
        Assert.Null(onPremProfile.AzureResourceMetrics.CpuLimitCores);
        Assert.Equal(CapabilityState.NotProbed, onPremProfile.AzureResourceMetrics.Evidence.State);
    }

    [Fact]
    public void UnknownFixtureTargetIdThrows()
    {
        Assert.Throws<ArgumentException>(() => new FixtureProbeExecutor("no-such-target"));
    }
}
