namespace SqlSimCity.Collection.Tests.Negotiation;

/// <summary>A minimal deterministic <see cref="TimeProvider"/> so tests can assert an exact <c>SourceTimestamp</c>.</summary>
public sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    private readonly DateTimeOffset _now = now;

    public override DateTimeOffset GetUtcNow() => _now;
}
