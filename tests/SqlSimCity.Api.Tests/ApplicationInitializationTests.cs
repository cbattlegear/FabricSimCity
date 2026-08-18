using SqlSimCity.Api;
using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Api.Tests;

public sealed class ApplicationInitializationTests
{
    [Fact]
    public void InvalidCatalogPreventsApplicationInitialization()
    {
        var source = new MissingCatalogSource();

        Assert.Throws<ProbeCatalogException>(() => ApplicationInitialization.LoadProbeCatalog(source));
    }

    private sealed class MissingCatalogSource : IProbeCatalogResourceSource
    {
        public IReadOnlyCollection<string> GetResourceNames() => [];

        public Stream OpenResource(string resourceName) => throw new InvalidOperationException();
    }
}
