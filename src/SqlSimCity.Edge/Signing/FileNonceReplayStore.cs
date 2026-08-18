using System.Globalization;

namespace SqlSimCity.Edge.Signing;

/// <summary>
/// A durable, append-only <see cref="INonceReplayStore"/>. Accepted nonces are journaled to a file
/// so replay protection survives a central restart. The in-memory index and the journal are guarded
/// by one lock; the journal is compacted (temp file + atomic rename) once enough expired entries
/// accumulate, so it never grows without bound. A missing directory is created; a corrupt line in an
/// existing journal is skipped rather than failing the whole store closed against legitimate traffic.
/// </summary>
public sealed class FileNonceReplayStore : INonceReplayStore, IDisposable
{
    private readonly string _journalPath;
    private readonly TimeProvider _timeProvider;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, long> _expiryByKey = new(StringComparer.Ordinal);
    private StreamWriter? _writer;
    private int _sinceCompaction;
    private bool _disposed;

    /// <summary>Compact the journal after this many appends to bound its on-disk size.</summary>
    public int CompactionThreshold { get; init; } = 4096;

    public FileNonceReplayStore(string journalPath, TimeProvider? timeProvider = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(journalPath);
        _journalPath = Path.GetFullPath(journalPath);
        _timeProvider = timeProvider ?? TimeProvider.System;

        var directory = Path.GetDirectoryName(_journalPath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        LoadExisting();
        _writer = new StreamWriter(new FileStream(
            _journalPath, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
    }

    public bool TryRegister(string connectorId, string nonce, DateTimeOffset expiresAt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectorId);
        ArgumentException.ThrowIfNullOrWhiteSpace(nonce);
        var key = MakeKey(connectorId, nonce);
        var nowUnix = _timeProvider.GetUtcNow().ToUnixTimeSeconds();
        var expiryUnix = expiresAt.ToUnixTimeSeconds();

        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_expiryByKey.TryGetValue(key, out var existingExpiry) && existingExpiry > nowUnix)
                return false;

            _expiryByKey[key] = expiryUnix;
            _writer!.WriteLine($"{key}\t{expiryUnix.ToString(CultureInfo.InvariantCulture)}");
            if (++_sinceCompaction >= CompactionThreshold)
                Compact(nowUnix);

            return true;
        }
    }

    private void LoadExisting()
    {
        if (!File.Exists(_journalPath))
            return;

        var nowUnix = _timeProvider.GetUtcNow().ToUnixTimeSeconds();
        foreach (var line in File.ReadLines(_journalPath))
        {
            var separator = line.IndexOf('\t');
            if (separator <= 0 || separator == line.Length - 1)
                continue;
            var key = line[..separator];
            if (!long.TryParse(line.AsSpan(separator + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var expiry))
                continue;
            if (expiry > nowUnix)
                _expiryByKey[key] = expiry;
        }
    }

    private void Compact(long nowUnix)
    {
        foreach (var expired in _expiryByKey.Where(pair => pair.Value <= nowUnix).Select(pair => pair.Key).ToArray())
            _expiryByKey.Remove(expired);

        _writer!.Dispose();
        _writer = null;

        var tempPath = _journalPath + ".tmp";
        using (var temp = new StreamWriter(new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None)))
        {
            foreach (var (key, expiry) in _expiryByKey)
                temp.WriteLine($"{key}\t{expiry.ToString(CultureInfo.InvariantCulture)}");
        }

        File.Move(tempPath, _journalPath, overwrite: true);
        _writer = new StreamWriter(new FileStream(
            _journalPath, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
        _sinceCompaction = 0;
    }

    private static string MakeKey(string connectorId, string nonce) => $"{connectorId}\u0001{nonce}";

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
                return;
            _writer?.Dispose();
            _writer = null;
            _disposed = true;
        }
    }
}
