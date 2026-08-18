namespace SqlSimCity.SqlServer;

/// <summary>
/// An opaque, caller-assigned connection profile identifier. It is never
/// interpreted or embedded in a connection string; it is only compared for
/// equality and surfaced in diagnostics so an operator can tell profiles apart.
/// </summary>
public readonly record struct ConnectionProfileId
{
    private const int MaxLength = 128;

    public ConnectionProfileId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (value.Length > MaxLength)
        {
            throw new ConnectionProfileValidationException(
                $"Connection profile id must be {MaxLength} characters or fewer.");
        }

        ConnectionValidation.EnsureNoControlCharacters(value, nameof(value));

        Value = value;
    }

    public string Value { get; }

    public override string ToString() => Value;

    public static implicit operator ConnectionProfileId(string value) => new(value);
}
