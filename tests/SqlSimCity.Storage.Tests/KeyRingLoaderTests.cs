using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

using SqlSimCity.Storage;

public sealed class KeyRingLoaderTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-storage-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [Fact]
    public void LoadsValidKeyRingWithActiveAndOldVersions()
    {
        var key1 = KeyRingTestHelpers.NewKeyBytes();
        var key2 = KeyRingTestHelpers.NewKeyBytes();
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 2, (1, key1), (2, key2));

        using var keyRing = KeyRingLoader.Load(path);

        Assert.Equal(2u, keyRing.ActiveKeyVersion);
    }

    [Fact]
    public void ZerosDecodedSourceBuffersAfterConstructingRing()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 1, (1, key));
        var decoded = new List<byte[]>();

        using var keyRing = KeyRingLoader.Load(path, base64 =>
        {
            var bytes = Convert.FromBase64String(base64);
            decoded.Add(bytes);
            return bytes;
        });

        Assert.All(decoded, bytes => Assert.All(bytes, value => Assert.Equal(0, value)));
        Assert.Equal(key, keyRing.GetKey(1));
    }

    [Fact]
    public void ZerosDecodedSourceBuffersWhenLaterValidationFails()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var json = $$"""
            { "formatVersion": 1, "activeKeyVersion": 2, "keys": [ { "version": 1, "key": "{{KeyRingTestHelpers.ToBase64(key)}}" } ] }
            """;
        var path = KeyRingTestHelpers.WriteRawKeyFile(_directory, json);
        byte[]? decoded = null;

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path, base64 =>
        {
            decoded = Convert.FromBase64String(base64);
            return decoded;
        }));

        Assert.NotNull(decoded);
        Assert.All(decoded!, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ThrowsWhenFileIsMissing()
    {
        var path = Path.Combine(_directory, "does-not-exist.json");

        var ex = Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
        Assert.Contains("not found", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ThrowsWhenPathIsNullOrWhitespace()
    {
        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(string.Empty));
    }

    [Fact]
    public void ThrowsOnInvalidJson()
    {
        var path = KeyRingTestHelpers.WriteRawKeyFile(_directory, "{ not valid json");

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ThrowsOnUnsupportedFormatVersion()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var json = $$"""
            { "formatVersion": 2, "activeKeyVersion": 1, "keys": [ { "version": 1, "key": "{{KeyRingTestHelpers.ToBase64(key)}}" } ] }
            """;
        var path = KeyRingTestHelpers.WriteRawKeyFile(_directory, json);

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ThrowsWhenKeysArrayIsEmpty()
    {
        var json = """{ "formatVersion": 1, "activeKeyVersion": 1, "keys": [] }""";
        var path = KeyRingTestHelpers.WriteRawKeyFile(_directory, json);

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ThrowsOnDuplicateKeyVersion()
    {
        var key1 = KeyRingTestHelpers.NewKeyBytes();
        var key2 = KeyRingTestHelpers.NewKeyBytes();
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 1, (1, key1), (1, key2));

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ThrowsOnNonPositiveKeyVersion()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 0, (0, key));

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ThrowsOnInvalidBase64Key()
    {
        var json = """{ "formatVersion": 1, "activeKeyVersion": 1, "keys": [ { "version": 1, "key": "not-valid-base64!!" } ] }""";
        var path = KeyRingTestHelpers.WriteRawKeyFile(_directory, json);

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Theory]
    [InlineData(16)]
    [InlineData(24)]
    [InlineData(33)]
    [InlineData(64)]
    public void ThrowsWhenKeyLengthIsNot32Bytes(int length)
    {
        var wrongLengthKey = new byte[length];
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 1, (1, wrongLengthKey));

        var ex = Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
        Assert.Contains("32", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ThrowsWhenActiveVersionIsNotAmongDeclaredKeys()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 5, (1, key));

        Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));
    }

    [Fact]
    public void ExceptionMessagesNeverContainRawKeyMaterial()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var base64Key = KeyRingTestHelpers.ToBase64(key);
        // Wrong length (31 bytes instead of 32) still travels through the loader as base64.
        var invalidKey = key[..^1];
        var path = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 1, (1, invalidKey));
        var invalidBase64 = KeyRingTestHelpers.ToBase64(invalidKey);

        var ex = Assert.Throws<KeyRingConfigurationException>(() => KeyRingLoader.Load(path));

        Assert.DoesNotContain(invalidBase64, ex.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(base64Key, ex.ToString(), StringComparison.Ordinal);
    }
}
