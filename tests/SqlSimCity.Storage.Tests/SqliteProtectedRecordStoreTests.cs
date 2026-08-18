using System.Buffers.Binary;
using System.Text;
using Microsoft.Data.Sqlite;
using SqlSimCity.Storage.Crypto;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

using SqlSimCity.Storage;

public sealed class SqliteProtectedRecordStoreTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-storage-tests", Guid.NewGuid().ToString("N"));

    private const string DbFileName = "protected-storage.db";

    public void Dispose()
    {
        // Force a WAL checkpoint isn't needed for cleanup; just best-effort delete.
        if (Directory.Exists(_directory))
        {
            try
            {
                Directory.Delete(_directory, recursive: true);
            }
            catch (IOException)
            {
                // A lingering SQLite handle can transiently hold the file open on Windows; not test-critical.
            }
        }
    }

    private static KeyRing NewRing(uint version, byte[] key) =>
        new(version, new Dictionary<uint, byte[]> { [version] = key });

    private static KeyRing NewRing(uint activeVersion, IReadOnlyDictionary<uint, byte[]> keys) =>
        new(activeVersion, keys);

    private SqliteProtectedRecordStore NewStore(KeyRing keyRing, TimeProvider? timeProvider = null, RetentionOptions? retention = null) =>
        new(_directory, DbFileName, keyRing, retention ?? new RetentionOptions(), timeProvider ?? TimeProvider.System);

    private string DbPath => Path.Combine(_directory, DbFileName);

    private string RawConnectionString =>
        new SqliteConnectionStringBuilder { DataSource = DbPath, Pooling = false }.ToString();

    [Fact]
    public async Task RoundTripsPutAndGet()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();

        var payload = Encoding.UTF8.GetBytes("query-store-sample-json-payload");
        var capturedAt = new DateTimeOffset(2026, 8, 17, 12, 0, 0, TimeSpan.Zero);
        await store.PutAsync("record-1", "query-store-sample", capturedAt, StorageResolution.Detail, payload);

        var result = await store.GetAsync("record-1");

        Assert.NotNull(result);
        Assert.Equal("record-1", result!.Id.Value);
        Assert.Equal("query-store-sample", result.RecordKind);
        Assert.Equal(capturedAt, result.CapturedAt);
        Assert.Equal(StorageResolution.Detail, result.Resolution);
        Assert.Equal(payload, result.Payload.ToArray());
    }

    [Fact]
    public async Task GetReturnsNullForUnknownId()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();

        var result = await store.GetAsync("does-not-exist");

        Assert.Null(result);
    }

    [Fact]
    public async Task DeleteRemovesRecordAndReportsWhetherItExisted()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        var firstDelete = await store.DeleteAsync("record-1");
        var secondDelete = await store.DeleteAsync("record-1");

        Assert.True(firstDelete);
        Assert.False(secondDelete);
        Assert.Null(await store.GetAsync("record-1"));
    }

    [Fact]
    public async Task NoPlaintextBytesReachTheSqliteFile()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();

        const string secretMarker = "unmistakable-secret-marker-4b7e91";
        await store.PutAsync(
            "record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, Encoding.UTF8.GetBytes(secretMarker));

        await CheckpointAsync();

        foreach (var candidate in new[] { DbPath, DbPath + "-wal", DbPath + "-shm" })
        {
            if (!File.Exists(candidate))
            {
                continue;
            }

            var bytes = await File.ReadAllBytesAsync(candidate);
            var text = Encoding.Latin1.GetString(bytes);
            Assert.DoesNotContain(secretMarker, text, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task FreshStoreCreatesCanaryAndExistingStoreVerifiesIt()
    {
        var keyBytes = KeyRingTestHelpers.NewKeyBytes();

        using (var keyRing = NewRing(1, keyBytes))
        {
            var store = NewStore(keyRing);
            await store.EnsureReadyAsync(); // fresh: creates the canary
        }

        Assert.Equal(1, await CountRowsAsync("storage_canary"));

        using (var keyRing = NewRing(1, keyBytes))
        {
            var store = NewStore(keyRing);
            await store.EnsureReadyAsync(); // existing: verifies the canary, does not duplicate it
        }

        Assert.Equal(1, await CountRowsAsync("storage_canary"));
    }

    [Fact]
    public async Task WrongKeyOnExistingStoreFailsReadyCheck()
    {
        using (var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes()))
        {
            var store = NewStore(keyRing);
            await store.EnsureReadyAsync();
        }

        var wrongKeyBytes = KeyRingTestHelpers.NewKeyBytes();
        using var wrongRing = NewRing(1, wrongKeyBytes);
        var storeWithWrongKey = NewStore(wrongRing);

        var ex = await Assert.ThrowsAsync<CanaryVerificationException>(() => storeWithWrongKey.EnsureReadyAsync());
        Assert.DoesNotContain(KeyRingTestHelpers.ToBase64(wrongKeyBytes), ex.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task MissingKeyVersionOnExistingStoreFailsReadyCheck()
    {
        using (var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes()))
        {
            var store = NewStore(keyRing);
            await store.EnsureReadyAsync();
        }

        using var ringWithoutVersion1 = NewRing(2, KeyRingTestHelpers.NewKeyBytes());
        var storeMissingVersion = NewStore(ringWithoutVersion1);

        await Assert.ThrowsAsync<CanaryVerificationException>(() => storeMissingVersion.EnsureReadyAsync());
    }

    [Fact]
    public async Task ActiveAndOldKeyVersionsBothDecryptAndNewWritesUseActiveVersion()
    {
        var key1 = KeyRingTestHelpers.NewKeyBytes();
        var oldPayload = Encoding.UTF8.GetBytes("payload-from-before-rotation");

        using (var ringV1 = NewRing(1, key1))
        {
            var store = NewStore(ringV1);
            await store.EnsureReadyAsync();
            await store.PutAsync("old-record", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, oldPayload);
        }

        var key2 = KeyRingTestHelpers.NewKeyBytes();
        using var rotatedRing = NewRing(2, new Dictionary<uint, byte[]> { [1] = key1, [2] = key2 });
        var rotatedStore = NewStore(rotatedRing);
        await rotatedStore.EnsureReadyAsync();

        var oldRecord = await rotatedStore.GetAsync("old-record");
        Assert.NotNull(oldRecord);
        Assert.Equal(oldPayload, oldRecord!.Payload.ToArray());

        await rotatedStore.PutAsync(
            "new-record", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "new-payload"u8.ToArray());
        var newRecord = await rotatedStore.GetAsync("new-record");
        Assert.NotNull(newRecord);

        var newRecordKeyVersion = await ReadEnvelopeKeyVersionAsync("new-record");
        var oldRecordKeyVersion = await ReadEnvelopeKeyVersionAsync("old-record");
        Assert.Equal(2u, newRecordKeyVersion);
        Assert.Equal(1u, oldRecordKeyVersion);
    }

    [Fact]
    public async Task TamperedNonceCausesGetToFail()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        await TamperEnvelopeByteAsync("record-1", offset: 5); // first nonce byte

        await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-1"));
    }

    [Fact]
    public async Task TamperedTagCausesGetToFail()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        await TamperEnvelopeByteAsync("record-1", offset: 17); // first tag byte

        await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-1"));
    }

    [Fact]
    public async Task TamperedCiphertextCausesGetToFail()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload-bytes"u8.ToArray());

        await TamperEnvelopeByteAsync("record-1", offset: 33); // first ciphertext byte

        await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-1"));
    }

    [Fact]
    public async Task CrossRecordCiphertextSwapIsRejected()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();
        await store.PutAsync("record-a", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload-a"u8.ToArray());
        await store.PutAsync("record-b", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload-b"u8.ToArray());

        var envelopeA = await ReadEnvelopeAsync("record-a");
        await WriteEnvelopeAsync("record-b", envelopeA); // move record A's ciphertext onto record B's row

        await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-b"));
    }

    [Fact]
    public async Task SchemaMigrationIsIdempotent()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);

        await store.EnsureReadyAsync();
        await store.EnsureReadyAsync();
        await store.EnsureReadyAsync();

        Assert.Equal(SqliteSchema.CurrentSchemaVersion, await GetUserVersionAsync());
        Assert.Equal(1, await CountRowsAsync("storage_canary"));
    }

    [Fact]
    public async Task UseBeforeEnsureReadyThrows()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "x"u8.ToArray()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.GetAsync("record-1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.DeleteAsync("record-1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.PruneExpiredAsync());
    }

    [Fact]
    public async Task ConcurrentPutsAndGetsSucceedWithoutCorruption()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing);
        await store.EnsureReadyAsync();

        var ids = Enumerable.Range(0, 25).Select(i => $"record-{i}").ToArray();
        await Task.WhenAll(ids.Select(id => store.PutAsync(
            id, "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, Encoding.UTF8.GetBytes($"payload-{id}"))));

        var results = await Task.WhenAll(ids.Select(id => store.GetAsync(id)));

        Assert.All(results, Assert.NotNull);
        for (var i = 0; i < ids.Length; i++)
        {
            Assert.Equal($"payload-{ids[i]}", Encoding.UTF8.GetString(results[i]!.Payload.Span));
        }
    }

    [Fact]
    public async Task PruneExpiredRemovesOnlyRecordsPastTheirResolutionWindowAndKeepsCanary()
    {
        var clock = new TestTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var retention = new RetentionOptions
        {
            DetailRetention = TimeSpan.FromDays(7),
            HourlyRollupRetention = TimeSpan.FromDays(90),
            PruneBatchSize = 2,
        };
        var store = NewStore(keyRing, clock, retention);
        await store.EnsureReadyAsync();

        var now = clock.GetUtcNow();
        // Detail: two expired (older than 7 days), one still fresh.
        await store.PutAsync("detail-expired-1", "kind", now - TimeSpan.FromDays(8), StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("detail-expired-2", "kind", now - TimeSpan.FromDays(10), StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("detail-expired-3", "kind", now - TimeSpan.FromDays(30), StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("detail-fresh", "kind", now - TimeSpan.FromDays(1), StorageResolution.Detail, "x"u8.ToArray());
        // HourlyRollup: one expired (older than 90 days), one still fresh.
        await store.PutAsync("rollup-expired", "kind", now - TimeSpan.FromDays(91), StorageResolution.HourlyRollup, "x"u8.ToArray());
        await store.PutAsync("rollup-fresh", "kind", now - TimeSpan.FromDays(10), StorageResolution.HourlyRollup, "x"u8.ToArray());

        var deletedCount = await store.PruneExpiredAsync();

        Assert.Equal(retention.PruneBatchSize, deletedCount);
        Assert.Equal(2, await CountRowsAsync("protected_records", expiredOnly: true, clock, retention));

        var secondDeletedCount = await store.PruneExpiredAsync();
        Assert.Equal(2, secondDeletedCount);
        Assert.Null(await store.GetAsync("detail-expired-1"));
        Assert.Null(await store.GetAsync("detail-expired-2"));
        Assert.Null(await store.GetAsync("detail-expired-3"));
        Assert.Null(await store.GetAsync("rollup-expired"));
        Assert.NotNull(await store.GetAsync("detail-fresh"));
        Assert.NotNull(await store.GetAsync("rollup-fresh"));
        Assert.Equal(1, await CountRowsAsync("storage_canary"));
    }

    [Fact]
    public async Task PruneExpiredAtExactBoundaryKeepsRecordAtCutoff()
    {
        var clock = new TestTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = NewStore(keyRing, clock, new RetentionOptions { DetailRetention = TimeSpan.FromDays(7) });
        await store.EnsureReadyAsync();

        var cutoffExactly = clock.GetUtcNow() - TimeSpan.FromDays(7);
        var justPastCutoff = cutoffExactly - TimeSpan.FromMilliseconds(1);
        await store.PutAsync("at-cutoff", "kind", cutoffExactly, StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("past-cutoff", "kind", justPastCutoff, StorageResolution.Detail, "x"u8.ToArray());

        await store.PruneExpiredAsync();

        Assert.NotNull(await store.GetAsync("at-cutoff")); // captured_at < cutoff is the deletion rule; equal is kept
        Assert.Null(await store.GetAsync("past-cutoff"));
    }

    [Fact]
    public async Task RejectsOversizedRecordKindAndPayloadWithoutIncludingPayloadInError()
    {
        using var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var store = new SqliteProtectedRecordStore(
            _directory, DbFileName, keyRing, new RetentionOptions(), TimeProvider.System,
            maxRecordKindLength: 4, maxPayloadBytes: 3);
        await store.EnsureReadyAsync();

        await store.PutAsync("at-limits", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "abc"u8.ToArray());
        Assert.NotNull(await store.GetAsync("at-limits"));
        await Assert.ThrowsAsync<ArgumentException>(
            () => store.PutAsync("kind-too-long", "hello", DateTimeOffset.UtcNow, StorageResolution.Detail, "x"u8.ToArray()));
        var ex = await Assert.ThrowsAsync<ArgumentException>(
            () => store.PutAsync("payload-too-large", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "secret"u8.ToArray()));

        Assert.DoesNotContain("secret", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExistingStoreAuthenticatesBeforeAnyFutureMigrationHook()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        using (var validRing = NewRing(1, key))
        {
            var store = NewStore(validRing);
            await store.EnsureReadyAsync();
        }

        using var wrongRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        var migrationRan = false;

        await Assert.ThrowsAsync<CanaryVerificationException>(() => SqliteSchema.EnsureReadyAsync(
            connection, wrongRing, TimeProvider.System, CancellationToken.None,
            (_, _, _) =>
            {
                migrationRan = true;
                return Task.CompletedTask;
            }));

        Assert.False(migrationRan);
    }

    [Fact]
    public async Task ExistingSchemaWithoutCanaryFailsInsteadOfCreatingOne()
    {
        using (var keyRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes()))
        {
            var store = NewStore(keyRing);
            await store.EnsureReadyAsync();
        }

        await using (var connection = new SqliteConnection(RawConnectionString))
        {
            await connection.OpenAsync();
            await using var deleteCanary = connection.CreateCommand();
            deleteCanary.CommandText = "DELETE FROM storage_canary;";
            await deleteCanary.ExecuteNonQueryAsync();
        }

        using var replacementRing = NewRing(1, KeyRingTestHelpers.NewKeyBytes());
        var replacementStore = NewStore(replacementRing);
        await Assert.ThrowsAsync<CanaryVerificationException>(() => replacementStore.EnsureReadyAsync());
        Assert.Equal(0, await CountRowsAsync("storage_canary"));
    }

    private async Task CheckpointAsync()
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA wal_checkpoint(FULL);";
        await command.ExecuteNonQueryAsync();
    }

    private async Task<long> CountRowsAsync(
        string table,
        bool expiredOnly = false,
        TestTimeProvider? clock = null,
        RetentionOptions? retention = null)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = expiredOnly
            ? """
                SELECT COUNT(*) FROM protected_records
                WHERE (resolution = 'Detail' AND captured_at_unix_ms < $detailCutoff)
                   OR (resolution = 'HourlyRollup' AND captured_at_unix_ms < $rollupCutoff);
                """
            : $"SELECT COUNT(*) FROM {table};";
        if (expiredOnly)
        {
            ArgumentNullException.ThrowIfNull(clock);
            ArgumentNullException.ThrowIfNull(retention);
            command.Parameters.AddWithValue("$detailCutoff", (clock.GetUtcNow() - retention.DetailRetention).ToUnixTimeMilliseconds());
            command.Parameters.AddWithValue("$rollupCutoff", (clock.GetUtcNow() - retention.HourlyRollupRetention).ToUnixTimeMilliseconds());
        }

        return (long)(await command.ExecuteScalarAsync())!;
    }

    private async Task<long> GetUserVersionAsync()
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version;";
        return Convert.ToInt64(await command.ExecuteScalarAsync(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private async Task<byte[]> ReadEnvelopeAsync(string id)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT envelope FROM protected_records WHERE id = $id;";
        command.Parameters.AddWithValue("$id", id);
        return (byte[])(await command.ExecuteScalarAsync())!;
    }

    private async Task<uint> ReadEnvelopeKeyVersionAsync(string id)
    {
        var envelope = await ReadEnvelopeAsync(id);
        return BinaryPrimitives.ReadUInt32BigEndian(envelope.AsSpan(1, 4));
    }

    private async Task WriteEnvelopeAsync(string id, byte[] envelope)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE protected_records SET envelope = $envelope WHERE id = $id;";
        command.Parameters.AddWithValue("$envelope", envelope);
        command.Parameters.AddWithValue("$id", id);
        await command.ExecuteNonQueryAsync();
    }

    private async Task TamperEnvelopeByteAsync(string id, int offset)
    {
        var envelope = await ReadEnvelopeAsync(id);
        envelope[offset] ^= 0xFF;
        await WriteEnvelopeAsync(id, envelope);
    }
}
