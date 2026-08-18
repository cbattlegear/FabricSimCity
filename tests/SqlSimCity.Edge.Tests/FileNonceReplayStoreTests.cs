using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Edge.Tests;

public sealed class FileNonceReplayStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "sqlsimcity-nonce-" + Guid.NewGuid().ToString("N") + ".log");

    [Fact]
    public void First_use_registers_and_duplicate_is_rejected()
    {
        using var store = new FileNonceReplayStore(_path);
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        Assert.True(store.TryRegister("c", "nonce-1", expiry));
        Assert.False(store.TryRegister("c", "nonce-1", expiry));
    }

    [Fact]
    public void Replay_protection_survives_restart()
    {
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        using (var store = new FileNonceReplayStore(_path))
            Assert.True(store.TryRegister("c", "nonce-1", expiry));

        using var reopened = new FileNonceReplayStore(_path);
        Assert.False(reopened.TryRegister("c", "nonce-1", expiry));
    }

    [Fact]
    public void Different_connectors_do_not_collide()
    {
        using var store = new FileNonceReplayStore(_path);
        var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
        Assert.True(store.TryRegister("a", "shared", expiry));
        Assert.True(store.TryRegister("b", "shared", expiry));
    }

    public void Dispose()
    {
        if (File.Exists(_path))
            File.Delete(_path);
    }
}
