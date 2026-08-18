namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Writes and reads the versioned protected storage envelope.
/// <para>
/// Records are written in the clear as <c>[formatVersion=2:1][payload:N]</c>. SQL SimCity
/// exists to show query plans, object attribution, and workload evidence, so captured
/// payloads stay readable: the value of the archive is inspection, not secrecy. Protect the
/// storage directory with filesystem permissions if the captured plans and query text are
/// sensitive, because plan XML can contain literal parameter values.
/// </para>
/// <para>
/// The version byte is retained so a store can still say what wrote it. Format version 1 was
/// an AES-256-GCM sealed envelope; support for reading it has been removed, so such a record
/// is reported by version rather than being silently treated as payload bytes.
/// </para>
/// </summary>
internal static class EnvelopeCodec
{
    private const byte SealedFormatVersion1 = 1;
    private const byte PlaintextFormatVersion2 = 2;
    private const int HeaderSizeBytes = 1;

    public static byte[] Wrap(string recordKind, string recordId, ReadOnlySpan<byte> payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(recordKind);
        ArgumentException.ThrowIfNullOrEmpty(recordId);

        var envelope = new byte[HeaderSizeBytes + payload.Length];
        envelope[0] = PlaintextFormatVersion2;
        payload.CopyTo(envelope.AsSpan(HeaderSizeBytes));
        return envelope;
    }

    public static byte[] Unwrap(string recordKind, string recordId, ReadOnlySpan<byte> envelope)
    {
        ArgumentException.ThrowIfNullOrEmpty(recordKind);
        ArgumentException.ThrowIfNullOrEmpty(recordId);

        if (envelope.Length < HeaderSizeBytes)
        {
            throw new EnvelopeIntegrityException(
                $"Envelope is {envelope.Length} bytes, shorter than the {HeaderSizeBytes}-byte header.");
        }

        var formatVersion = envelope[0];
        if (formatVersion == PlaintextFormatVersion2)
        {
            return envelope[HeaderSizeBytes..].ToArray();
        }

        // Naming the cause matters more than the failure: an operator meeting this has a store
        // from a build that encrypted records, and no key can open it here any more.
        if (formatVersion == SealedFormatVersion1)
        {
            throw new EnvelopeIntegrityException(
                "This record was written by a version of SQL SimCity that encrypted protected storage. " +
                "Support for reading that format has been removed. Delete the store directory to start " +
                "a fresh one; retained Query Store history is a cache of the server's own data, not a " +
                "system of record.");
        }

        throw new EnvelopeIntegrityException($"Unsupported envelope format version {formatVersion}.");
    }
}
