using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SqlSimCity.Archive;

public sealed class ArchiveValidationException(string message) : Exception(message);

public sealed record ArchivePayload(
    string Name,
    string Section,
    byte[] Bytes,
    long RecordCount,
    ArchiveSourceStamp Source);

public sealed class ArchivePackage : IDisposable
{
    private readonly FileStream _stream;
    private readonly IReadOnlyDictionary<string, (long Offset, ArchiveEntry Entry)> _locations;
    private readonly object _sync = new();

    internal ArchivePackage(
        FileStream stream,
        ArchiveManifest manifest,
        IReadOnlyDictionary<string, (long Offset, ArchiveEntry Entry)> locations)
    {
        _stream = stream;
        Manifest = manifest;
        _locations = locations;
    }

    public ArchiveManifest Manifest { get; }
    public long Length => _stream.Length;

    public byte[] ReadEntry(string name)
    {
        if (!_locations.TryGetValue(name, out var location))
            throw new ArchiveValidationException($"Archive entry '{name}' is not present.");
        var bytes = GC.AllocateUninitializedArray<byte>(checked((int)location.Entry.ByteLength));
        lock (_sync)
        {
            _stream.Position = location.Offset;
            _stream.ReadExactly(bytes);
        }
        return bytes;
    }

    public void Dispose() => _stream.Dispose();
}

public static partial class ArchivePackageReader
{
    private static readonly byte[] Magic = "SSCA\r\n\x1a\n"u8.ToArray();

