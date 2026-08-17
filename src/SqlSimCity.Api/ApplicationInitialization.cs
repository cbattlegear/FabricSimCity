using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Api;

/// <summary>Fail-closed initialization that completes before the host can become ready.</summary>
public static class ApplicationInitialization
{
    public static ProbeCatalog LoadProbeCatalog(IProbeCatalogResourceSource? source = null) =>
        source is null ? ProbeCatalog.Load() : ProbeCatalog.Load(source);
}
