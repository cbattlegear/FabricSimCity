using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class SqlTextNormalizerTests
{
    [Fact]
    public void ReplacesEveryLiteralAndDropsComments()
    {
        const string secret = "private-customer";
        var result = SqlTextNormalizer.Normalize(
            $"SELECT * FROM dbo.T WHERE name = N'{secret}' AND id = 42 AND token = 0xDEADBEEF -- {secret}",
            false, false);

        Assert.Equal(QueryTextAvailability.Available, result.Availability);
        Assert.DoesNotContain(secret, result.NormalizedText, StringComparison.Ordinal);
        Assert.DoesNotContain("DEADBEEF", result.NormalizedText, StringComparison.Ordinal);
        Assert.Contains("N'?'", result.NormalizedText, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("SELECT 'unterminated", false, false, QueryTextAvailability.Missing)]
    [InlineData("SELECT 1", true, false, QueryTextAvailability.Encrypted)]
    [InlineData("SELECT 1", false, true, QueryTextAvailability.Restricted)]
    public void FailsClosed(
        string sql, bool encrypted, bool restricted, QueryTextAvailability expected)
    {
        var result = SqlTextNormalizer.Normalize(sql, encrypted, restricted);
        Assert.Equal(expected, result.Availability);
        Assert.Null(result.NormalizedText);
        Assert.Null(result.NormalizedTextFingerprint);
    }

    [Fact]
    public void RespectsQuotedIdentifierOffAndFailsClosedWithoutContext()
    {
        var normalized = SqlTextNormalizer.Normalize(
            "SELECT \"private literal\"", false, false, initialQuotedIdentifiers: false);
        var unknown = SqlTextNormalizer.Normalize(
            "SELECT \"private literal\"", false, false, initialQuotedIdentifiers: null);

        Assert.Equal(QueryTextAvailability.Available, normalized.Availability);
        Assert.DoesNotContain("private literal", normalized.NormalizedText, StringComparison.Ordinal);
        Assert.Equal(QueryTextAvailability.Missing, unknown.Availability);
    }
}
