using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Tests;

public sealed class FindingsRedactorTests
{
    private static FindingV1 Finding(string title, params string[] evidenceObservations)
    {
        var scope = new FindingScopeV1("t", null, null, null, "name");
        var evidence = evidenceObservations
            .Select((o, i) => new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, $"r{i}", "label", o))
            .ToArray();
        return new FindingV1("1.0", FindingFactory.Fingerprint("r", "1", scope), "r", "1", title, scope,
            new ObservedWindowV1(null, null, "k", "c"), FindingStatus.Firing, FindingSeverity.Advisory,
            new MeasuredImpactV1(FindingImpactDimension.None, null, "n/a", "b"), FindingConfidence.Low,
            evidence, [], [], [], "recommendation", new FindingSourceFreshnessV1(EvidenceSource.QueryStoreAggregate, DataStatus.Available, null, null, "r"));
    }

    [Fact]
    public void Clean_findings_pass_through_unredacted()
    {
        var (export, count) = FindingsRedactor.Build([Finding("A clean finding", "Family with 3 plans.")], FindingsTestData.Now, "1.0");
        Assert.Equal(0, count);
        Assert.Equal("A clean finding", export.Findings[0].Title);
    }

    [Theory]
    [InlineData("SELECT secret FROM dbo.users; DROP TABLE x")]
    [InlineData("<ShowPlanXML xmlns=\"...\">")]
    [InlineData("password=Hunter2")]
    [InlineData("Server=db;User Id=sa;pwd=x")]
    public void Sensitive_looking_text_is_hashed_not_passed_through(string sensitive)
    {
        var (export, count) = FindingsRedactor.Build([Finding("t", sensitive)], FindingsTestData.Now, "1.0");
        Assert.True(count >= 1);
        var observation = export.Findings[0].Evidence[0].Observation;
        Assert.StartsWith("redacted:", observation);
        Assert.DoesNotContain(sensitive, observation, StringComparison.Ordinal);
    }

    [Fact]
    public void Oversized_strings_are_hashed()
    {
        var big = new string('a', FindingsRedactor.MaxStringLength + 10);
        var (export, count) = FindingsRedactor.Build([Finding(big)], FindingsTestData.Now, "1.0");
        Assert.True(count >= 1);
        Assert.StartsWith("redacted:", export.Findings[0].Title);
    }

    [Fact]
    public void Bounds_finding_and_evidence_counts()
    {
        var many = Enumerable.Range(0, FindingsRedactor.MaxExportFindings + 50).Select(i => Finding($"f{i}")).ToArray();
        var (export, _) = FindingsRedactor.Build(many, FindingsTestData.Now, "1.0");
        Assert.Equal(FindingsRedactor.MaxExportFindings, export.Findings.Count);

        var observations = Enumerable.Range(0, FindingsRedactor.MaxEvidencePerFinding + 5).Select(i => $"obs {i}").ToArray();
        var (export2, _) = FindingsRedactor.Build([Finding("t", observations)], FindingsTestData.Now, "1.0");
        Assert.Equal(FindingsRedactor.MaxEvidencePerFinding, export2.Findings[0].Evidence.Count);
    }
}
