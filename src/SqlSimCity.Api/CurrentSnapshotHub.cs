using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

public sealed class CurrentSnapshotHub(IAtlasSnapshotSource source) : Hub
{
    public AtlasSnapshotV1 GetCurrentSnapshot() => source.GetCurrent();
}

public sealed class ApiAssemblyMarker;
