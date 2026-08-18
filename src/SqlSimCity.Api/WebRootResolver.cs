namespace SqlSimCity.Api;

public static class WebRootResolver
{
    public static string? Resolve(string baseDirectory, Func<string, bool>? fileExists = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        var webRoot = Path.GetFullPath(Path.Combine(baseDirectory, "wwwroot"));
        return (fileExists ?? File.Exists)(Path.Combine(webRoot, "index.html")) ? webRoot : null;
    }
}
