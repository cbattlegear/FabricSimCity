namespace SqlSimCity.Storage;

/// <summary>
/// The store's encrypted canary could not be verified: the configured key does
/// not match the key(s) this store was created or last verified with, or the
/// canary decrypted to an unexpected value. This blocks all record access.
/// </summary>
public sealed class CanaryVerificationException : Exception
{
    public CanaryVerificationException(string message)
        : base(message)
    {
    }

    public CanaryVerificationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
