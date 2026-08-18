using SqlSimCity.Collection.Guidance;

namespace SqlSimCity.Collection.Tests.Guidance;

public class EngineVersionTests
{
    [Theory]
    [InlineData("15.0.4390.2", 15)]
    [InlineData("16.0.1000.6", 16)]
    [InlineData("17.0.100.1", 17)]
    [InlineData("12.0.0.0", 12)]
    public void TryParseMajorVersionParsesFirstDottedSegment(string productVersion, int expectedMajor)
    {
        Assert.Equal(expectedMajor, EngineVersion.TryParseMajorVersion(productVersion));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-version")]
    public void TryParseMajorVersionUnparsableInputReturnsNull(string? productVersion)
    {
        Assert.Null(EngineVersion.TryParseMajorVersion(productVersion));
    }
}
