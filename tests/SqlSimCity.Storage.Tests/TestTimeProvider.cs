namespace SqlSimCity.Storage.Tests;

/// <summary>A deterministic, mutable <see cref="TimeProvider"/> for retention tests.</summary>
internal sealed class TestTimeProvider : TimeProvider
{
    private DateTimeOffset _utcNow;

    public TestTimeProvider(DateTimeOffset initialUtcNow)
    {
        _utcNow = initialUtcNow;
    }

    public override DateTimeOffset GetUtcNow() => _utcNow;

    public void Advance(TimeSpan delta) => _utcNow += delta;

    public void SetUtcNow(DateTimeOffset value) => _utcNow = value;
}
