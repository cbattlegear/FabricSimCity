namespace SqlSimCity.Storage;

/// <summary>
/// An opaque, caller-assigned record identifier. It is never interpreted; it is
/// only compared for equality and bound as authenticated associated data so a
/// ciphertext envelope cannot be swapped between records.
/// </summary>
public readonly record struct ProtectedRecordId
{
    private const int MaxLength = 256;

    public ProtectedRecordId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (value.Length > MaxLength)
        {
            throw new ArgumentException($"Record id must be {MaxLength} characters or fewer.", nameof(value));
        }

        Value = value;
    }

    public string Value { get; }

    public override string ToString() => Value;

    public static implicit operator ProtectedRecordId(string value) => new(value);
}
