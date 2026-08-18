namespace SqlSimCity.Edge.Spool;

/// <summary>
/// Bounds for the connector's local encrypted spool. Every bound is explicit and enforced; there is
/// no unbounded growth path. When a new batch would breach <see cref="MaxBytes"/> or
/// <see cref="MaxItems"/> the spool applies backpressure (rejects the write and reports paused)
/// rather than silently overwriting or discarding queued evidence.
/// </summary>
public sealed record SpoolOptions
{
    /// <summary>Directory holding sealed spool files. Created if missing.</summary>
    public required string DataDirectory { get; init; }

    /// <summary>Maximum total sealed bytes retained on disk.</summary>
    public long MaxBytes { get; init; } = 64 * 1024 * 1024;

    /// <summary>Maximum number of queued batches.</summary>
    public int MaxItems { get; init; } = 4096;

    /// <summary>Maximum age of a queued batch before it is explicitly dropped (never silently).</summary>
    public TimeSpan MaxAge { get; init; } = TimeSpan.FromHours(24);

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(DataDirectory))
            throw new ArgumentException("Spool DataDirectory must be configured.");
        if (MaxBytes is < 4096 or > 4L * 1024 * 1024 * 1024)
            throw new ArgumentException("Spool MaxBytes must be between 4 KiB and 4 GiB.");
        if (MaxItems is < 1 or > 1_000_000)
            throw new ArgumentException("Spool MaxItems must be between 1 and 1,000,000.");
        if (MaxAge < TimeSpan.FromMinutes(1) || MaxAge > TimeSpan.FromDays(30))
            throw new ArgumentException("Spool MaxAge must be between 1 minute and 30 days.");
    }
}

/// <summary>Why an enqueue attempt did or did not succeed.</summary>
public enum SpoolEnqueueOutcome
{
    /// <summary>The batch was sealed and durably written.</summary>
    Accepted,

    /// <summary>The spool is at a configured bound; the caller must apply backpressure and retry later.</summary>
    RejectedBackpressure,
}

/// <summary>A point-in-time view of spool occupancy and lifetime drop accounting.</summary>
public sealed record SpoolStatus(
    int ItemCount,
    long ByteCount,
    bool Paused,
    long DroppedByAge)
{
    public static readonly SpoolStatus Empty = new(0, 0, false, 0);
}
