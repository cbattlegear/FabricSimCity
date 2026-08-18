using System.Text.Json;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// Minimal structured, single-line JSON logger to stdout. It deliberately accepts only a fixed set
/// of safe fields and never serializes secrets, request bodies, signatures, or payload content, so
/// connector logs can be shipped without leaking evidence or credentials.
/// </summary>
public sealed class StructuredLog
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = false };
    private readonly TimeProvider _timeProvider;
    private readonly TextWriter _out;
    private readonly Lock _gate = new();

    public StructuredLog(TimeProvider? timeProvider = null, TextWriter? output = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _out = output ?? Console.Out;
    }

    public void Info(string @event, IReadOnlyDictionary<string, object?>? fields = null) => Write("info", @event, fields);

    public void Warn(string @event, IReadOnlyDictionary<string, object?>? fields = null) => Write("warn", @event, fields);

    public void Error(string @event, IReadOnlyDictionary<string, object?>? fields = null) => Write("error", @event, fields);

    private void Write(string level, string @event, IReadOnlyDictionary<string, object?>? fields)
    {
        var record = new Dictionary<string, object?>
        {
            ["ts"] = _timeProvider.GetUtcNow().ToString("O"),
            ["level"] = level,
            ["event"] = @event,
        };
        if (fields is not null)
        {
            foreach (var (key, value) in fields)
                record[key] = value;
        }

        var line = JsonSerializer.Serialize(record, Options);
        lock (_gate)
        {
            _out.WriteLine(line);
        }
    }
}
