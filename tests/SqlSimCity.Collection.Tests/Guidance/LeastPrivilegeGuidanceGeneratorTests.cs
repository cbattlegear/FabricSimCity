using SqlSimCity.Collection.Guidance;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Guidance;

public class LeastPrivilegeGuidanceGeneratorTests
{
    private static readonly DateTimeOffset Now = new(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static CapabilityEvidenceV1 Evidence(CapabilityState state) => new(state, "test evidence", Now, null, null);

    private static TargetCapabilityProfileV1 BuildProfile(EnginePlatform platform, string? productVersion) => new(
        SchemaVersion: "1",
        TargetId: "test-target",
        Platform: new EnginePlatformV1(platform, productVersion, "Enterprise Edition", platform == EnginePlatform.AzureSqlDatabase ? 5 : 2, Evidence(CapabilityState.Supported)),
        Databases: [],
        DatabaseDiscovery: new FeatureCapabilityV1(CapabilityState.Supported, "n/a", Evidence(CapabilityState.Supported)),
        ServerVisibility: new VisibilityV1(VisibilityScope.Server, "n/a", Evidence(CapabilityState.Supported)),
        Waits: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        LiveSessions: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        PlansAndText: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        ParameterSensitivePlan: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        OptionalParameterPlanOptimization: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        ReadableSecondaryQueryStore: new FeatureCapabilityV1(CapabilityState.NotProbed, "n/a", Evidence(CapabilityState.NotProbed)),
        QueryStoreByDatabase: new Dictionary<string, QueryStoreStateV1>(),
        AzureResourceMetrics: new AzureResourceMetricsV1(null, null, Evidence(CapabilityState.NotProbed)),
        SourceTimestamp: Now);

    [Fact]
    public void AzureSqlDatabaseRecommendsViewDatabaseStateNeverServerScopedGrant()
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.AzureSqlDatabase, "12.0.2000.8"), "app_reader");

        Assert.Contains("GRANT VIEW DATABASE STATE TO [app_reader];", script, StringComparison.Ordinal);
        Assert.DoesNotContain("VIEW SERVER STATE", script, StringComparison.Ordinal);
        Assert.DoesNotContain("PERFORMANCE STATE", script, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("15.0.4390.2")] // SQL Server 2019
    public void SqlServerOnPremisesLegacyMajorVersionRecommendsLegacyStatePermissions(string productVersion)
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.SqlServerOnPremises, productVersion), "app_reader");

        Assert.Contains("GRANT VIEW SERVER STATE TO [app_reader];", script, StringComparison.Ordinal);
        Assert.Contains("GRANT VIEW DATABASE STATE TO [app_reader];", script, StringComparison.Ordinal);
        Assert.DoesNotContain("PERFORMANCE STATE", script, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("16.0.1000.6")] // SQL Server 2022
    [InlineData("17.0.100.1")] // SQL Server 2025
    public void SqlServerOnPremisesModernMajorVersionRecommendsPerformanceStatePermissions(string productVersion)
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.SqlServerOnPremises, productVersion), "app_reader");

        Assert.Contains("GRANT VIEW SERVER PERFORMANCE STATE TO [app_reader];", script, StringComparison.Ordinal);
        Assert.Contains("GRANT VIEW DATABASE PERFORMANCE STATE TO [app_reader];", script, StringComparison.Ordinal);
        Assert.DoesNotContain("GRANT VIEW SERVER STATE TO", script, StringComparison.Ordinal);
    }

    [Fact]
    public void UnsupportedPlatformRecommendsNoGrantsAtAll()
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.Unsupported, null), "app_reader");

        // The fixed disclaimer comment legitimately contains the word "GRANT"; what must never
        // appear is an actual GRANT statement recommending a permission.
        Assert.DoesNotContain("GRANT VIEW", script, StringComparison.Ordinal);
        Assert.DoesNotContain("GRANT CONTROL", script, StringComparison.Ordinal);
        Assert.Contains("no grant is recommended", script, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GeneratedScriptNeverIncludesSecretsOrExecutionInstructions()
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.SqlServerOnPremises, "16.0.1000.6"), "app_reader");

        Assert.DoesNotContain("password", script, StringComparison.OrdinalIgnoreCase);
        // No actual EXEC/EXECUTE invocation, only the fixed disclaimer prose that contains the
        // word "executes" as part of a sentence, never as a runnable statement.
        Assert.DoesNotContain("EXEC ", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("EXECUTE ", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("never execute", script, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PrincipalNameIsAlwaysQuotedEvenWhenItContainsBrackets()
    {
        var script = LeastPrivilegeGuidanceGenerator.GenerateGrantScript(
            BuildProfile(EnginePlatform.AzureSqlDatabase, "12.0.2000.8"), "weird]principal");

        Assert.Contains("[weird]]principal]", script, StringComparison.Ordinal);
    }

    [Fact]
    public void NullProfileThrows()
    {
        Assert.Throws<ArgumentNullException>(() => LeastPrivilegeGuidanceGenerator.GenerateGrantScript(null!, "app_reader"));
    }

    [Fact]
    public void EmptyPrincipalNameThrows()
    {
        Assert.Throws<ArgumentException>(() => LeastPrivilegeGuidanceGenerator.GenerateGrantScript(BuildProfile(EnginePlatform.SqlServerOnPremises, "16.0.0.0"), " "));
    }
}
