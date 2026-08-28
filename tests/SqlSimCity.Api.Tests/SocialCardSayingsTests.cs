using System.Text.RegularExpressions;
using SqlSimCity.Api.Social;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Pins the C# copy of the loading sayings to the TypeScript list it was copied from.
/// </summary>
/// <remarks>
/// <para>
/// The list is duplicated because the container build makes sharing it impossible: the web stage
/// copies <c>web/</c> and the API stage copies <c>src/</c>, <c>sql/</c>, <c>fixtures/</c> and the
/// built <c>web/dist</c>. There is no point at which the API assembly can see
/// <c>web/src/cityLoadingSayings.ts</c>, at build time or at run time.
/// </para>
/// <para>
/// So the mirror is checked instead of avoided. This reads the TypeScript as source text -- the same
/// idiom <c>shadowInvalidation.test.ts</c> uses on the scene file -- and fails if the two lists have
/// drifted. Adding a saying to one and not the other is otherwise completely silent: both sides go on
/// compiling and the card simply stops saying the same things the loading screen does.
/// </para>
/// </remarks>
public sealed partial class SocialCardSayingsTests
{
    [GeneratedRegex(@"^\s*'((?:[^'\\]|\\.)*)',?\s*$", RegexOptions.Multiline)]
    private static partial Regex SayingLine();

    /// <summary>
    /// Walks up from the test assembly to the repository root.
    /// </summary>
    /// <remarks>
    /// Throws rather than skipping when the file is not found. A parity guard that quietly opts out
    /// when it cannot locate its subject is worse than no guard, because it reports success for a
    /// check it never ran.
    /// </remarks>
    private static string ReadTypeScriptSource()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "web", "src", "cityLoadingSayings.ts");
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            $"web/src/cityLoadingSayings.ts was not found above {AppContext.BaseDirectory}. " +
            "This guard cannot run without it, and must not pass without running.");
    }

    private static IReadOnlyList<string> TypeScriptSayings()
    {
        var source = ReadTypeScriptSource();
        var start = source.IndexOf("CITY_LOADING_SAYINGS", StringComparison.Ordinal);
        Assert.True(start >= 0, "CITY_LOADING_SAYINGS was not found; the export was renamed.");

        // Not the first '[' after the name -- that one belongs to the `readonly string[]` annotation,
        // and slicing from it yields an empty list that would make this guard pass against anything.
        var assignment = source.IndexOf('=', start);
        Assert.True(assignment >= 0, "The sayings array is not assigned; the declaration changed shape.");

        var open = source.IndexOf('[', assignment);
        var close = source.IndexOf(']', open);
        Assert.True(open >= 0 && close > open, "The sayings array literal could not be delimited.");

        var sayings = (IReadOnlyList<string>)[.. SayingLine()
            .Matches(source[(open + 1)..close])
            .Select(match => match.Groups[1].Value.Replace("\\'", "'", StringComparison.Ordinal))];

        // A parser that silently reads nothing agrees with any mirror, including an empty one.
        Assert.NotEmpty(sayings);
        return sayings;
    }

    [Fact]
    public void MirrorMatchesTheTypeScriptListExactly()
    {
        Assert.Equal(TypeScriptSayings(), SocialCardSayings.All);
    }

    [Fact]
    public void TheBorrowedLineIsStillThere()
    {
        Assert.Contains("Reticulating splines", SocialCardSayings.All);
    }

    [Fact]
    public void EverySeedPicksASaying()
    {
        long[] seeds = [0, 1, -1, long.MaxValue, long.MinValue, 987654321];

        Assert.All(seeds, seed => Assert.Contains(SocialCardSayings.Pick(seed), SocialCardSayings.All));
    }

    /// <summary>
    /// <c>Math.Abs(long.MinValue)</c> throws, which is the one seed a naive implementation dies on.
    /// </summary>
    [Fact]
    public void ExtremeSeedsDoNotThrow()
    {
        Assert.NotEmpty(SocialCardSayings.Pick(long.MinValue));
    }

    [Fact]
    public void PickIsStableForTheSameSeed()
    {
        Assert.Equal(SocialCardSayings.Pick(4242), SocialCardSayings.Pick(4242));
    }

    [Fact]
    public void DifferentSeedsReachDifferentSayings()
    {
        var picked = Enumerable.Range(0, 400).Select(seed => SocialCardSayings.Pick(seed)).Distinct().Count();

        Assert.Equal(SocialCardSayings.All.Count, picked);
    }
}
