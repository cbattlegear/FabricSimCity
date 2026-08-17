namespace SqlSimCity.Storage;

/// <summary>
/// An envelope failed structural validation or AES-256-GCM authentication.
/// This is raised for a wrong key, tampered nonce/tag/ciphertext, or a
/// ciphertext moved to a different record id/kind than it was sealed for.
/// </summary>
public sealed class EnvelopeIntegrityException : Exception
{
    public EnvelopeIntegrityException(string message)
        : base(message)
    {
    }

    public EnvelopeIntegrityException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
