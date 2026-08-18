using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Tests;

public sealed class FindingsQueryTests
{
    private static FindingV1 Make(string ruleId, FindingSeverity severity, FindingConfidence confidence, decimal impact, string? db = null)
    {
        var scope = new FindingScopeV1("t", db, ruleId, null, "name");
        return new FindingV1("1.0", FindingFactory.Fingerprint(ruleId, "1", scope), ruleId, "1", ruleId, scope,
            new ObservedWindowV1(null, null, "k", "c"), FindingStatus.Firing, severity,
            new MeasuredImpactV1(FindingImpactDimension.CpuMicroseconds, impact.ToString(System.Globalization.CultureInfo.InvariantCulture), "us", "b"),
            confidence, [], [], [], [], "r", new FindingSourceFreshnessV1(EvidenceSource.QueryStoreAggregate, DataStatus.Available, null, null, "r"));
    }

    private static IReadOnlyList<FindingV1> Sample() =>
    [
        Make("a", FindingSeverity.Serious, FindingConfidence.High, 100, "db1"),
        Make("b", FindingSeverity.Notable, FindingConfidence.High, 5000, "db2"),
        Make("c", FindingSeverity.Advisory, FindingConfidence.Medium, 9000, "db1"),
        Make("d", FindingSeverity.Informational, FindingConfidence.Low, 1, "db2"),
    ];

    [Fact]
    public void Default_sort_is_severity_major()
    {
        var page = FindingsQuery.Page(Sample(), FindingsTestData.Now);
        Assert.Equal(["a", "b", "c", "d"], page.Items.Select(f => f.RuleId));
        Assert.Equal(4, page.TotalCount);
    }

    [Fact]
    public void Impact_sort_orders_by_magnitude()
    {
        var page = FindingsQuery.Page(Sample(), FindingsTestData.Now, sort: FindingsSort.Impact);
        Assert.Equal(["c", "b", "a", "d"], page.Items.Select(f => f.RuleId));
    }

    [Fact]
    public void Filters_by_severity_confidence_rule_and_database()
    {
        var bySeverity = FindingsQuery.Page(Sample(), FindingsTestData.Now, severities: [FindingSeverity.Serious, FindingSeverity.Notable]);
        Assert.Equal(2, bySeverity.TotalCount);

        var byDatabase = FindingsQuery.Page(Sample(), FindingsTestData.Now, databaseId: "db1");
        Assert.Equal(2, byDatabase.TotalCount);
        Assert.All(byDatabase.Items, f => Assert.Equal("db1", f.Scope.DatabaseId));

        var byRule = FindingsQuery.Page(Sample(), FindingsTestData.Now, ruleId: "b");
        Assert.Equal("b", Assert.Single(byRule.Items).RuleId);
    }

    [Fact]
    public void Pages_with_a_round_trippable_token()
    {
        var first = FindingsQuery.Page(Sample(), FindingsTestData.Now, pageSize: 2);
        Assert.Equal(2, first.Items.Count);
        Assert.NotNull(first.NextPageToken);
        var second = FindingsQuery.Page(Sample(), FindingsTestData.Now, pageSize: 2, pageToken: first.NextPageToken);
        Assert.Equal(2, second.Items.Count);
        Assert.Null(second.NextPageToken);
        Assert.Empty(first.Items.Select(f => f.RuleId).Intersect(second.Items.Select(f => f.RuleId)));
    }

    [Fact]
    public void Clamps_page_size()
    {
        var big = FindingsQuery.Page(Sample(), FindingsTestData.Now, pageSize: 100_000);
        Assert.Equal(FindingsQuery.MaxPageSize, big.PageSize);
        var small = FindingsQuery.Page(Sample(), FindingsTestData.Now, pageSize: -5);
        Assert.Equal(1, small.PageSize);
    }

    [Theory]
    [InlineData("not-base64!!")]
    [InlineData("////////////////////////////////////////////////////////////////////////////////////////")]
    public void Rejects_malformed_or_oversized_tokens(string token)
    {
        Assert.Throws<FindingsPageTokenException>(() => FindingsQuery.Page(Sample(), FindingsTestData.Now, pageToken: token));
    }

    [Fact]
    public void Rejects_out_of_range_offset_token()
    {
        var token = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("999"));
        Assert.Throws<FindingsPageTokenException>(() => FindingsQuery.Page(Sample(), FindingsTestData.Now, pageToken: token));
    }

    [Fact]
    public void Rejects_oversized_filter_values()
    {
        Assert.Throws<FindingsPageTokenException>(() =>
            FindingsQuery.Page(Sample(), FindingsTestData.Now, ruleId: new string('x', FindingsQuery.MaxFilterValueLength + 1)));
    }
}
