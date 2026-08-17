namespace SqlSimCity.Collection.Catalog;

/// <summary>One declared named-parameter contract for a catalog probe (see sql/manifest.json).</summary>
public sealed record ProbeParameterDefinition(
    string Name,
    string SqlDbType,
    bool Required,
    string Description,
    bool HasDefault);

/// <summary>
/// One validated entry from sql/manifest.json plus the SQL text of its referenced file, loaded
/// from this assembly's embedded resources. Every instance that exists has already passed
/// <see cref="ProbeCatalog.Load"/>'s structural validation.
/// </summary>
public sealed record ProbeDefinition(
    string Id,
    string Title,
    string File,
    string ConnectionScope,
    string MinPlatform,
    bool AzureSqlDatabaseUnsupported,
    string AzureSqlDatabaseNotes,
    string RequiredPermission,
    string CadenceClass,
    IReadOnlyList<ProbeParameterDefinition> Parameters,
    int ResultSets,
    string ResultContract,
    string RelativeCost,
    string? VersionVariantOf,
    string? VersionVariantNotes,
    string CommandText);
