namespace SqlSimCity.Collection;

using System.Globalization;

/// <summary>
/// The single rendering of a SQL Server <c>binary(8)</c> query hash into the string form this
/// codebase joins on.
/// <para>
/// Two independent collectors report the same underlying value: Query Store publishes
/// <c>sys.query_store_query.query_hash</c> on a query family, and the live sampler reports
/// <c>sys.dm_exec_requests.query_hash</c> on a running request. The city map joins them by string
/// equality to decide which family a running request belongs to. A difference of case, or of an
/// <c>0x</c> prefix, would match nothing at all -- and "no match" renders identically to "nothing is
/// running", so the failure is silent and looks like a quiet server rather than a bug. Both sides
/// therefore call <see cref="Render"/>, and neither formats a hash itself.
/// </para>
/// </summary>
public static class QueryHashFormat
{
    /// <summary>
    /// The all-zero hash the engine reports for a request it did not hash. Treated as an absence on
    /// the live side rather than passed through: admitting it as a value would collide every
    /// unhashed request onto one shared "family" that no Query Store row corresponds to.
    /// </summary>
    internal const string ZeroHash = "0000000000000000";

    /// <summary>
    /// Renders hash bytes as uppercase hex with no <c>0x</c> prefix. This is the canonical form, and
    /// this is deliberately the only place the choice is made.
    /// </summary>
    public static string Render(byte[] hash) => Convert.ToHexString(hash);

    /// <summary>
    /// Renders a live request's hash for joining, or returns null when there is nothing to join on:
    /// no hash column, an empty value, or the engine's all-zero "not hashed" sentinel.
    /// <para>
    /// Null is "no hash was reported", never "unknown query". A consumer must not fall back to
    /// matching on statement text.
    /// </para>
    /// </summary>
    public static string? ToJoinKey(byte[]? hash)
    {
        if (hash is null || hash.Length == 0)
        {
            return null;
        }

        var text = Render(hash);
        return text == ZeroHash ? null : text;
    }

    /// <summary>
    /// Renders a hash read from an untyped data reader column, accepting either the raw
    /// <c>byte[]</c> the engine returns or an already-stringified value from a source that could not
    /// preserve the bytes. Returns null for <see cref="DBNull"/>, null, or the all-zero sentinel.
    /// </summary>
    public static string? ToJoinKey(object? value) => value switch
    {
        null or DBNull => null,
        byte[] bytes => ToJoinKey(bytes),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) is { Length: > 0 } text && text != ZeroHash
            ? text
            : null,
    };
}
