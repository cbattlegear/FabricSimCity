using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlSimCity.Archive;

public static class ArchiveJson
{
    public static JsonSerializerOptions SerializerOptions { get; } = CreateOptions();

    public static byte[] SerializeCanonical<T>(T value)
    {
        var serialized = JsonSerializer.SerializeToUtf8Bytes(value, SerializerOptions);
        return Canonicalize(serialized);
    }

    public static byte[] Canonicalize(ReadOnlySpan<byte> json)
    {
        Validate(json);
        using var document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = ArchiveFormat.MaxJsonDepth,
        });
        var buffer = new ArrayBufferWriter<byte>(json.Length);
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.Default,
            Indented = false,
            SkipValidation = false,
        }))
        {
            WriteCanonical(writer, document.RootElement);
        }
        return buffer.WrittenSpan.ToArray();
    }

    public static T Deserialize<T>(ReadOnlySpan<byte> json)
    {
        Validate(json);
        return JsonSerializer.Deserialize<T>(json, SerializerOptions)
            ?? throw new ArchiveValidationException($"Archive JSON for {typeof(T).Name} was null.");
    }

    public static void Validate(ReadOnlySpan<byte> json)
    {
        var reader = new Utf8JsonReader(json, new JsonReaderOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = ArchiveFormat.MaxJsonDepth,
        });
        while (reader.Read())
        {
            if (reader.TokenType is JsonTokenType.String or JsonTokenType.PropertyName &&
                (reader.HasValueSequence
                    ? reader.ValueSequence.Length > ArchiveFormat.MaxJsonStringBytes
                    : reader.ValueSpan.Length > ArchiveFormat.MaxJsonStringBytes))
            {
                throw new ArchiveValidationException("Archive JSON contains an oversized string.");
            }
            if (reader.TokenType == JsonTokenType.Number &&
                (reader.HasValueSequence
                    ? reader.ValueSequence.Length > ArchiveFormat.MaxJsonNumberBytes
                    : reader.ValueSpan.Length > ArchiveFormat.MaxJsonNumberBytes))
            {
                throw new ArchiveValidationException("Archive JSON contains an oversized number.");
            }
        }
        using var document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = ArchiveFormat.MaxJsonDepth,
        });
        var nodes = 0;
        ValidateStructure(document.RootElement, ref nodes);
    }

    private static void ValidateStructure(JsonElement value, ref int nodes)
    {
        if (++nodes > 1_000_000)
            throw new ArchiveValidationException("Archive JSON contains too many values.");
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            var properties = 0;
            foreach (var property in value.EnumerateObject())
            {
                if (++properties > 100_000)
                    throw new ArchiveValidationException("Archive JSON contains an oversized object.");
                if (!names.Add(property.Name))
                    throw new ArchiveValidationException(
                        $"Archive JSON contains duplicate property '{property.Name}'.");
                ValidateStructure(property.Value, ref nodes);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            var items = 0;
            foreach (var item in value.EnumerateArray())
            {
                if (++items > 100_000)
                    throw new ArchiveValidationException("Archive JSON contains an oversized array.");
                ValidateStructure(item, ref nodes);
            }
        }
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                    WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(value.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(value.GetRawText(), skipInputValidation: false);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new ArchiveValidationException("Archive JSON contains an unsupported token.");
        }
    }

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = null,
            NumberHandling = JsonNumberHandling.Strict,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            AllowTrailingCommas = false,
            MaxDepth = ArchiveFormat.MaxJsonDepth,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        };
        options.Converters.Add(new JsonStringEnumConverter(allowIntegerValues: false));
        return options;
    }
}
