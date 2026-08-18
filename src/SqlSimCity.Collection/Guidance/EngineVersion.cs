namespace SqlSimCity.Collection.Guidance;

/// <summary>Parses the numeric major version prefix from a raw <c>SERVERPROPERTY('ProductVersion')</c> string, for guidance text only.</summary>
public static class EngineVersion
{
    public static int? TryParseMajorVersion(string? productVersion)
    {
        if (string.IsNullOrWhiteSpace(productVersion))
        {
            return null;
        }

        var firstSegment = productVersion.Split('.')[0];
        return int.TryParse(firstSegment, out var major) ? major : null;
    }
}
