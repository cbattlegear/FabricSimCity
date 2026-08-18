using System.Text.RegularExpressions;
using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Collection.Tests.Catalog;

/// <summary>
/// Asserts every embedded probe in the real catalog is read-only. This is the "no mutating SQL
/// execution" property requirement 9 asks for, checked once against the whole catalog rather than
/// trusted to any individual probe author.
/// </summary>
public partial class NoMutatingSqlTests
{
    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|TRUNCATE|DROP|ALTER|GRANT|DENY|REVOKE|CREATE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex MutatingKeywordPattern();

    [Fact]
    public void EveryEmbeddedProbeContainsNoMutatingKeyword()
    {
        var catalog = ProbeCatalog.Load();
        var offenders = new List<string>();

        foreach (var id in catalog.ProbeIds)
        {
            var probe = catalog.Get(id);
            var stripped = SqlTextScanner.StripComments(probe.CommandText);
            if (MutatingKeywordPattern().IsMatch(stripped))
            {
                offenders.Add(id);
            }
        }

        Assert.Empty(offenders);
    }
}
