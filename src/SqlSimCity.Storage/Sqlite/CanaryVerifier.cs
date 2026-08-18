using System.Text;
using Microsoft.Data.Sqlite;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// Verifies or creates the single-row canary that marks this directory as a SQL SimCity
/// protected store. Payloads are written in the clear, so the canary authenticates no key:
/// it proves the file is the store this build understands and not some other SQLite database
/// that happens to sit at the configured path. It must be present and hold the expected
/// value before any record access is permitted.
/// </summary>
internal static class CanaryVerifier
{
    private const string CanaryRecordKind = "__canary__";
    private const string CanaryRecordId = "__canary__";
    private static readonly byte[] ExpectedPlaintext = Encoding.UTF8.GetBytes("sqlsimcity-protected-storage-canary-v1");

    public static async Task EnsureCanaryAsync(
        SqliteConnection connection,
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
                    "Protected storage canary is missing; an existing store cannot be identified.");
            }

            var envelope = EnvelopeCodec.Wrap(CanaryRecordKind, CanaryRecordId, ExpectedPlaintext);
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
            plaintext = EnvelopeCodec.Unwrap(CanaryRecordKind, CanaryRecordId, existingEnvelope);
        }
        catch (EnvelopeIntegrityException ex)
        {
            throw new CanaryVerificationException(
                "Protected storage canary could not be read; this is not a store this version can open.", ex);
        }

        if (!plaintext.AsSpan().SequenceEqual(ExpectedPlaintext))
        {
            throw new CanaryVerificationException("Protected storage canary held an unexpected value.");
        }
    }
}
