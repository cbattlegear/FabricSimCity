using System.Text;
using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Collection.Tests.Catalog;

/// <summary>
/// An in-memory <see cref="IProbeCatalogResourceSource"/> a test builds by hand, so catalog
/// tampering (missing files, duplicate ids, unsafe paths, parameter mismatches, undocumented
/// enum values, ...) can be exercised deterministically without a real compiled assembly per case.
/// </summary>
public sealed class FakeProbeCatalogResourceSource : IProbeCatalogResourceSource
{
    private readonly Dictionary<string, string> _resources = new(StringComparer.Ordinal);

    public FakeProbeCatalogResourceSource With(string logicalName, string content)
    {
        _resources[logicalName] = content;
        return this;
    }

    public IReadOnlyCollection<string> GetResourceNames() => _resources.Keys.ToList();

    public Stream OpenResource(string resourceName) =>
        new MemoryStream(Encoding.UTF8.GetBytes(_resources[resourceName]));

    /// <summary>A minimal manifest scaffold with the shared enum objects already populated.</summary>
    public static string BaseManifestWithProbes(string probesJsonArray) => $$"""
        {
          "manifestVersion": 1,
          "connectionScopes": { "server": {}, "database": {} },
          "cadenceClasses": { "onDemand": {}, "periodic": {} },
          "relativeCosts": { "low": {}, "medium": {}, "high": {} },
          "probes": {{probesJsonArray}}
        }
        """;

    public static string ValidProbeJson(
        string id = "test.probe",
        string file = "probes/test/probe.sql",
        string connectionScope = "server",
        string cadenceClass = "onDemand",
        string relativeCost = "low",
        string parametersJson = "[]",
        string? versionVariantOf = null,
        string? versionVariantNotes = null)
    {
        var variant = versionVariantOf is null
            ? string.Empty
            : $"""
              ,"versionVariantOf": {System.Text.Json.JsonSerializer.Serialize(versionVariantOf)},
              "versionVariantNotes": {System.Text.Json.JsonSerializer.Serialize(versionVariantNotes ?? string.Empty)}
              """;

        return $$"""
            {
              "id": {{System.Text.Json.JsonSerializer.Serialize(id)}},
              "title": "Test probe",
              "file": {{System.Text.Json.JsonSerializer.Serialize(file)}},
              "connectionScope": {{System.Text.Json.JsonSerializer.Serialize(connectionScope)}},
              "minPlatform": "SQL Server 2019",
              "azureSqlDatabase": { "unsupported": false, "notes": "Supported on Azure SQL Database." },
              "requiredPermission": "VIEW SERVER STATE",
              "cadenceClass": {{System.Text.Json.JsonSerializer.Serialize(cadenceClass)}},
              "parameters": {{parametersJson}},
              "resultSets": 1,
              "resultContract": "single-row",
              "relativeCost": {{System.Text.Json.JsonSerializer.Serialize(relativeCost)}}{{variant}}
            }
            """;
    }
}
