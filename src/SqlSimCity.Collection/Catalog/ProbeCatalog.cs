using System.Reflection;
using System.Text.Json;

namespace SqlSimCity.Collection.Catalog;

/// <summary>
/// Loads and validates the embedded SQL probe catalog (<c>sql/manifest.json</c> plus every
/// referenced <c>sql/probes/**/*.sql</c> file) at process startup. Validation covers manifest
/// version support, unique probe IDs/files, safe relative file paths, file existence, declared
/// parameters matching the ones a probe file actually references, connection scopes, and
/// version-variant metadata, and the complete read-only static SQL shape. Any inconsistency throws
/// <see cref="ProbeCatalogException"/> so runtime execution fails closed even when Node CI was skipped.
/// </summary>
public sealed class ProbeCatalog
{
    /// <summary>Manifest versions this build knows how to interpret.</summary>
    public static readonly IReadOnlyList<int> SupportedManifestVersions = [1];

    private readonly IReadOnlyDictionary<string, ProbeDefinition> _probesById;

    public int ManifestVersion { get; }

    public IEnumerable<string> ProbeIds => _probesById.Keys;

    private ProbeCatalog(int manifestVersion, IReadOnlyDictionary<string, ProbeDefinition> probesById)
    {
        ManifestVersion = manifestVersion;
        _probesById = probesById;
    }

