using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public interface IAtlasSnapshotSource
{
    AtlasSnapshotV1 GetCurrent();
}
