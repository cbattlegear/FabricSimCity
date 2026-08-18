using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// The provisioner exists to serve operators who never chose to think about
/// encryption keys, so its output has to satisfy the same strict reader a
/// hand-authored production key does. These tests pin the writer to the reader
/// rather than to a copy of the format.
/// </summary>
public sealed class KeyRingProvisionerTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-provisioner-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private string KeyPath => Path.Combine(_directory, "nested", "storage-key.json");

    [Fact]
    public void GeneratedKeyIsAcceptedByTheStrictLoader()
    {
        Assert.True(KeyRingProvisioner.TryCreate(KeyPath));

        // The whole point: a generated key must be indistinguishable from a
        // mounted one as far as the loader is concerned.
        using var keyRing = KeyRingLoader.Load(KeyPath);

        Assert.Equal(1u, keyRing.ActiveKeyVersion);
    }

    [Fact]
    public void GeneratedKeyCanActuallyDecryptWhatItEncrypts()
    {
        KeyRingProvisioner.TryCreate(KeyPath);
        using var keyRing = KeyRingLoader.Load(KeyPath);

        var plaintext = "SELECT TOP (1) * FROM sys.objects;"u8.ToArray();
        var envelope = EnvelopeCodec.Seal(keyRing, "queryText", "family-1", plaintext);

        Assert.Equal(plaintext, EnvelopeCodec.Open(keyRing, "queryText", "family-1", envelope));
    }

    [Fact]
    public void MissingParentDirectoriesAreCreated()
    {
        Assert.False(Directory.Exists(Path.GetDirectoryName(KeyPath)));

        Assert.True(KeyRingProvisioner.TryCreate(KeyPath));

        Assert.True(File.Exists(KeyPath));
    }

    [Fact]
    public void AnExistingKeyIsNeverOverwritten()
    {
        KeyRingProvisioner.TryCreate(KeyPath);
        var original = File.ReadAllText(KeyPath);

        // Replacing a key whose data still exists would orphan every record it
        // protected, so a second call must report that it created nothing.
        Assert.False(KeyRingProvisioner.TryCreate(KeyPath));
        Assert.Equal(original, File.ReadAllText(KeyPath));
    }

    [Fact]
    public void EachGeneratedKeyIsDistinct()
    {
        var first = Path.Combine(_directory, "first.json");
        var second = Path.Combine(_directory, "second.json");

        KeyRingProvisioner.TryCreate(first);
        KeyRingProvisioner.TryCreate(second);

        Assert.NotEqual(File.ReadAllText(first), File.ReadAllText(second));
    }

    [Fact]
    public void GeneratedKeyIsNotReadableByOtherUsers()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        KeyRingProvisioner.TryCreate(KeyPath);

        var mode = File.GetUnixFileMode(KeyPath);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, mode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankPathIsRejectedRatherThanGuessed(string path)
        => Assert.Throws<ArgumentException>(() => KeyRingProvisioner.TryCreate(path));
}
