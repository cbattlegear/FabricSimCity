namespace SqlSimCity.Collection.Catalog;

/// <summary>
/// Thrown when the embedded SQL probe catalog fails startup validation. This must always
/// prevent the process from becoming ready -- see <see cref="ProbeCatalog.Load"/>.
/// </summary>
public sealed class ProbeCatalogException : Exception
{
    public ProbeCatalogException(string message) : base(message)
    {
    }

    public ProbeCatalogException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
