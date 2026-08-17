using Microsoft.Data.Sqlite;
using SqlSimCity.Storage;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// Applies idempotent schema migrations tracked via <c>PRAGMA user_version</c>.
/// Journal mode is WAL: the data directory is expected to be a local
/// filesystem-backed volume (a standard Docker named volume, as used by this
/// repository's compose.yaml), where WAL's shared-memory locking is reliable.
/// WAL must not be used with a network filesystem (NFS/CIFS) mount for
/// <c>/data</c>; see SECURITY.md.
/// </summary>
internal static class SqliteSchema
{
    public const int CurrentSchemaVersion = 1;

    private const string CreateV1Schema = """
        CREATE TABLE protected_records (
            id TEXT NOT NULL PRIMARY KEY,
            record_kind TEXT NOT NULL,
            captured_at_unix_ms INTEGER NOT NULL,
            resolution TEXT NOT NULL CHECK (resolution IN ('Detail','HourlyRollup')),
            envelope BLOB NOT NULL,
            stored_at_unix_ms INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX idx_protected_records_resolution_captured_at
            ON protected_records (resolution, captured_at_unix_ms);

        CREATE TABLE storage_canary (
            id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
            envelope BLOB NOT NULL,
            created_at_unix_ms INTEGER NOT NULL
        ) STRICT;
        """;

    public static async Task MigrateAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        await ExecuteAsync(connection, "PRAGMA journal_mode=WAL;", cancellationToken);
        await ExecuteAsync(connection, "PRAGMA synchronous=NORMAL;", cancellationToken);
        await ExecuteAsync(connection, "PRAGMA busy_timeout=5000;", cancellationToken);
        await ExecuteAsync(connection, "PRAGMA foreign_keys=ON;", cancellationToken);

        var currentVersion = await GetUserVersionAsync(connection, cancellationToken);
        if (currentVersion > CurrentSchemaVersion)
        {
            throw new ProtectedStorageMigrationException(
                $"Database schema version {currentVersion} is newer than the supported version {CurrentSchemaVersion}.");
        }

        if (currentVersion < 1)
        {
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            try
            {
                await ExecuteAsync(connection, CreateV1Schema, cancellationToken, transaction);
                await SetUserVersionAsync(connection, 1, transaction, cancellationToken);
                await transaction.CommitAsync(cancellationToken);
            }
            catch (SqliteException ex)
            {
                throw new ProtectedStorageMigrationException("Failed to create the version 1 schema.", ex);
            }
        }
    }

    private static async Task<long> GetUserVersionAsync(SqliteConnection connection, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version;";
        var result = await command.ExecuteScalarAsync(cancellationToken);
        return Convert.ToInt64(result, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static async Task SetUserVersionAsync(
        SqliteConnection connection, int version, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        // PRAGMA does not support bound parameters; `version` is an internal constant, never caller input.
        command.CommandText = $"PRAGMA user_version = {version};";
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task ExecuteAsync(
        SqliteConnection connection, string sql, CancellationToken cancellationToken, SqliteTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (SqliteException ex)
        {
            throw new ProtectedStorageMigrationException("A schema migration statement failed.", ex);
        }
    }
}
