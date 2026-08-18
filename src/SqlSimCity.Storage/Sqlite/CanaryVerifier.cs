using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// Verifies or creates the single-row encrypted canary that proves the
/// configured key ring matches this store. A fresh store (no canary row) may
/// create one; an existing store must decrypt and match the expected
/// plaintext before any record access is permitted.
/// </summary>
internal static class CanaryVerifier
{
    private const string CanaryRecordKind = "__canary__";
    private const string CanaryRecordId = "__canary__";
    private static readonly byte[] ExpectedPlaintext = Encoding.UTF8.GetBytes("sqlsimcity-protected-storage-canary-v1");

    public static async Task EnsureCanaryAsync(
        SqliteConnection connection,
        KeyRing keyRing,
        TimeProvider timeProvider,
        CancellationToken cancellationToken,
        SqliteTransaction? transaction = null,
        bool createIfMissing = false)
    {
        byte[]? existingEnvelope = null;
        await using (var selectCommand = connection.CreateCommand())
        {
            selectCommand.CommandText = "SELECT envelope FROM storage_canary WHERE id = 1;";
            selectCommand.Transaction = transaction;
            await using var reader = await selectCommand.ExecuteReaderAsync(cancellationToken);
            if (await reader.ReadAsync(cancellationToken))
            {
                existingEnvelope = (byte[])reader["envelope"];
            }
        }

        if (existingEnvelope is null)
        {
            if (!createIfMissing)
            {
                throw new CanaryVerificationException(
                    "Protected storage canary is missing; an existing store cannot be authenticated.");
            }

            var envelope = EnvelopeCodec.Seal(keyRing, CanaryRecordKind, CanaryRecordId, ExpectedPlaintext);
            await using var insertCommand = connection.CreateCommand();
            insertCommand.Transaction = transaction;
            insertCommand.CommandText =
                "INSERT INTO storage_canary (id, envelope, created_at_unix_ms) VALUES (1, $envelope, $createdAt);";
            insertCommand.Parameters.AddWithValue("$envelope", envelope);
            insertCommand.Parameters.AddWithValue("$createdAt", timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
            await insertCommand.ExecuteNonQueryAsync(cancellationToken);
            return;
        }

        byte[] plaintext;
        try
        {
            plaintext = EnvelopeCodec.Open(keyRing, CanaryRecordKind, CanaryRecordId, existingEnvelope);
        }
        catch (EnvelopeIntegrityException ex)
        {
            throw new CanaryVerificationException(
                "Protected storage canary failed authentication; the configured key does not match this store.", ex);
        }
        catch (KeyRingConfigurationException ex)
        {
            throw new CanaryVerificationException(
                "Protected storage canary was sealed with a key version absent from the configured key ring.", ex);
        }

        try
        {
            if (!plaintext.AsSpan().SequenceEqual(ExpectedPlaintext))
            {
                throw new CanaryVerificationException("Protected storage canary decrypted to an unexpected value.");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }
}
