using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Social;

/// <summary>
/// Turns whatever this instance has measured into the scene a share card draws.
/// </summary>
/// <remarks>
/// <para>
/// Every path here degrades rather than fails. A card is generated for a link somebody has already
/// pasted somewhere, so the failure mode that matters is not an inaccurate picture -- it is a preview
/// client being handed a 500 and rendering a bare URL. So an unreachable database, a collection that
/// has not happened yet and a database this instance has never heard of all produce a card; they just
/// produce one that claims less.
/// </para>
/// <para>
/// Nothing is invented to fill a gap. A scene with no measured sizes draws an empty lot and says
/// nothing about how big anything is, which is the same contract the map keeps.
/// </para>
/// </remarks>
public static class SocialCardScenes
{
    /// <summary>How many towers a skyline may hold before it stops being a skyline.</summary>
    public const int MaximumTowers = 30;

    /// <summary>The atlas card: one tower per database, by allocated size.</summary>
    public static SocialCardScene ForAtlas(AtlasSnapshotV1? atlas, string saying)
    {
        ArgumentNullException.ThrowIfNull(saying);
        var databases = atlas?.Databases ?? [];
        var bytes = databases.Select(database => ParseBytes(database.Allocated?.Bytes)).ToList();
        var sizes = bytes
            .Where(value => value > 0)
            .OrderByDescending(value => value)
            .Take(MaximumTowers)
            .ToList();

        var stats = databases.Count == 0
            ? string.Empty
            : $"{Plural(databases.Count, "database")}{TotalSuffix(sizes.Count == 0 ? null : Sum(databases))}";

        return new SocialCardScene(
            "Server atlas",
            SocialMetadata.ProductName,
            saying,
            stats,
            Scatter(Skyline(sizes, bytes.Count(value => value == 0))));
    }

    /// <summary>The city card: one tower per object, by reserved size.</summary>
    public static SocialCardScene ForCity(DatabaseCityPageV1 city, string saying)
    {
        ArgumentNullException.ThrowIfNull(city);
        ArgumentNullException.ThrowIfNull(saying);

        var bytes = city.Objects.Select(instance => ParseBytes(instance.ReservedBytes)).ToList();
        var sizes = bytes
            .Where(value => value > 0)
            .OrderByDescending(value => value)
            .Take(MaximumTowers)
            .ToList();

        var counted = long.TryParse(city.TotalObjects, NumberStyles.Integer, CultureInfo.InvariantCulture, out var total)
            ? total
            : city.Objects.Count;

        return new SocialCardScene(
            "Database city",
            city.DatabaseName,
            saying,
            counted > 0 ? Plural(counted, "object") : string.Empty,
            Scatter(Skyline(sizes, bytes.Count(value => value == 0))));
    }

    /// <summary>
    /// The city card for a database the city source could not draw.
    /// </summary>
    /// <remarks>
    /// Reached when the page read fails, times out, or the database is not in the atlas at all -- the
    /// last of which includes a stale link to a database that has since been dropped. The name is
    /// still shown, because it is what the link asked for and the card's job is to say what was
    /// clicked; the skyline is empty, because nothing was measured.
    /// </remarks>
    public static SocialCardScene ForUnmeasuredCity(string databaseName, string saying) =>
        new("Database city", databaseName, saying, string.Empty, []);

    /// <summary>
    /// Rescales measured sizes into the 0..1 heights the renderer stands towers at.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Logarithmic, and not because it looks nicer. Databases and tables span orders of magnitude, so
    /// a linear scale draws one tower at full height and everything else as a kerbstone -- which is
    /// both ugly and a worse description of the data than the log is.
    /// </para>
    /// <para>
    /// The floor is high, at a third of the tallest tower. A measured object that draws as a kerbstone
    /// is worse than useless: it is counted in the stats line but invisible in the picture, so the
    /// card looks like it has lost something. Every object that was measured has to read as a
    /// building. Relative order and rough proportion survive the floor; the bottom of the range does
    /// not, and it is not what the picture is for.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<double> Normalize(IReadOnlyList<long> sizes)
    {
        ArgumentNullException.ThrowIfNull(sizes);
        if (sizes.Count == 0) return [];

        var logs = sizes.Select(bytes => Math.Log10(bytes + 1)).ToList();
        var smallest = logs.Min();
        var largest = logs.Max();
        var span = largest - smallest;

        // Every object the same size is a real answer, and dividing by that span is not. Standing them
        // at a common height says exactly what was measured.
        if (span < 1e-9) return [.. logs.Select(_ => 0.72)];
        return [.. logs.Select(value => Floor + ((1 - Floor) * ((value - smallest) / span)))];
    }

