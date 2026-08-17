using Microsoft.Data.Sqlite;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// SQLite-backed <see cref="IProtectedRecordStore"/>. SQLite holds only
/// opaque id, record kind, captured timestamp, resolution, and the encrypted
/// envelope; it never sees plaintext payload bytes. A new connection is
/// opened per operation (each with its own busy timeout), relying on WAL for
/// reader/writer concurrency rather than in-process locking.
/// <see cref="EnsureReadyAsync"/> must succeed before any other member is
/// called; every other member throws <see cref="InvalidOperationException"/>
/// otherwise, which keeps the store fail-closed if a host forgets to await
/// startup initialization.
/// </summary>
public sealed class SqliteProtectedRecordStore : IProtectedRecordStore, IProtectedStorageInitializer, IDisposable
{
    private readonly string _connectionString;
    private readonly KeyRing _keyRing;
    private readonly RetentionOptions _retention;
    private readonly TimeProvider _timeProvider;
    private int _ready;
    private bool _disposed;

    public SqliteProtectedRecordStore(
        string dataDirectory,
        string databaseFileName,
        KeyRing keyRing,
        RetentionOptions retention,
        TimeProvider timeProvider)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseFileName);
        ArgumentNullException.ThrowIfNull(keyRing);
        ArgumentNullException.ThrowIfNull(retention);
        ArgumentNullException.ThrowIfNull(timeProvider);

        Directory.CreateDirectory(dataDirectory);
        var databasePath = Path.Combine(dataDirectory, databaseFileName);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            // Pooling keeps a native handle open after the C# wrapper is disposed,
            // which holds Windows file locks past the point tests (and operators)
            // expect the file to be free. This store isn't a request hot path.
            Pooling = false,
        }.ToString();
        _keyRing = keyRing;
        _retention = retention;
        _timeProvider = timeProvider;
    }

    public async Task EnsureReadyAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await SqliteSchema.MigrateAsync(connection, cancellationToken);
        await CanaryVerifier.EnsureCanaryAsync(connection, _keyRing, _timeProvider, cancellationToken);
        Volatile.Write(ref _ready, 1);
    }

    public async Task PutAsync(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(recordKind);

        var envelope = EnvelopeCodec.Seal(_keyRing, recordKind, id.Value, payload.Span);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO protected_records (id, record_kind, captured_at_unix_ms, resolution, envelope, stored_at_unix_ms)
            VALUES ($id, $kind, $capturedAt, $resolution, $envelope, $storedAt)
            ON CONFLICT(id) DO UPDATE SET
                record_kind = excluded.record_kind,
                captured_at_unix_ms = excluded.captured_at_unix_ms,
                resolution = excluded.resolution,
                envelope = excluded.envelope,
                stored_at_unix_ms = excluded.stored_at_unix_ms;
            """;
        command.Parameters.AddWithValue("$id", id.Value);
        command.Parameters.AddWithValue("$kind", recordKind);
        command.Parameters.AddWithValue("$capturedAt", capturedAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$resolution", resolution.ToString());
        command.Parameters.AddWithValue("$envelope", envelope);
        command.Parameters.AddWithValue("$storedAt", _timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<ProtectedRecord?> GetAsync(ProtectedRecordId id, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        string recordKind;
        long capturedAtUnixMs;
        StorageResolution resolution;
        byte[] envelope;

        await using (var connection = await OpenConnectionAsync(cancellationToken))
        await using (var command = connection.CreateCommand())
        {
            command.CommandText =
                "SELECT record_kind, captured_at_unix_ms, resolution, envelope FROM protected_records WHERE id = $id;";
            command.Parameters.AddWithValue("$id", id.Value);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            recordKind = reader.GetString(0);
            capturedAtUnixMs = reader.GetInt64(1);
            resolution = Enum.Parse<StorageResolution>(reader.GetString(2));
            envelope = (byte[])reader["envelope"];
        }

        var plaintext = EnvelopeCodec.Open(_keyRing, recordKind, id.Value, envelope);
        return new ProtectedRecord(
            id, recordKind, DateTimeOffset.FromUnixTimeMilliseconds(capturedAtUnixMs), resolution, plaintext);
    }

    public async Task<bool> DeleteAsync(ProtectedRecordId id, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM protected_records WHERE id = $id;";
        command.Parameters.AddWithValue("$id", id.Value);
        var affected = await command.ExecuteNonQueryAsync(cancellationToken);
        return affected > 0;
    }

    public async Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        var now = _timeProvider.GetUtcNow();
        var detailCutoffUnixMs = now.Subtract(_retention.DetailRetention).ToUnixTimeMilliseconds();
        var rollupCutoffUnixMs = now.Subtract(_retention.HourlyRollupRetention).ToUnixTimeMilliseconds();
        var batchSize = _retention.PruneBatchSize;
        var totalDeleted = 0;

        await using var connection = await OpenConnectionAsync(cancellationToken);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var idsToDelete = new List<string>();
            await using (var selectCommand = connection.CreateCommand())
            {
                selectCommand.CommandText = """
                    SELECT id FROM protected_records
                    WHERE (resolution = 'Detail' AND captured_at_unix_ms < $detailCutoff)
                       OR (resolution = 'HourlyRollup' AND captured_at_unix_ms < $rollupCutoff)
                    LIMIT $batchSize;
                    """;
                selectCommand.Parameters.AddWithValue("$detailCutoff", detailCutoffUnixMs);
                selectCommand.Parameters.AddWithValue("$rollupCutoff", rollupCutoffUnixMs);
                selectCommand.Parameters.AddWithValue("$batchSize", batchSize);
                await using var reader = await selectCommand.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    idsToDelete.Add(reader.GetString(0));
                }
            }

            if (idsToDelete.Count == 0)
            {
                break;
            }

            await using (var deleteCommand = connection.CreateCommand())
            {
                var parameterNames = new string[idsToDelete.Count];
                for (var i = 0; i < idsToDelete.Count; i++)
                {
                    var parameterName = $"$id{i}";
                    parameterNames[i] = parameterName;
                    deleteCommand.Parameters.AddWithValue(parameterName, idsToDelete[i]);
                }

                deleteCommand.CommandText =
                    $"DELETE FROM protected_records WHERE id IN ({string.Join(",", parameterNames)});";
                totalDeleted += await deleteCommand.ExecuteNonQueryAsync(cancellationToken);
            }

            if (idsToDelete.Count < batchSize)
            {
                break;
            }
        }

        return totalDeleted;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _keyRing.Dispose();
        _disposed = true;
    }

    private void EnsureInitialized()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (Volatile.Read(ref _ready) == 0)
        {
            throw new InvalidOperationException(
                "Protected storage has not completed EnsureReadyAsync. Call it during startup before use.");
        }
    }

    private async Task<SqliteConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }
}
