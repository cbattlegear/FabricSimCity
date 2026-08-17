namespace SqlSimCity.SqlServer;

/// <summary>
/// Shared field-level checks used by every connection profile value type.
/// Every rejection raises <see cref="ConnectionProfileValidationException"/>
/// naming the field and the rule broken; no field's raw value is echoed back,
/// since a rejected field is exactly the kind of value that might carry
/// connection-string syntax or other unwanted content.
/// </summary>
internal static class ConnectionValidation
{
    // Characters that carry syntactic meaning inside an ADO.NET connection
    // string. SqlConnectionStringBuilder never string-concatenates these
    // profile fields, so this is not an injection defense by itself; it exists
    // so a field that later appears in a log or diagnostic cannot smuggle a
    // second key/value pair disguised as a plain identifier.
    private static readonly char[] ConnectionStringFragmentCharacters = [';', '=', '{', '}'];

    public static void EnsureNoControlCharacters(string value, string fieldName)
    {
        foreach (var ch in value)
        {
            if (char.IsControl(ch))
            {
                throw new ConnectionProfileValidationException($"{fieldName} must not contain control characters.");
            }
        }
    }

    public static void EnsureNoConnectionStringFragment(string value, string fieldName)
    {
        if (value.IndexOfAny(ConnectionStringFragmentCharacters) >= 0)
        {
            throw new ConnectionProfileValidationException(
                $"{fieldName} must not contain connection-string separator characters (';', '=', '{{', '}}').");
        }
    }

    public static void EnsureLength(string value, string fieldName, int minLength, int maxLength)
    {
        if (value.Length < minLength || value.Length > maxLength)
        {
            throw new ConnectionProfileValidationException(
                $"{fieldName} must be between {minLength} and {maxLength} characters long.");
        }
    }
}
