using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Edge.Envelope;

public sealed record AtlasObservationV1(
    AtlasSnapshotV1 Snapshot,
    AtlasCollectorStatusV1 Status);

public sealed record QueryStoreObservationV1(
    QueryStoreCollectorStatusV1 Status,
    IReadOnlyList<QueryFamilyDetailV1> Families,
    IReadOnlyList<NormalizedShowplanV1> Plans);

public sealed record DatabaseCityObservationV1(
    DatabaseCitySummarySnapshotV1 Summaries,
    IReadOnlyList<DatabaseCityPageV1> Pages);
