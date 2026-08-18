namespace SqlSimCity.Archive;

public sealed record ArchiveSourceOptions(
    string AllowedDirectory,
    string FileName,
    long MaximumArchiveBytes = 256L * 1024 * 1024);

public static class ArchivePathResolver
{
    public static string Resolve(ArchiveSourceOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.MaximumArchiveBytes is < 1 or > ArchiveFormat.MaxArchiveBytes)
            throw new ArchiveValidationException("Acquisition:Archive:MaximumArchiveBytes is outside the supported range.");
        if (string.IsNullOrWhiteSpace(options.AllowedDirectory))
            throw new ArchiveValidationException("Acquisition:Archive:AllowedDirectory is required.");
        if (string.IsNullOrWhiteSpace(options.FileName) ||
            options.FileName != Path.GetFileName(options.FileName) ||
            options.FileName is "." or ".." ||
            options.FileName.Length > 128)
            throw new ArchiveValidationException("Acquisition:Archive:FileName must be one simple file name.");
        var allowedDirectory = Path.GetFullPath(options.AllowedDirectory);
        if (!Directory.Exists(allowedDirectory) ||
            (File.GetAttributes(allowedDirectory) & FileAttributes.ReparsePoint) != 0)
            throw new ArchiveValidationException("The archive allowed directory must be a real, non-link directory.");
        var path = Path.GetFullPath(Path.Combine(allowedDirectory, options.FileName));
        var relative = Path.GetRelativePath(allowedDirectory, path);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new ArchiveValidationException("The configured archive path escapes the allowed directory.");
        if (!File.Exists(path))
            throw new ArchiveValidationException("The configured archive file does not exist.");
        var attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
            new FileInfo(path).LinkTarget is not null)
            throw new ArchiveValidationException("The configured archive must be one regular, non-link file.");
        return path;
    }
}
