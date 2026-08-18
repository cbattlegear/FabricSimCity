using SqlSimCity.Edge.Connector;
using SqlSimCity.Storage;

namespace SqlSimCity.Edge.Tests;

public sealed class VolatileProtectedRecordStoreTests
{
    [Fact]
    public async Task ReplaceAndDisposeZeroOwnedPayloads()
    {
        var zeroed = new List<byte[]>();
        var store = new VolatileProtectedRecordStore(
            maxPayloadBytes: 64, maxItems: 4, maxTotalBytes: 256,
            onZeroed: payload => zeroed.Add(payload));
        var id = new ProtectedRecordId("record");
        await store.PutAsync(
            id, "kind", DateTimeOffset.UnixEpoch, StorageResolution.Detail, new byte[] { 1, 2, 3 });
        await store.PutAsync(
            id, "kind", DateTimeOffset.UnixEpoch, StorageResolution.Detail, new byte[] { 4, 5, 6 });

        Assert.Single(zeroed);
        Assert.All(zeroed[0], value => Assert.Equal(0, value));

        store.Dispose();
        Assert.Equal(2, zeroed.Count);
        Assert.All(zeroed[1], value => Assert.Equal(0, value));
        await Assert.ThrowsAsync<ObjectDisposedException>(() => store.GetAsync(id));
    }

    [Fact]
    public async Task BoundsAreEnforcedBeforeMutation()
    {
        using var store = new VolatileProtectedRecordStore(maxPayloadBytes: 4, maxItems: 1);
        await store.PutAsync(
            new ProtectedRecordId("one"), "kind", DateTimeOffset.UnixEpoch,
            StorageResolution.Detail, new byte[] { 1, 2, 3, 4 });

        await Assert.ThrowsAsync<InvalidOperationException>(() => store.PutAsync(
            new ProtectedRecordId("two"), "kind", DateTimeOffset.UnixEpoch,
            StorageResolution.Detail, new byte[] { 1 }));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => store.PutAsync(
            new ProtectedRecordId("one"), "kind", DateTimeOffset.UnixEpoch,
            StorageResolution.Detail, new byte[] { 1, 2, 3, 4, 5 }));

        using var current = await store.GetAsync(new ProtectedRecordId("one"));
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, current!.Payload.ToArray());
    }

    [Fact]
    public async Task RejectedOwnedCopyIsZeroed()
    {
        var zeroed = new List<byte[]>();
        using var store = new VolatileProtectedRecordStore(
            maxPayloadBytes: 4,
            maxItems: 1,
            maxTotalBytes: 4,
            onZeroed: payload => zeroed.Add(payload));
        await store.PutAsync(
            new ProtectedRecordId("one"), "kind", DateTimeOffset.UnixEpoch,
            StorageResolution.Detail, new byte[] { 1 });

        await Assert.ThrowsAsync<InvalidOperationException>(() => store.PutAsync(
            new ProtectedRecordId("two"), "kind", DateTimeOffset.UnixEpoch,
            StorageResolution.Detail, new byte[] { 9, 8 }));

        Assert.Single(zeroed);
        Assert.All(zeroed[0], value => Assert.Equal(0, value));
    }

    [Fact]
    public async Task ReplacementBoundsAreAppliedWhileStaging()
    {
        var zeroed = new List<byte[]>();
        using var store = new VolatileProtectedRecordStore(
            maxPayloadBytes: 4,
            maxItems: 1,
            maxTotalBytes: 4,
            onZeroed: payload => zeroed.Add(payload));
        var writes = new[]
        {
            new ProtectedRecordWrite(
                new ProtectedRecordId("set:one"), "kind", DateTimeOffset.UnixEpoch,
                StorageResolution.Detail, new byte[] { 1 }),
            new ProtectedRecordWrite(
                new ProtectedRecordId("set:two"), "kind", DateTimeOffset.UnixEpoch,
                StorageResolution.Detail, new byte[] { 2 }),
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.ReplaceSetAsync("set:", writes));

        Assert.Single(zeroed);
        Assert.All(zeroed[0], value => Assert.Equal(0, value));
        Assert.Null(await store.GetAsync(new ProtectedRecordId("set:one")));
    }
}
