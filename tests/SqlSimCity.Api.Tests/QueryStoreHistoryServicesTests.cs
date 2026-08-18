using Microsoft.AspNetCore.SignalR;

namespace SqlSimCity.Api.Tests;

public sealed class QueryStoreHistoryServicesTests
{
    [Fact]
    public async Task NotificationTimeoutCancelsUnderlyingSignalRSend()
    {
        var context = new CancelAwareHubContext();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            QueryStoreHistoryBackgroundService.NotifyAsync(
                context, "snapshot", new { Sequence = 1 }, TimeSpan.FromMilliseconds(20), default));

        Assert.True(context.Proxy.CancellationObserved);
    }

    private sealed class CancelAwareHubContext : IHubContext<CurrentSnapshotHub>
    {
        public CancelAwareClientProxy Proxy { get; } = new();
        public IHubClients Clients => new HubClients(Proxy);
        public IGroupManager Groups { get; } = new NoOpGroupManager();
    }

    private sealed class HubClients(IClientProxy proxy) : IHubClients
    {
        public IClientProxy All => proxy;
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => proxy;
        public IClientProxy Client(string connectionId) => proxy;
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => proxy;
        public IClientProxy Group(string groupName) => proxy;
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => proxy;
        public IClientProxy Groups(IReadOnlyList<string> groupNames) => proxy;
        public IClientProxy User(string userId) => proxy;
        public IClientProxy Users(IReadOnlyList<string> userIds) => proxy;
    }

    private sealed class CancelAwareClientProxy : IClientProxy
    {
        public bool CancellationObserved { get; private set; }

        public async Task SendCoreAsync(
            string method,
            object?[] args,
            CancellationToken cancellationToken = default)
        {
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                CancellationObserved = true;
                throw;
            }
        }
    }

    private sealed class NoOpGroupManager : IGroupManager
    {
        public Task AddToGroupAsync(
            string connectionId,
            string groupName,
            CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task RemoveFromGroupAsync(
            string connectionId,
            string groupName,
            CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