    /// <summary>Looks up a validated probe by its manifest <c>id</c>, throwing if it is unknown.</summary>
    public ProbeDefinition Get(string id)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        return _probesById.TryGetValue(id, out var probe)
            ? probe
            : throw new ProbeCatalogException($"Unknown probe id '{id}'. This is a programming error: every probe id used by SqlSimCity.Collection must exist in sql/manifest.json.");
    }

    public bool TryGet(string id, out ProbeDefinition? probe) => _probesById.TryGetValue(id, out probe);

    /// <summary>
    /// Loads the catalog embedded in <paramref name="assembly"/> (defaulting to the assembly that
    /// declares <see cref="ProbeCatalog"/>) and fails closed by throwing
    /// <see cref="ProbeCatalogException"/> when the manifest, or any probe it declares, is
    /// inconsistent.
    /// </summary>
    public static ProbeCatalog Load(Assembly? assembly = null) =>
        Load(new AssemblyProbeCatalogResourceSource(assembly ?? typeof(ProbeCatalog).Assembly));

    /// <summary>
    /// Loads and validates the catalog from any <see cref="IProbeCatalogResourceSource"/>. This
    /// overload is what makes catalog tampering (missing/duplicate/unsafe-path/parameter-mismatch)
    /// unit-testable without a real compiled assembly per test case.
    /// </summary>
    public static ProbeCatalog Load(IProbeCatalogResourceSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        var errors = new List<string>();

        var resourceNames = source.GetResourceNames();
        var normalizedResources = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in resourceNames)
        {
            normalizedResources[Normalize(name)] = name;
        }

        if (!normalizedResources.TryGetValue("sql/manifest.json", out var manifestResourceName))
        {
            throw new ProbeCatalogException(
                "Embedded resource 'sql/manifest.json' was not found. The probe catalog is missing " +
                "from this build and the application must not start.");
        }

        using var manifestStream = source.OpenResource(manifestResourceName);

        JsonDocument manifestDocument;
        try
        {
            manifestDocument = JsonDocument.Parse(manifestStream);
        }
        catch (JsonException ex)
        {
            throw new ProbeCatalogException("sql/manifest.json is not valid JSON.", ex);
        }

        using (manifestDocument)
        {
            var root = manifestDocument.RootElement;

            var manifestVersion = ReadManifestVersion(root, errors);
            var connectionScopes = ReadStringKeyedObject(root, "connectionScopes", errors);
            var cadenceClasses = ReadStringKeyedObject(root, "cadenceClasses", errors);
            var relativeCosts = ReadStringKeyedObject(root, "relativeCosts", errors);

            var probes = new Dictionary<string, ProbeDefinition>(StringComparer.Ordinal);
            var seenIds = new HashSet<string>(StringComparer.Ordinal);
            var seenFiles = new HashSet<string>(StringComparer.Ordinal);

            if (!root.TryGetProperty("probes", out var probesElement) ||
                probesElement.ValueKind != JsonValueKind.Array ||
                probesElement.GetArrayLength() == 0)
            {
                errors.Add("manifest.json 'probes' must be a non-empty array.");
            }
            else
            {
                var index = 0;
                foreach (var probeElement in probesElement.EnumerateArray())
                {
                    ValidateAndBuildProbe(
                        probeElement,
                        index,
                        connectionScopes,
                        cadenceClasses,
                        relativeCosts,
                        seenIds,
                        seenFiles,
                        normalizedResources,
                        source,
                        errors,
                        probes);
                    index++;
                }
            }

            if (errors.Count > 0)
            {
                throw new ProbeCatalogException(
                    "The SQL probe catalog failed startup validation and the application must not " +
                    "start:\n - " + string.Join("\n - ", errors));
            }

            return new ProbeCatalog(manifestVersion, probes);
        }
    }

    private static int ReadManifestVersion(JsonElement root, List<string> errors)
    {
        if (!root.TryGetProperty("manifestVersion", out var versionElement) ||
            versionElement.ValueKind != JsonValueKind.Number ||
            !versionElement.TryGetInt32(out var manifestVersion))
        {
            errors.Add("manifest.json is missing a numeric 'manifestVersion'.");
            return -1;
        }

        if (!SupportedManifestVersions.Contains(manifestVersion))
        {
            errors.Add(
                $"manifest.json declares manifestVersion {manifestVersion}, which this build does not " +
                $"recognize (supported: {string.Join(", ", SupportedManifestVersions)}).");
        }

        return manifestVersion;
    }

    private static HashSet<string> ReadStringKeyedObject(JsonElement root, string propertyName, List<string> errors)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (!root.TryGetProperty(propertyName, out var element) || element.ValueKind != JsonValueKind.Object)
        {
            errors.Add($"manifest.json is missing the '{propertyName}' object.");
            return keys;
        }

        foreach (var property in element.EnumerateObject())
        {
            keys.Add(property.Name);
        }

        return keys;
    }

    private static readonly string[] RequiredProbeFields =
    [
        "id", "title", "file", "connectionScope", "minPlatform", "azureSqlDatabase",
        "requiredPermission", "cadenceClass", "parameters", "resultSets", "resultContract",
        "relativeCost",
    ];

    private static void ValidateAndBuildProbe(
        JsonElement probeElement,
        int index,
        HashSet<string> connectionScopes,
        HashSet<string> cadenceClasses,
        HashSet<string> relativeCosts,
        HashSet<string> seenIds,
        HashSet<string> seenFiles,
        Dictionary<string, string> normalizedResources,
        IProbeCatalogResourceSource source,
        List<string> errors,
        Dictionary<string, ProbeDefinition> probes)
    {
        var label = $"probes[{index}]";
        foreach (var field in RequiredProbeFields)
        {
            if (!probeElement.TryGetProperty(field, out _))
            {
                errors.Add($"{label} is missing required field '{field}'.");
            }
        }

        var id = GetString(probeElement, "id") ?? $"<{label}>";
        label = id;

        if (!seenIds.Add(id))
        {
            errors.Add($"probe id '{id}' is declared more than once (duplicate ids are not allowed).");
        }

        var file = GetString(probeElement, "file");
        if (string.IsNullOrEmpty(file))
        {
            errors.Add($"probe '{id}' has an empty or missing 'file'.");
            return;
        }

        if (!seenFiles.Add(file))
        {
            errors.Add($"probe file '{file}' is referenced by more than one probe (each file must map to exactly one probe).");
        }

        if (!IsSafeRelativeProbePath(file))
        {
            errors.Add(
                $"probe '{id}' declares an unsafe file path '{file}'. Probe files must be a " +
                "forward-slash relative path beginning with 'probes/', with no '..' segments, " +
                "no leading slash, and no drive letter.");
            return;
        }

        var connectionScope = GetString(probeElement, "connectionScope") ?? string.Empty;
        if (!connectionScopes.Contains(connectionScope))
        {
            errors.Add($"probe '{id}' has undocumented connectionScope '{connectionScope}'.");
        }

        var cadenceClass = GetString(probeElement, "cadenceClass") ?? string.Empty;
        if (!cadenceClasses.Contains(cadenceClass))
        {
            errors.Add($"probe '{id}' has undocumented cadenceClass '{cadenceClass}'.");
        }

        var relativeCost = GetString(probeElement, "relativeCost") ?? string.Empty;
        if (!relativeCosts.Contains(relativeCost))
        {
            errors.Add($"probe '{id}' has undocumented relativeCost '{relativeCost}'.");
        }

        bool azureUnsupported = false;
        var azureNotes = string.Empty;
        if (probeElement.TryGetProperty("azureSqlDatabase", out var azureElement) &&
            azureElement.ValueKind == JsonValueKind.Object)
        {
            if (azureElement.TryGetProperty("unsupported", out var unsupportedElement) &&
                (unsupportedElement.ValueKind == JsonValueKind.True || unsupportedElement.ValueKind == JsonValueKind.False))
            {
                azureUnsupported = unsupportedElement.GetBoolean();
            }
            else
            {
                errors.Add($"probe '{id}' azureSqlDatabase.unsupported must be a boolean.");
            }

            azureNotes = GetString(azureElement, "notes") ?? string.Empty;
            if (string.IsNullOrWhiteSpace(azureNotes))
            {
                errors.Add($"probe '{id}' has an empty azureSqlDatabase.notes.");
            }
        }
        else
        {
            errors.Add($"probe '{id}' is missing the 'azureSqlDatabase' object.");
        }

        var parameters = new List<ProbeParameterDefinition>();
        if (probeElement.TryGetProperty("parameters", out var parametersElement) &&
            parametersElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var parameterElement in parametersElement.EnumerateArray())
            {
                var name = GetString(parameterElement, "name") ?? string.Empty;
                if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^@[A-Za-z_][A-Za-z0-9_]*$"))
                {
                    errors.Add($"probe '{id}' declares a parameter with an invalid name '{name}'.");
                }

                var sqlDbType = GetString(parameterElement, "sqlDbType") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(sqlDbType))
                {
                    errors.Add($"probe '{id}' parameter '{name}' is missing sqlDbType.");
                }

                bool required = false;
                if (parameterElement.TryGetProperty("required", out var requiredElement) &&
                    (requiredElement.ValueKind == JsonValueKind.True || requiredElement.ValueKind == JsonValueKind.False))
                {
                    required = requiredElement.GetBoolean();
                }
                else
                {
                    errors.Add($"probe '{id}' parameter '{name}' is missing a boolean 'required'.");
                }

                var description = GetString(parameterElement, "description") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(description))
                {
                    errors.Add($"probe '{id}' parameter '{name}' has an empty description.");
                }

                var hasDefault = parameterElement.TryGetProperty("default", out _);
                if (!required && !hasDefault)
                {
                    errors.Add($"probe '{id}' optional parameter '{name}' must declare a 'default'.");
                }

                parameters.Add(new ProbeParameterDefinition(name, sqlDbType, required, description, hasDefault));
            }
        }
        else
        {
            errors.Add($"probe '{id}' 'parameters' must be an array.");
        }

        int resultSets = 0;
        if (probeElement.TryGetProperty("resultSets", out var resultSetsElement) &&
            resultSetsElement.ValueKind == JsonValueKind.Number &&
            resultSetsElement.TryGetInt32(out resultSets))
        {
            // value captured above
        }
        else
        {
            errors.Add($"probe '{id}' 'resultSets' must be an integer.");
        }

        string? versionVariantOf = probeElement.TryGetProperty("versionVariantOf", out var vvo) ? vvo.GetString() : null;
        string? versionVariantNotes = probeElement.TryGetProperty("versionVariantNotes", out var vvn) ? vvn.GetString() : null;
        if (versionVariantOf is not null && string.IsNullOrWhiteSpace(versionVariantNotes))
        {
            errors.Add($"probe '{id}' declares versionVariantOf but no non-empty versionVariantNotes.");
        }

        var normalizedResourceKey = "sql/" + file;
        string commandText = string.Empty;
        if (!normalizedResources.TryGetValue(normalizedResourceKey, out var resourceName))
        {
            errors.Add($"probe '{id}' references file '{file}', which does not exist among the embedded catalog resources.");
        }
        else
        {
            using var stream = source.OpenResource(resourceName);
            using var reader = new StreamReader(stream);
            commandText = reader.ReadToEnd();

            foreach (var shapeError in SqlTextScanner.ValidateReadOnlyShape(commandText))
            {
                errors.Add($"probe '{id}' failed read-only SQL validation: {shapeError}.");
            }

            var declared = new HashSet<string>(parameters.Select(p => p.Name), StringComparer.Ordinal);
            var referenced = SqlTextScanner.ExtractParameterNames(commandText);

            var missingFromFile = declared.Where(n => !referenced.Contains(n)).ToList();
            var undeclaredInManifest = referenced.Where(n => !declared.Contains(n)).ToList();

            if (missingFromFile.Count > 0)
            {
                errors.Add($"probe '{id}' declares parameters [{string.Join(", ", missingFromFile)}] but its file never references them.");
            }

            if (undeclaredInManifest.Count > 0)
            {
                errors.Add($"probe '{id}' file references parameters [{string.Join(", ", undeclaredInManifest)}] that the manifest does not declare.");
            }
        }

        // Build the definition whenever the file was readable, even if unrelated validation
        // errors exist elsewhere, so a single bad probe does not suppress other probes' errors.
        if (!string.IsNullOrEmpty(commandText))
        {
            probes[id] = new ProbeDefinition(
                id,
                GetString(probeElement, "title") ?? string.Empty,
                file,
                connectionScope,
                GetString(probeElement, "minPlatform") ?? string.Empty,
                azureUnsupported,
                azureNotes,
                GetString(probeElement, "requiredPermission") ?? string.Empty,
                cadenceClass,
                parameters,
                resultSets,
                GetString(probeElement, "resultContract") ?? string.Empty,
                relativeCost,
                versionVariantOf,
                versionVariantNotes,
                commandText);
        }
    }

    /// <summary>
    /// A probe file path is safe only when it is a forward-slash relative path rooted at
    /// <c>probes/</c>, with no parent-directory traversal, no leading slash, and no drive letter
    /// -- i.e. it can only ever resolve to a file already embedded under <c>sql/probes/</c>.
    /// </summary>
    internal static bool IsSafeRelativeProbePath(string file)
    {
        if (string.IsNullOrWhiteSpace(file)) return false;
        if (file.Contains('\\', StringComparison.Ordinal)) return false;
        if (file.StartsWith('/')) return false;
        if (file.Length >= 2 && file[1] == ':') return false;
        if (!file.StartsWith("probes/", StringComparison.Ordinal)) return false;

        var segments = file.Split('/');
        foreach (var segment in segments)
        {
            if (string.IsNullOrEmpty(segment)) return false;
            if (segment is "." or "..") return false;
        }

        return true;
    }

    private static string? GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string Normalize(string resourceName) => resourceName.Replace('\\', '/');
}
