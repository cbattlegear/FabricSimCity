using Microsoft.Extensions.Configuration;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers the deployment security notice acknowledgement. The setting governs one
/// thing only -- whether the browser draws the "no login of its own" banner -- and
/// it must default to showing the notice, so that forgetting to configure it, or
/// mistyping it, can never quietly hide a security fact.
/// </summary>
public sealed class DeploymentNoticeTests
{
    private static IConfiguration Configure(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void NothingConfiguredShowsTheNotice()
    {
        Assert.False(DeploymentNotice.IsAcknowledged(Configure([])));
    }

    [Fact]
    public void SectionScopedKeyAcknowledges()
    {
        Assert.True(DeploymentNotice.IsAcknowledged(
            Configure(new() { [DeploymentNotice.ConfigurationKey] = "true" })));
    }

    [Fact]
    public void UnprefixedEnvironmentVariableAcknowledges()
    {
        Assert.True(DeploymentNotice.IsAcknowledged(
            Configure(new() { [DeploymentNotice.EnvironmentVariableName] = "true" })));
    }

    [Theory]
    [InlineData("true")]
    [InlineData("True")]
    [InlineData("TRUE")]
    [InlineData(" true ")]
    [InlineData("1")]
    [InlineData("yes")]
    [InlineData("on")]
    public void AffirmativeSpellingsAcknowledge(string value)
    {
        Assert.True(DeploymentNotice.IsAcknowledged(
            Configure(new() { [DeploymentNotice.ConfigurationKey] = value })));
    }

    [Theory]
    [InlineData("false")]
    [InlineData("False")]
    [InlineData("0")]
    [InlineData("no")]
    [InlineData("off")]
    public void NegativeSpellingsKeepTheNotice(string value)
    {
        Assert.False(DeploymentNotice.IsAcknowledged(
            Configure(new() { [DeploymentNotice.ConfigurationKey] = value })));
    }

    [Fact]
    public void BlankValueIsTreatedAsUnsetRatherThanAsAnAcknowledgement()
    {
        Assert.False(DeploymentNotice.IsAcknowledged(
            Configure(new() { [DeploymentNotice.ConfigurationKey] = "   " })));
    }

    [Theory]
    [InlineData("maybe")]
    [InlineData("acknowledged")]
    [InlineData("2")]
    public void UnparseableValueStopsStartupInsteadOfBeingGuessedAt(string value)
    {
        var exception = Assert.Throws<InvalidOperationException>(() =>
            DeploymentNotice.IsAcknowledged(
                Configure(new() { [DeploymentNotice.ConfigurationKey] = value })));
        Assert.Contains(DeploymentNotice.ConfigurationKey, exception.Message, StringComparison.Ordinal);
        Assert.Contains(value, exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SectionScopedKeyWinsOverTheUnprefixedVariable()
    {
        Assert.False(DeploymentNotice.IsAcknowledged(Configure(new()
        {
            [DeploymentNotice.ConfigurationKey] = "false",
            [DeploymentNotice.EnvironmentVariableName] = "true",
        })));
    }
}
