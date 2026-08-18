using Microsoft.AspNetCore.SignalR;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// A minimal, hand-rolled <see cref="IHubContext{THub}"/> fake that records every payload sent to
/// "all clients" so a test can assert on broadcast content and count without a real SignalR
/// transport. Every other member throws <see cref="NotSupportedException"/> because
/// <see cref="LiveIncidentSamplerService"/> only ever calls <c>Clients.All.SendAsync(...)</c>.
/// </summary>
internal sealed class RecordingHubContext : IHubContext<CurrentSnapshotHub>
{
    private readonly Func<CancellationToken, Task>? _onSend;
    private readonly List<(string Method, object?[] Args)> _sent = [];

    /// <summary>
    /// A point-in-time copy of every payload broadcast so far. The sampler appends from its own
    /// background loop, so this snapshots under the same lock the writer takes; handing out the
    /// live list let callers enumerate it mid-<c>Add</c> (throwing "Collection was modified") or
    /// read a count without the element it refers to.
    /// </summary>
    public IReadOnlyList<(string Method, object?[] Args)> Sent
    {
        get
        {
            lock (_sent)
            {
                return _sent.ToArray();
            }
        }
    }

    public IHubClients Clients { get; }

    public IGroupManager Groups => throw new NotSupportedException();

    public RecordingHubContext(Func<CancellationToken, Task>? onSend = null)
    {
        _onSend = onSend;
        Clients = new RecordingHubClients(this);
    }

    private sealed class RecordingHubClients(RecordingHubContext owner) : IHubClients
    {
        public IClientProxy All { get; } = new RecordingClientProxy(owner);

        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => throw new NotSupportedException();

        public IClientProxy Client(string connectionId) => throw new NotSupportedException();

        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => throw new NotSupportedException();

        public IClientProxy Group(string groupName) => throw new NotSupportedException();

        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => throw new NotSupportedException();

        public IClientProxy Groups(IReadOnlyList<string> groupNames) => throw new NotSupportedException();

        public IClientProxy OthersInGroup(string groupName) => throw new NotSupportedException();

        public IClientProxy User(string userId) => throw new NotSupportedException();

        public IClientProxy Users(IReadOnlyList<string> userIds) => throw new NotSupportedException();
    }

    private sealed class RecordingClientProxy(RecordingHubContext owner) : IClientProxy
    {
        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
        {
            lock (owner._sent)
            {
                owner._sent.Add((method, args));
            }

            return owner._onSend?.Invoke(cancellationToken) ?? Task.CompletedTask;
        }
    }
}
