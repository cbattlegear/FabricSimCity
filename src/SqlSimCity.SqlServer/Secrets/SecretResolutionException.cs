namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// A configured secret reference could not be resolved to usable material --
/// missing, unreadable, oversized, outside the allowed directory, or not a
/// valid encoding for its expected shape. Messages are always structural;
/// secret content is never included.
/// </summary>
public sealed class SecretResolutionException : Exception
{
    public SecretResolutionException(string message)
        : base(message)
    {
    }

    public SecretResolutionException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
