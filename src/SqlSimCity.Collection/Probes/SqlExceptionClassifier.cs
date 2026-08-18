using Microsoft.Data.SqlClient;

namespace SqlSimCity.Collection.Probes;

/// <summary>
/// Classifies a <see cref="SqlException"/> into one of the <see cref="ProbeExecutionException"/>
/// subclasses using its documented <c>Number</c>/<c>Class</c> -- never by pattern-matching its
/// free-text <c>Message</c>, which may contain server names, object names, or query fragments that
/// must not leak into a public diagnostic. Unrecognized errors classify as
/// <see cref="ProbeUnknownException"/> rather than being folded into any success path.
/// </summary>
public static class SqlExceptionClassifier
{
    // Object/column does not exist -- the metadata-mismatch signal, not a permission problem.
    private static readonly HashSet<int> ObjectUnavailableNumbers = [207, 208, 4121];

    // Permission denied on a securable (varies with the exact GRANT/statement/object being denied).
    private static readonly HashSet<int> PermissionDeniedNumbers = [229, 230, 262, 297, 300, 15247, 15274, 15281, 33665];

    // Connection-level/throttling/failover errors a caller may reasonably retry.
    private static readonly HashSet<int> TransientConnectionNumbers =
        [40197, 40501, 40613, 40615, 10928, 10929, 10053, 10054, 10060, 233, 64];

    public static ProbeExecutionException Classify(SqlException exception, string probeId)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return ClassifyByNumberAndClass(exception.Number, exception.Class, probeId, exception);
    }

    /// <summary>
    /// The pure number/class -&gt; classification decision, extracted so it can be exercised with
    /// fabricated (number, class) pairs in unit tests without constructing a real
    /// <see cref="SqlException"/>, which has no public constructor for arbitrary error numbers.
    /// </summary>
    public static ProbeExecutionException ClassifyByNumberAndClass(int number, byte errorClass, string probeId, SqlException? cause = null)
    {
        // Microsoft.Data.SqlClient surfaces both ADO.NET command-timeout (-2) and its own
        // client-side timeout as this well-known number.
        if (number == -2)
        {
            return new ProbeTimeoutException(
                $"Probe '{probeId}' timed out before it completed.",
                number,
                errorClass,
                cause);
        }

        if (number == 18456)
        {
            return new ProbeAuthenticationException(
                $"Probe '{probeId}' could not authenticate the configured login.",
                number,
                errorClass,
                cause);
        }

        if (number == 4060)
        {
            return new ProbeDatabaseUnavailableException(
                $"Probe '{probeId}' could not open the requested database.",
                number,
                errorClass,
                cause);
        }

        if (ObjectUnavailableNumbers.Contains(number))
        {
            return new ProbeObjectUnavailableException(
                $"Probe '{probeId}' referenced a catalog object or column that does not exist on this engine build.",
                number,
                errorClass,
                cause);
        }

        if (PermissionDeniedNumbers.Contains(number))
        {
            return new ProbePermissionDeniedException(
                $"Probe '{probeId}' was denied by the connected login's permissions.",
                number,
                errorClass,
                cause);
        }

        if (TransientConnectionNumbers.Contains(number) || errorClass >= 20)
        {
            return new ProbeTransientConnectionException(
                $"Probe '{probeId}' failed due to a transient connection error.",
                number,
                errorClass,
                cause);
        }

        return new ProbeUnknownException(
            $"Probe '{probeId}' failed with an unclassified SQL error.",
            number,
            errorClass,
            cause);
    }
}
