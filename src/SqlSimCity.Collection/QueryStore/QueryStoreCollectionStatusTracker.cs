using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public sealed class QueryStoreCollectionStatusTracker
{
    private QueryStoreCollectorStatusV1? _current;

    public QueryStoreCollectorStatusV1? Current => Volatile.Read(ref _current);

    public void Set(QueryStoreCollectorStatusV1 value)
    {
        ArgumentNullException.ThrowIfNull(value);
        Volatile.Write(ref _current, value);
    }
}
