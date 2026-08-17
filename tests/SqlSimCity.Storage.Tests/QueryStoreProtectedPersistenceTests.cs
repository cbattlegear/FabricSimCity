using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

public sealed class QueryStoreProtectedPersistenceTests
{
    [Fact]
    public async Task QueryTextPlanAndSnapshotsLeaveNoPlaintextMarkers()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory, "query-store-persistence", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            using var ring = new KeyRing(1, new Dictionary<uint, byte[]> { [1] = key });
            using (var store = new SqliteProtectedRecordStore(
                       directory, "history.db", ring, new RetentionOptions(), TimeProvider.System))
            {
                await store.EnsureReadyAsync();
                var repository = new ProtectedQueryStoreRepository(store);
                await repository.StoreQueryTextAsync("db", "text", DateTimeOffset.UtcNow,
                    "QUERY_TEXT_PRIVATE_MARKER");
                await repository.StorePlanXmlAsync("db", "plan", DateTimeOffset.UtcNow,
                    "<ShowPlanXML PRIVATE_PLAN_MARKER='yes' />");
                await repository.PublishSnapshotAsync(new QueryStorePublishedSnapshot(
                    "1.0", "PRIVATE_SNAPSHOT_MARKER", 1, DateTimeOffset.UtcNow, [],
                    new("1.0", QueryStoreCollectorState.Ready, 1,
                        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, null, [], "PRIVATE_STATUS_MARKER")));
            }

            foreach (var path in Directory.EnumerateFiles(directory))
            {
                var persisted = Encoding.Latin1.GetString(await File.ReadAllBytesAsync(path));
                Assert.DoesNotContain("QUERY_TEXT_PRIVATE_MARKER", persisted, StringComparison.Ordinal);
                Assert.DoesNotContain("PRIVATE_PLAN_MARKER", persisted, StringComparison.Ordinal);
                Assert.DoesNotContain("PRIVATE_SNAPSHOT_MARKER", persisted, StringComparison.Ordinal);
                Assert.DoesNotContain("PRIVATE_STATUS_MARKER", persisted, StringComparison.Ordinal);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            Directory.Delete(directory, recursive: true);
        }
    }
}
