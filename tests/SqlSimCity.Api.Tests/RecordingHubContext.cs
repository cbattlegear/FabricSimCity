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
    public List<(string Method, object?[] Args)> Sent { get; } = [];

    public IHubClients Clients { get; }

    public IGroupManager Groups => throw new NotSupportedException();

    public RecordingHubContext()
    {
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
            lock (owner.Sent)
            {
                owner.Sent.Add((method, args));
            }

            return Task.CompletedTask;
        }
    }
}
