namespace SqlSimCity.Api.Tests;

public sealed class RepositoryEdgeContractsTests
{
    private static readonly string Root = FindRoot();

    [Theory]
    [InlineData("Dockerfile")]
    [InlineData("Dockerfile.connector")]
    public void ImagesDeclareApacheLicenseAndCopyLegalNotices(string fileName)
    {
        var dockerfile = File.ReadAllText(Path.Combine(Root, fileName));

        Assert.Contains("org.opencontainers.image.licenses=\"Apache-2.0\"", dockerfile, StringComparison.Ordinal);
        Assert.Contains("LICENSE NOTICE /app/legal/", dockerfile, StringComparison.Ordinal);
        Assert.DoesNotContain("image.licenses=\"MIT\"", dockerfile, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalEdgeComposeUsesExplicitSharedLoopbackTransport()
    {
        var compose = File.ReadAllText(Path.Combine(Root, "compose.edge.yaml"));

        Assert.Contains("Acquisition__Mode: Edge", compose, StringComparison.Ordinal);
        Assert.Contains("Acquisition__Edge__TargetId: sql-prod-east", compose, StringComparison.Ordinal);
        Assert.Contains("network_mode: \"service:sqlsimcity-central\"", compose, StringComparison.Ordinal);
        Assert.Contains(
            "SQLSIMCITY_EDGE_INGEST_ENDPOINT: http://127.0.0.1:8080/api/v1/edge/ingest",
            compose,
            StringComparison.Ordinal);
        Assert.Contains("SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP: \"true\"", compose, StringComparison.Ordinal);
        Assert.DoesNotContain("http://sqlsimcity-central:", compose, StringComparison.Ordinal);
        Assert.Contains(
            "secrets/",
            File.ReadAllText(Path.Combine(Root, ".gitignore")),
            StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeImageLabelCheckCoversBothImagesAndLegalFiles()
    {
        var script = File.ReadAllText(Path.Combine(Root, "tools", "verify-image-labels.sh"));

        Assert.Contains("sqlsimcity:local", script, StringComparison.Ordinal);
        Assert.Contains("sqlsimcity-edge:local", script, StringComparison.Ordinal);
        Assert.Contains("org.opencontainers.image.licenses", script, StringComparison.Ordinal);
        Assert.Contains("/app/legal/LICENSE", script, StringComparison.Ordinal);
        Assert.Contains("/app/legal/NOTICE", script, StringComparison.Ordinal);
    }

    [Fact]
    public void ConnectedConnectorDisablesRawSqlAndShipsFailClosedSmokes()
    {
        var provider = File.ReadAllText(Path.Combine(
            Root, "src", "SqlSimCity.Edge.Connector", "ConnectedObservationProvider.cs"));
        var activeRequests = File.ReadAllText(Path.Combine(
            Root, "sql", "probes", "sessions", "active_requests.sql"));
        var memoryGrants = File.ReadAllText(Path.Combine(
            Root, "sql", "probes", "sessions", "memory_grants.sql"));
        var smoke = File.ReadAllText(Path.Combine(
            Root, "tools", "connector-connected-smoke.sh"));

        Assert.Contains("includeSqlText: false", provider, StringComparison.Ordinal);
        Assert.DoesNotContain(".ReadQueryTextAsync(", provider, StringComparison.Ordinal);
        Assert.DoesNotContain(".ReadPlanXmlAsync(", provider, StringComparison.Ordinal);
        Assert.Contains(
            "sys.dm_exec_sql_text(CASE WHEN @IncludeSqlText = 1",
            activeRequests,
            StringComparison.Ordinal);
        Assert.Contains(
            "sys.dm_exec_sql_text(CASE WHEN @IncludeSqlText = 1",
            memoryGrants,
            StringComparison.Ordinal);
        Assert.Contains("missing-config.log", smoke, StringComparison.Ordinal);
        Assert.Contains("missing-auth-secret.log", smoke, StringComparison.Ordinal);
    }

    private static string FindRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Dockerfile")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new DirectoryNotFoundException("Repository root was not found.");
    }
}
