namespace SqlSimCity.Storage;

/// <summary>
/// Distinguishes short-lived detail records from longer-retained hourly rollups.
/// The value participates in the encrypted envelope's authenticated associated
/// data only indirectly (via record kind/id); it is stored as plaintext metadata
/// because retention pruning must query it without decrypting every payload.
/// </summary>
public enum StorageResolution
{
    Detail,
    HourlyRollup,
}
