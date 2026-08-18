using System.Globalization;
using System.Security.Cryptography;

namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Creates a key ring file for the convenience configuration path, where an
/// operator supplied a connection string and never asked to think about
/// encryption keys. It lives beside <see cref="KeyRingLoader"/> deliberately:
/// the writer and the strict reader share one file format, so the format can
/// never drift between them unnoticed.
///
/// This is emphatically not the hardened path. A generated key is only as
/// separated from its data as the directory it lands in, so callers are
/// expected to place it deliberately and to say out loud that they generated
/// one. The hardened deployment still mounts an operator-managed key from a
/// secrets manager, and <see cref="KeyRingLoader"/> treats both identically.
/// </summary>
public static class KeyRingProvisioner
{
    private const int FormatVersion = 1;
    private const int KeyLengthBytes = 32;

    /// <summary>
    /// Creates a single-key AES-256 key ring at <paramref name="keyFilePath"/>
    /// when no file is already there, returning <c>true</c> only when this call
    /// created it.
    ///
    /// An existing file is never inspected, rewritten, or replaced. That matters
    /// more than it looks: overwriting a key whose data still exists would
    /// permanently orphan every record it protected, and the store's canary
    /// check would then fail closed on the next start. Losing the race to a
    /// concurrent creator is treated the same way as finding the file already
    /// present, because both mean somebody else's key is now authoritative.
    /// </summary>
    public static bool TryCreate(string keyFilePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(keyFilePath);

        if (File.Exists(keyFilePath))
        {
            return false;
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(keyFilePath));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var key = RandomNumberGenerator.GetBytes(KeyLengthBytes);
        try
        {
            var document = string.Create(
                CultureInfo.InvariantCulture,
                $$"""
                {
                  "formatVersion": {{FormatVersion}},
                  "activeKeyVersion": 1,
                  "keys": [
                    { "version": 1, "key": "{{Convert.ToBase64String(key)}}" }
                  ]
                }
                """);

            try
            {
                using var stream = Create(keyFilePath);
                using var writer = new StreamWriter(stream);
                writer.Write(document);
            }
            catch (IOException) when (File.Exists(keyFilePath))
            {
                // Another process won the race; its key is authoritative.
                return false;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }

        return true;
    }

    /// <summary>
    /// Opens the new file such that it never exists in a readable-by-others
    /// state, rather than creating it and relaxing the mode afterwards.
    /// <c>FileMode.CreateNew</c> is what makes concurrent creation detectable.
    /// </summary>
    private static FileStream Create(string keyFilePath)
    {
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
        };

        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return new FileStream(keyFilePath, options);
    }
}