    /// <summary>The shortest a measured tower may stand, as a fraction of the tallest.</summary>
    public const double Floor = 0.34;

    private static long Sum(IReadOnlyList<DatabaseAtlasItemV1> databases) =>
        databases.Sum(database => ParseBytes(database.Allocated?.Bytes));

    /// <summary>
    /// Shuffles tower heights into a skyline order.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Sizes arrive sorted, because the largest are the ones worth drawing. Drawing them in that
    /// order is the single biggest reason a skyline reads as a bar chart: a monotonic staircase is
    /// a chart no matter what the bars are shaped like. Scattering them costs nothing and is the
    /// difference between a graph and a city.
    /// </para>
    /// <para>
    /// The shuffle is seeded from the heights themselves, so it is a function of the data and not of
    /// the clock or the process. That is load-bearing rather than tidy: a preview client fetches the
    /// image more than once, and a skyline that rearranged between fetches would look like a fault in
    /// the thing being advertised. Same data, same city.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<SocialCardTower> Scatter(IReadOnlyList<SocialCardTower> towers)
    {
        ArgumentNullException.ThrowIfNull(towers);
        if (towers.Count < 3) return towers;

        var scattered = towers.ToArray();
        var state = 0UL;
        foreach (var tower in scattered)
        {
            state = (state * 1099511628211UL) ^ (ulong)BitConverter.DoubleToInt64Bits(tower.Height);
            state ^= tower.Measured ? 0x9E3779B97F4A7C15UL : 0UL;
        }

        // Fisher-Yates driven by a 64-bit xorshift, which is plenty of quality for arranging at most
        // thirty buildings and short enough to read.
        state |= 1;
        for (var index = scattered.Length - 1; index > 0; index--)
        {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            var swap = (int)(state % (ulong)(index + 1));
            (scattered[index], scattered[swap]) = (scattered[swap], scattered[index]);
        }

        return scattered;
    }

    /// <summary>
    /// Assembles the full skyline: measured sizes as towers, plus one cleared lot per unmeasured one.
    /// </summary>
    /// <remarks>
    /// The lots are what keep the picture and the stats line telling the same story. An instance where
    /// two of eight databases have no allocated size still gets eight plots; six of them are
    /// buildings and two are visibly empty ground. The alternative -- drawing six -- makes the count
    /// underneath look wrong, and there is no honest height to stand an unmeasured database at.
    /// </remarks>
    public static IReadOnlyList<SocialCardTower> Skyline(IReadOnlyList<long> sizes, int unmeasured)
    {
        ArgumentNullException.ThrowIfNull(sizes);
        ArgumentOutOfRangeException.ThrowIfNegative(unmeasured);

        // Capped here as well as at the call sites. The callers take the largest few before
        // normalizing, because that is the only place that knows the largest are the ones worth
        // drawing -- but this is public and must not be able to produce a thousand-tower card.
        var measured = Normalize([.. sizes.Take(MaximumTowers)]);
        var lots = Math.Min(unmeasured, Math.Max(0, MaximumTowers - measured.Count));
        var skyline = new List<SocialCardTower>(measured.Count + lots);
        skyline.AddRange(measured.Select(height => new SocialCardTower(height, true)));
        for (var index = 0; index < lots; index++)
        {
            skyline.Add(new SocialCardTower(0, false));
        }

        return skyline;
    }

    private static string TotalSuffix(long? bytes) =>
        bytes is null or 0 ? string.Empty : $" \u00B7 {SocialCardRenderer.FormatBytes(bytes.Value)}";

    private static string Plural(long count, string noun) =>
        $"{count.ToString("#,0", CultureInfo.InvariantCulture)} {noun}{(count == 1 ? string.Empty : "s")}";

    /// <summary>
    /// Reads a byte count off the wire contracts, where sizes travel as strings.
    /// </summary>
    /// <remarks>
    /// They are strings because a byte count can exceed what a JSON number survives intact, and a
    /// value that cannot be parsed here is absent evidence rather than a zero -- callers filter it out
    /// instead of standing a tower of no height.
    /// </remarks>
    private static long ParseBytes(string? value) =>
        long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var bytes) && bytes > 0
            ? bytes
            : 0;
}
