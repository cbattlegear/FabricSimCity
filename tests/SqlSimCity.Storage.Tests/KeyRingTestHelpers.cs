using System.Security.Cryptography;
using System.Text.Json;

namespace SqlSimCity.Storage.Tests;

/// <summary>Shared helpers for constructing key ring fixtures in tests.</summary>
internal static class KeyRingTestHelpers
{
    public static byte[] NewKeyBytes() => RandomNumberGenerator.GetBytes(32);

    public static string ToBase64(byte[] key) => Convert.ToBase64String(key);

    public static string WriteKeyFile(string directory, int activeKeyVersion, params (int Version, byte[] Key)[] keys)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"key-{Guid.NewGuid():N}.json");
        var json = JsonSerializer.Serialize(new
        {
            formatVersion = 1,
            activeKeyVersion,
            keys = keys.Select(k => new { version = k.Version, key = ToBase64(k.Key) }),
        });
        File.WriteAllText(path, json);
        return path;
    }

    public static string WriteRawKeyFile(string directory, string rawJson)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"key-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, rawJson);
        return path;
    }
}
