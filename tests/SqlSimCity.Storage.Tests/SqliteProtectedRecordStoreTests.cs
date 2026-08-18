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

    private SqliteProtectedRecordStore NewStore(TimeProvider? timeProvider = null, RetentionOptions? retention = null) =>
        new(_directory, DbFileName, retention ?? new RetentionOptions(), timeProvider ?? TimeProvider.System);

    private string DbPath => Path.Combine(_directory, DbFileName);

    private string RawConnectionString =>
        new SqliteConnectionStringBuilder { DataSource = DbPath, Pooling = false }.ToString();

    [Fact]
    public async Task RoundTripsPutAndGet()
    {
        var store = NewStore();
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
        var store = NewStore();
        await store.EnsureReadyAsync();

        var result = await store.GetAsync("does-not-exist");

        Assert.Null(result);
    }

    [Fact]
    public async Task DeleteRemovesRecordAndReportsWhetherItExisted()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        var firstDelete = await store.DeleteAsync("record-1");
        var secondDelete = await store.DeleteAsync("record-1");

        Assert.True(firstDelete);
        Assert.False(secondDelete);
        Assert.Null(await store.GetAsync("record-1"));
    }

    [Fact]
    public async Task PayloadBytesAreReadableInTheSqliteFile()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();

        // Captured evidence is stored in the clear on purpose: the point of this tool is to show
        // plans and query text, and an operator must be able to read the store with sqlite3.
        const string marker = "SELECT * FROM dbo.Customer WHERE Email = @p0";
        await store.PutAsync(
            "record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, Encoding.UTF8.GetBytes(marker));

        await CheckpointAsync();

        var found = new[] { DbPath, DbPath + "-wal", DbPath + "-shm" }
            .Where(File.Exists)
            .Select(candidate => Encoding.Latin1.GetString(File.ReadAllBytes(candidate)))
            .Any(text => text.Contains(marker, StringComparison.Ordinal));
        Assert.True(found, "The payload should be readable in the SQLite database or its WAL.");
    }

    [Fact]
    public async Task FreshStoreCreatesCanaryAndExistingStoreVerifiesIt()
    {
        var store = NewStore();
        await store.EnsureReadyAsync(); // fresh: creates the canary

        Assert.Equal(1, await CountRowsAsync("storage_canary"));

        var reopened = NewStore();
        await reopened.EnsureReadyAsync(); // existing: verifies the canary, does not duplicate it

        Assert.Equal(1, await CountRowsAsync("storage_canary"));
    }

    [Fact]
    public async Task ACanaryFromAnotherFormatFailsTheReadyCheck()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await ReplaceCanaryEnvelopeAsync([1, .. new byte[32], .. "ciphertext"u8]);

        var reopened = NewStore();

        await Assert.ThrowsAsync<CanaryVerificationException>(() => reopened.EnsureReadyAsync());
    }

    [Fact]
    public async Task AnEncryptedRecordFromAnEarlierBuildIsReportedRatherThanReturnedAsPayload()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await store.PutAsync(
            "record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        // Reproduce a row as the encrypting builds wrote it. Only the version byte decides the
        // read path, so stamping it is enough to prove the store refuses rather than returning
        // ciphertext and a header as if they were the collected evidence.
        await WriteEnvelopeAsync("record-1", [1, .. new byte[32], .. "ciphertext"u8]);

        var error = await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-1"));
        Assert.Contains("encrypted protected storage", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownEnvelopeVersionFailsInsteadOfBeingTreatedAsPayload()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await store.PutAsync(
            "record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        await TamperEnvelopeByteAsync("record-1", offset: 0);

        await Assert.ThrowsAsync<EnvelopeIntegrityException>(() => store.GetAsync("record-1"));
    }

    [Fact]
    public async Task SchemaMigrationIsIdempotent()
    {
        var store = NewStore();

        await store.EnsureReadyAsync();
        await store.EnsureReadyAsync();
        await store.EnsureReadyAsync();

        Assert.Equal(SqliteSchema.CurrentSchemaVersion, await GetUserVersionAsync());
        Assert.Equal(1, await CountRowsAsync("storage_canary"));
    }

    [Fact]
    public async Task UseBeforeEnsureReadyThrows()
    {
        var store = NewStore();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "x"u8.ToArray()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.GetAsync("record-1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.DeleteAsync("record-1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.PruneExpiredAsync());
    }

    [Fact]
    public async Task ConcurrentPutsAndGetsSucceedWithoutCorruption()
    {
        var store = NewStore();
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
        var retention = new RetentionOptions
        {
            DetailRetention = TimeSpan.FromDays(7),
            HourlyRollupRetention = TimeSpan.FromDays(90),
            PruneBatchSize = 2,
        };
        var store = NewStore(clock, retention);
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
        var store = NewStore(clock, new RetentionOptions { DetailRetention = TimeSpan.FromDays(7) });
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
        var store = new SqliteProtectedRecordStore(
            _directory, DbFileName, new RetentionOptions(), TimeProvider.System,
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
    public async Task ExistingStoreVerifiesTheCanaryBeforeAnyFutureMigrationHook()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await ReplaceCanaryEnvelopeAsync([1, .. new byte[32], .. "ciphertext"u8]);

        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        var migrationRan = false;

        await Assert.ThrowsAsync<CanaryVerificationException>(() => SqliteSchema.EnsureReadyAsync(
            connection, TimeProvider.System, CancellationToken.None,
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
        var store = NewStore();
        await store.EnsureReadyAsync();

        await using (var connection = new SqliteConnection(RawConnectionString))
        {
            await connection.OpenAsync();
            await using var deleteCanary = connection.CreateCommand();
            deleteCanary.CommandText = "DELETE FROM storage_canary;";
            await deleteCanary.ExecuteNonQueryAsync();
        }

        var replacementStore = NewStore();
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

    /// <summary>
    /// Overwrites the canary payload so a store written in another format can be reproduced
    /// without the test project having to reimplement a retired codec.
    /// </summary>
    private async Task ReplaceCanaryEnvelopeAsync(byte[] envelope)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE storage_canary SET envelope = $envelope WHERE id = 1;";
        command.Parameters.AddWithValue("$envelope", envelope);
        await command.ExecuteNonQueryAsync();
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
