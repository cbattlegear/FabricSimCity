namespace SqlSimCity.Collection.Probes;

/// <summary>
/// Base type for every classified probe execution failure. Only subclasses of this type,
/// classified <see cref="Microsoft.Data.SqlClient.SqlException"/> instances (wrapped by
/// <see cref="SqlExceptionClassifier"/>), and <see cref="OperationCanceledException"/> are caught
/// by <c>SqlClientProbeExecutor</c> and the negotiation layer above it. Any other exception type
/// -- a programming bug, a missing dependency, an out-of-memory condition -- is intentionally left
/// to propagate unhandled; this is the documented boundary requirement 5 asks for. The public
/// <see cref="Reason"/> on every subclass is always a fixed, curated sentence, never the raw
/// <see cref="Exception.Message"/> of an underlying <see cref="Microsoft.Data.SqlClient.SqlException"/>,
/// which can contain server names, object names, or query fragments.
/// </summary>
public abstract class ProbeExecutionException : Exception
{
    /// <summary>A short, non-secret, caller-safe description of what went wrong.</summary>
    public string Reason { get; }

    /// <summary><c>SqlException.Number</c> when this was raised from a classified SQL error; otherwise null.</summary>
    public int? SqlErrorNumber { get; }

    /// <summary><c>SqlException.Class</c> when this was raised from a classified SQL error; otherwise null.</summary>
    public byte? SqlErrorClass { get; }

    protected ProbeExecutionException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException)
        : base(reason, innerException)
    {
        Reason = reason;
        SqlErrorNumber = sqlErrorNumber;
        SqlErrorClass = sqlErrorClass;
    }
}

/// <summary>The caller's login lacks the permission a probe requires (e.g. VIEW SERVER STATE).</summary>
public sealed class ProbePermissionDeniedException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>
/// A referenced object, view, or column does not exist on the connected engine build -- the
/// signal a version/metadata mismatch produces, never treated as permission denial or success.
/// </summary>
public sealed class ProbeObjectUnavailableException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>A transient connection failure (throttling, failover, network) that a caller may retry.</summary>
public sealed class ProbeTransientConnectionException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>The command's configured timeout elapsed before the probe completed.</summary>
public sealed class ProbeTimeoutException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>Authentication or login configuration failed and should not be retried as transient.</summary>
public sealed class ProbeAuthenticationException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>The requested database cannot be opened and retry policy requires external context.</summary>
public sealed class ProbeDatabaseUnavailableException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>A deterministic source explicitly records that this probe was not attempted.</summary>
public sealed class ProbeNotProbedException(string reason, int? sqlErrorNumber = null, byte? sqlErrorClass = null, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>
/// An unclassified SQL/infrastructure error. The internal exception is preserved on
/// <see cref="Exception.InnerException"/> for local diagnostics but must never be surfaced to a
/// public API response; only <see cref="ProbeExecutionException.Reason"/> is safe to expose.
/// </summary>
public sealed class ProbeUnknownException(string reason, int? sqlErrorNumber, byte? sqlErrorClass, Exception? innerException = null)
    : ProbeExecutionException(reason, sqlErrorNumber, sqlErrorClass, innerException);

/// <summary>A probe returned a value that cannot be represented by its declared result contract.</summary>
public sealed class ProbeDataFormatException(string reason, Exception? innerException = null)
    : ProbeExecutionException(reason, null, null, innerException);
