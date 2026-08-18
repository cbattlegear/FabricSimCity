using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace SqlSimCity.Api.Tests;

public sealed class AcquisitionModeTests
{
    [Fact]
    public void ArchiveModeRejectsEdgeIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Archive");
                builder.UseSetting("EdgeIngestion:Enabled", "true");
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("edge ingestion", exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FixtureModeRejectsEdgeIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder => builder.UseSetting("EdgeIngestion:Enabled", "true"));

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("only when Acquisition:Mode=Edge", exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void EdgeModeRequiresIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Edge");
                builder.UseSetting("Acquisition:Edge:TargetId", "target-1");
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("requires edge ingestion", exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("Atlas:Mode", "Connected", "connected Atlas")]
    [InlineData("QueryStoreHistory:Mode", "Connected", "Query Store")]
    [InlineData("LiveIncidents:Mode", "Connected", "live incidents")]
    [InlineData("ProtectedStorage:Enabled", "true", "protected storage")]
    public void EdgeModeRejectsLocalOrProtectedSources(
        string key,
        string value,
        string expected)
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Edge");
                builder.UseSetting("Acquisition:Edge:TargetId", "target-1");
                builder.UseSetting("EdgeIngestion:Enabled", "true");
                builder.UseSetting(key, value);
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains(expected, exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }
}