    [GeneratedRegex("^[a-z0-9][a-z0-9._/-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex EntryNameRegex();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    public static ArchivePackage Open(string path, long maximumArchiveBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (maximumArchiveBytes is < 1 or > ArchiveFormat.MaxArchiveBytes)
            throw new ArgumentOutOfRangeException(nameof(maximumArchiveBytes));
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new ArchiveValidationException("Archive files must not be symbolic links or reparse points.");
        if ((attributes & FileAttributes.Directory) != 0)
            throw new ArchiveValidationException("The configured archive path is not a regular file.");

        var fileInfo = new FileInfo(path);
        if (fileInfo.LinkTarget is not null || fileInfo.Length < 14)
            throw new ArchiveValidationException("The configured archive is not a valid regular archive file.");
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.RandomAccess);
        try
        {
            if (stream.Length > maximumArchiveBytes)
                throw new ArchiveValidationException("Archive exceeds the configured maximum byte length.");
            Span<byte> header = stackalloc byte[12];
            stream.ReadExactly(header);
            if (!header[..8].SequenceEqual(Magic))
                throw new ArchiveValidationException("Archive magic/version header is invalid.");
            var manifestLength = BinaryPrimitives.ReadInt32BigEndian(header[8..]);
            if (manifestLength is < 2 or > ArchiveFormat.MaxManifestBytes || manifestLength > stream.Length - 12)
                throw new ArchiveValidationException("Archive manifest length is invalid.");
            var manifestBytes = GC.AllocateUninitializedArray<byte>(manifestLength);
            stream.ReadExactly(manifestBytes);
            if (!manifestBytes.AsSpan().SequenceEqual(ArchiveJson.Canonicalize(manifestBytes)))
                throw new ArchiveValidationException("Archive manifest is not canonical JSON.");
            var manifest = ArchiveJson.Deserialize<ArchiveManifest>(manifestBytes);
            if (!manifestBytes.AsSpan().SequenceEqual(ArchiveJson.SerializeCanonical(manifest)))
                throw new ArchiveValidationException("Archive manifest values are not in canonical form.");
            ValidateManifest(manifest);
            if (stream.Length > manifest.Limits.MaximumArchiveBytes)
                throw new ArchiveValidationException("Archive exceeds its declared maximum byte length.");

            var locations = new Dictionary<string, (long Offset, ArchiveEntry Entry)>(StringComparer.Ordinal);
            var offset = 12L + manifestLength;
            foreach (var entry in manifest.Entries)
            {
                if (entry.ByteLength > int.MaxValue || offset > stream.Length - entry.ByteLength)
                    throw new ArchiveValidationException($"Archive entry '{entry.Name}' is truncated or oversized.");
                var bytes = GC.AllocateUninitializedArray<byte>(checked((int)entry.ByteLength));
                stream.Position = offset;
                stream.ReadExactly(bytes);
                var digest = Convert.ToHexStringLower(SHA256.HashData(bytes));
                if (!CryptographicOperations.FixedTimeEquals(
                        Encoding.ASCII.GetBytes(digest),
                        Encoding.ASCII.GetBytes(entry.Sha256)))
                    throw new ArchiveValidationException($"Archive entry '{entry.Name}' failed SHA-256 validation.");
                if (entry.ContentType == "application/json")
                {
                    var canonical = ArchiveJson.Canonicalize(bytes);
                    if (!bytes.AsSpan().SequenceEqual(canonical))
                        throw new ArchiveValidationException(
                            $"Archive entry '{entry.Name}' is not canonical JSON.");
                }
                locations.Add(entry.Name, (offset, entry));
                offset += entry.ByteLength;
            }
            if (offset != stream.Length)
                throw new ArchiveValidationException("Archive contains trailing or unmanifested bytes.");
            return new ArchivePackage(stream, manifest, locations);
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    internal static void ValidateManifest(ArchiveManifest manifest)
    {
        if (!Version.TryParse(manifest.SchemaVersion, out var version) ||
            version.Major != ArchiveFormat.SupportedMajorVersion)
            throw new ArchiveValidationException("Archive schema major version is unsupported.");
        ValidateTimestamp(manifest.CreatedAt, "createdAt");
        if (string.IsNullOrWhiteSpace(manifest.ProducerVersion) || manifest.ProducerVersion.Length > 64 ||
            string.IsNullOrWhiteSpace(manifest.Target.OpaqueIdentity) || manifest.Target.OpaqueIdentity.Length > 256 ||
            string.IsNullOrWhiteSpace(manifest.Target.DisplayAlias) || manifest.Target.DisplayAlias.Length > 256)
            throw new ArchiveValidationException("Archive producer or target metadata is invalid.");
        if (manifest.Limits.MaximumArchiveBytes is < 1 or > ArchiveFormat.MaxArchiveBytes ||
            manifest.Limits.MaximumEntries is < 1 or > ArchiveFormat.MaxEntryCount ||
            manifest.Limits.MaximumRecords is < 0 or > ArchiveFormat.MaxRecords ||
            manifest.Limits.MaximumNameLength is < 1 or > ArchiveFormat.MaxNameLength ||
            manifest.Limits.MaximumExecutionMilliseconds is < 1 or > ArchiveFormat.MaxExecutionMilliseconds)
            throw new ArchiveValidationException("Archive declares unsafe processing limits.");
        ValidateStringList(manifest.IncludedSections, "sections");
        ValidateStringList(manifest.Features, "features");
        ValidateStringList(manifest.Capabilities, "capabilities");
        ValidateStringList(manifest.Redaction.ExcludedFields, "redaction exclusions", requireSorted: false);
        if (string.IsNullOrWhiteSpace(manifest.Redaction.PolicyVersion) ||
            manifest.Redaction.PolicyVersion.Length > 64)
            throw new ArchiveValidationException("Archive redaction policy metadata is invalid.");
        if (manifest.Entries.Count > ArchiveFormat.MaxEntryCount ||
            manifest.Entries.Count > manifest.Limits.MaximumEntries)
            throw new ArchiveValidationException("Archive has too many entries.");
        if (manifest.Redaction.RawSqlIncluded || manifest.Redaction.RawShowplanXmlIncluded)
            throw new ArchiveValidationException("This reader does not accept archives containing raw SQL or raw Showplan XML.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        long totalRecords = 0;
        long totalBytes = 12;
        foreach (var entry in manifest.Entries)
        {
            if (!EntryNameRegex().IsMatch(entry.Name) ||
                entry.Name.Length > manifest.Limits.MaximumNameLength ||
                entry.Name.Contains("..", StringComparison.Ordinal) ||
                entry.Name.StartsWith('/') ||
                entry.Name.Contains('\\') ||
                entry.ByteLength < 2 ||
                entry.ByteLength > ArchiveFormat.MaxEntryBytes ||
                entry.RecordCount < 0 ||
                entry.ContentType != "application/json" ||
                !Sha256Regex().IsMatch(entry.Sha256))
                throw new ArchiveValidationException($"Archive entry metadata for '{entry.Name}' is invalid.");
            if (!names.Add(entry.Name))
                throw new ArchiveValidationException($"Archive contains duplicate entry '{entry.Name}'.");
            if (entry.Section.Length is < 1 or > 64 ||
                !manifest.IncludedSections.Contains(entry.Section, StringComparer.Ordinal))
                throw new ArchiveValidationException($"Archive entry '{entry.Name}' has an undeclared section.");
            if (entry.Source.ObservedAt is { } observedAt)
                ValidateTimestamp(observedAt, $"{entry.Name}.observedAt");
            if (entry.Source.FreshUntil is { } freshUntil)
                ValidateTimestamp(freshUntil, $"{entry.Name}.freshUntil");
            if (entry.Source.ResetEpoch?.Length > 256 ||
                string.IsNullOrWhiteSpace(entry.Source.RetentionResolution) ||
                entry.Source.RetentionResolution.Length > 64)
                throw new ArchiveValidationException($"Archive entry '{entry.Name}' has oversized source metadata.");
            try
            {
                totalRecords = checked(totalRecords + entry.RecordCount);
                totalBytes = checked(totalBytes + entry.ByteLength);
            }
            catch (OverflowException)
            {
                throw new ArchiveValidationException("Archive entry totals overflow the supported range.");
            }
        }
        if (totalRecords > manifest.Limits.MaximumRecords ||
            totalRecords > ArchiveFormat.MaxRecords)
            throw new ArchiveValidationException("Archive record count exceeds its declared limit.");
        if (totalBytes > manifest.Limits.MaximumArchiveBytes)
            throw new ArchiveValidationException("Archive payload bytes exceed its declared limit.");
    }

    private static void ValidateStringList(
        IReadOnlyList<string> values,
        string field,
        bool requireSorted = true)
    {
        if (values.Count > ArchiveFormat.MaxManifestListItems ||
            values.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 256) ||
            values.Distinct(StringComparer.Ordinal).Count() != values.Count ||
            requireSorted && !values.Order(StringComparer.Ordinal).SequenceEqual(values, StringComparer.Ordinal))
            throw new ArchiveValidationException(
                $"Archive {field} must be bounded, unique{(requireSorted ? ", and ordinally sorted" : string.Empty)}.");
    }

    private static void ValidateTimestamp(DateTimeOffset value, string field)
    {
        if (value.Offset != TimeSpan.Zero || value.Year is < 1900 or > 2100)
            throw new ArchiveValidationException($"Archive timestamp '{field}' is outside the supported UTC range.");
    }

    internal static ReadOnlySpan<byte> HeaderMagic => Magic;
}

public static class ArchivePackageWriter
{
    public static ArchiveManifest Preview(
        string producerVersion,
        DateTimeOffset createdAt,
        ArchiveTarget target,
        ArchiveRedactionPolicy redaction,
        IReadOnlyList<string> features,
        IReadOnlyList<string> capabilities,
        ArchiveLimits limits,
        IEnumerable<ArchivePayload> payloads)
    {
        if (createdAt.Offset != TimeSpan.Zero)
            createdAt = createdAt.ToUniversalTime();
        var orderedPayloads = payloads.OrderBy(payload => payload.Name, StringComparer.Ordinal).ToArray();
        if (orderedPayloads.Length > limits.MaximumEntries)
            throw new ArchiveValidationException("Export exceeds the configured entry limit.");
        var entries = orderedPayloads.Select(payload => new ArchiveEntry(
            payload.Name,
            payload.Section,
            "application/json",
            payload.Bytes.LongLength,
            Convert.ToHexStringLower(SHA256.HashData(payload.Bytes)),
            payload.RecordCount,
            payload.Source)).ToArray();
        var manifest = new ArchiveManifest(
            ArchiveFormat.SchemaVersion,
            producerVersion,
            createdAt,
            target,
            entries.Select(entry => entry.Section).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            entries,
            redaction,
            features.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            capabilities.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            limits);
        ValidatePayloadsAreCanonical(orderedPayloads);
        ArchivePackageReader.ValidateManifest(manifest);
        var totalBytes = 12L + ArchiveJson.SerializeCanonical(manifest).LongLength + entries.Sum(entry => entry.ByteLength);
        if (totalBytes > limits.MaximumArchiveBytes)
            throw new ArchiveValidationException("Export exceeds the configured archive byte limit.");
        if (entries.Sum(entry => entry.RecordCount) > limits.MaximumRecords)
            throw new ArchiveValidationException("Export exceeds the configured record limit.");
        return manifest;
    }

    private static void ValidatePayloadsAreCanonical(IEnumerable<ArchivePayload> payloads)
    {
        foreach (var payload in payloads)
        {
            var canonical = ArchiveJson.Canonicalize(payload.Bytes);
            if (!payload.Bytes.AsSpan().SequenceEqual(canonical))
                throw new ArchiveValidationException($"Payload '{payload.Name}' is not canonical JSON.");
        }
    }

    public static void Write(
        string path,
        ArchiveManifest manifest,
        IReadOnlyDictionary<string, byte[]> payloads,
        bool overwrite)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(payloads);
        ArchivePackageReader.ValidateManifest(manifest);
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath)
            ?? throw new ArchiveValidationException("Archive output directory is unavailable.");
        Directory.CreateDirectory(directory);
        if (!overwrite && File.Exists(fullPath))
            throw new IOException($"Archive output '{fullPath}' already exists.");
        var temporary = Path.Combine(directory, $".{Path.GetFileName(fullPath)}.{Guid.NewGuid():N}.tmp");
        try
        {
            var streamOptions = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                BufferSize = 64 * 1024,
                Options = FileOptions.WriteThrough,
            };
            if (!OperatingSystem.IsWindows())
                streamOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(temporary, streamOptions))
            {
                var manifestBytes = ArchiveJson.SerializeCanonical(manifest);
                Span<byte> header = stackalloc byte[12];
                ArchivePackageReader.HeaderMagic.CopyTo(header);
                BinaryPrimitives.WriteInt32BigEndian(header[8..], manifestBytes.Length);
                stream.Write(header);
                stream.Write(manifestBytes);
                foreach (var entry in manifest.Entries)
                {
                    if (!payloads.TryGetValue(entry.Name, out var bytes) ||
                        bytes.LongLength != entry.ByteLength ||
                        Convert.ToHexStringLower(SHA256.HashData(bytes)) != entry.Sha256)
                        throw new ArchiveValidationException($"Payload '{entry.Name}' does not match the preview manifest.");
                    stream.Write(bytes);
                }
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, fullPath, overwrite);
        }
        finally
        {
            if (File.Exists(temporary))
                File.Delete(temporary);
        }
    }
}
