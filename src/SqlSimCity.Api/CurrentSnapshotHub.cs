using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

public sealed class CurrentSnapshotHub(IAtlasSnapshotSource source, LiveIncidentSamplerService liveSampler) : Hub
{
    public AtlasSnapshotV1 GetCurrentSnapshot() => source.GetCurrent();

    public LiveIncidentResponseV1 GetCurrentLiveSnapshot() => liveSampler.GetCurrentResponse();
}

public sealed class ApiAssemblyMarker;
