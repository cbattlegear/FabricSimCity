using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Social;

/// <summary>
/// Renders share cards, at most once a day each.
/// </summary>
/// <remarks>
/// <para>
/// A card is a picture of a city, and drawing it reads the same city page the map reads. That is far
/// too expensive to do per request when the requester is a crawler that may fetch the same URL
/// repeatedly, so a rendered card is held for the rest of the UTC day it was drawn on. That is also
/// what the daily refresh means in practice: the picture changes once a day, as a photograph taken
/// every morning would.
/// </para>
/// <para>
/// Entries are per database, and the map is capped. Without a cap the cache is addressable by the
/// query string -- anyone could ask for a thousand database names that do not exist and keep a
/// megabyte of card apiece. Past the cap, a miss renders and is simply not stored.
/// </para>
/// </remarks>
public sealed class SocialCardCache(
    IAtlasSnapshotSource? atlas,
    IDatabaseCitySource? cities,
    TimeProvider clock,
    ILogger<SocialCardCache> logger) : IDisposable
{
    /// <summary>
    /// How long the city read is given before the card is drawn without it.
    /// </summary>
    /// <remarks>
    /// A share card is not worth holding a request open for. If the database is slow or unreachable
    /// the card still has a name to draw and a link to be, and it is better to draw that than to make
    /// a preview client wait and then give up on the page entirely.
    /// </remarks>
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(6);

    private const int MaximumEntries = 64;
    private const int ObjectsSampled = 50;

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, CachedCard> cards = new(StringComparer.OrdinalIgnoreCase);

    private sealed record CachedCard(long Day, byte[] Png);

    /// <summary>Returns the card for a database, or for the atlas when <paramref name="database"/> is null.</summary>
    public async Task<byte[]> GetAsync(string? database, CancellationToken cancellationToken)
    {
        var key = database ?? string.Empty;
        var today = SocialSeed.DayNumber(clock.GetUtcNow());

        await gate.WaitAsync(cancellationToken);
        try
        {
            if (cards.TryGetValue(key, out var cached) && cached.Day == today)
            {
                return cached.Png;
            }

            var png = await RenderAsync(database, cancellationToken);

            // Dropping the whole map at the cap rather than evicting one entry: the entries all expire
            // together at midnight anyway, so there is no useful recency order to preserve, and this
            // needs no bookkeeping to be correct.
            if (cards.Count >= MaximumEntries) cards.Clear();
            cards[key] = new CachedCard(today, png);
            return png;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<byte[]> RenderAsync(string? database, CancellationToken cancellationToken)
    {
        var saying = SocialCardSayings.Pick(SocialSeed.For($"card|{database}", clock.GetUtcNow()));
        var snapshot = Safely(() => atlas?.GetCurrent());

        if (database is null)
        {
            return SocialCardRenderer.Render(SocialCardScenes.ForAtlas(snapshot, saying));
        }

        var page = await ReadCityAsync(snapshot, database, cancellationToken);
        var scene = page is null
            ? SocialCardScenes.ForUnmeasuredCity(database, saying)
            : SocialCardScenes.ForCity(page, saying);
        return SocialCardRenderer.Render(scene);
    }

    /// <summary>
    /// Reads the city behind a database name, or gives up quietly.
    /// </summary>
    /// <remarks>
    /// The card URL carries a name rather than the composed database id, because a name is what a
    /// human reads in a shared link and the id is an internal key. Resolving it through the atlas is
    /// therefore also the check that the name refers to a database this instance actually has -- a
    /// name that matches nothing is not looked up, so an arbitrary query string cannot start a city
    /// read.
    /// </remarks>
    private async Task<DatabaseCityPageV1?> ReadCityAsync(
        AtlasSnapshotV1? snapshot,
        string database,
        CancellationToken cancellationToken)
    {
        if (cities is null) return null;
        var match = snapshot?.Databases
            .FirstOrDefault(item => string.Equals(item.Name, database, StringComparison.OrdinalIgnoreCase));
        if (match is null) return null;

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(ReadTimeout);
        try
        {
            return await cities.GetDatabaseAsync(
                match.DatabaseId,
                DatabaseCityMetric.Cpu,
                ObjectsSampled,
                pageToken: null,
                deadline.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            SocialCardLog.ReadTimedOut(logger, database, ReadTimeout);
            return null;
        }
        catch (Exception exception)
        {
            SocialCardLog.ReadFailed(logger, database, exception);
            return null;
        }
    }

    private T? Safely<T>(Func<T?> read)
    {
        try
        {
            return read();
        }
        catch (Exception exception)
        {
            SocialCardLog.AtlasUnavailable(logger, exception);
            return default;
        }
    }

    /// <summary>Releases the single-flight gate.</summary>
    public void Dispose() => gate.Dispose();
}

/// <remarks>
/// Source-generated rather than called through <c>ILogger.LogInformation</c> because this repository
/// builds with CA1848 and CA1873 as errors: the generated delegates avoid both the boxing and the
/// argument evaluation that the extension methods pay for even when the level is disabled.
/// </remarks>
internal static partial class SocialCardLog
{
    [LoggerMessage(
        Level = LogLevel.Information,
        Message = "Share card for {Database} drawn without a skyline: the city read exceeded {Timeout}.")]
    public static partial void ReadTimedOut(ILogger logger, string database, TimeSpan timeout);

    [LoggerMessage(
        Level = LogLevel.Information,
        Message = "Share card for {Database} drawn without a skyline: the city could not be read.")]
    public static partial void ReadFailed(ILogger logger, string database, Exception exception);

    [LoggerMessage(
        Level = LogLevel.Information,
        Message = "Share card drawn without the atlas: the snapshot could not be read.")]
    public static partial void AtlasUnavailable(ILogger logger, Exception exception);
}
