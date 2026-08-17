using System.Reflection;

namespace SqlSimCity.Collection.Catalog;

/// <summary>
/// The minimal file-like surface <see cref="ProbeCatalog"/> needs to load its manifest and probe
/// files. Abstracting this over a plain <see cref="Assembly"/> lets catalog validation be unit
/// tested against a fabricated in-memory catalog (missing files, duplicate ids, unsafe paths,
/// parameter mismatches, ...) without needing a real compiled assembly per test case.
/// </summary>
public interface IProbeCatalogResourceSource
{
    /// <summary>Every resource name this source can open, in whatever form the source itself uses internally.</summary>
    IReadOnlyCollection<string> GetResourceNames();

    /// <summary>Opens the resource previously returned by <see cref="GetResourceNames"/>.</summary>
    Stream OpenResource(string resourceName);
}

/// <summary>Adapts a real .NET <see cref="Assembly"/>'s embedded resources to <see cref="IProbeCatalogResourceSource"/>.</summary>
public sealed class AssemblyProbeCatalogResourceSource(Assembly assembly) : IProbeCatalogResourceSource
{
    private readonly Assembly _assembly = assembly ?? throw new ArgumentNullException(nameof(assembly));

    public IReadOnlyCollection<string> GetResourceNames() => _assembly.GetManifestResourceNames();

    public Stream OpenResource(string resourceName) =>
        _assembly.GetManifestResourceStream(resourceName)
            ?? throw new ProbeCatalogException($"Embedded resource '{resourceName}' could not be opened.");
}
