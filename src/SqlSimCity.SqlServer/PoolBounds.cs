namespace SqlSimCity.SqlServer;

/// <summary>
/// Validated ADO.NET connection pool bounds. Both bounds are capped well below
/// what a single process should ever need for one target, so a typo (an extra
/// zero) fails validation instead of quietly exhausting server connection
/// slots.
/// </summary>
public sealed class PoolBounds
{
    public const int MinAllowed = 0;
    public const int MaxAllowed = 1_000;

    public int MinPoolSize { get; }

    public int MaxPoolSize { get; }

    public PoolBounds(int minPoolSize, int maxPoolSize)
    {
        if (minPoolSize < MinAllowed || minPoolSize > MaxAllowed)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(minPoolSize)} must be between {MinAllowed} and {MaxAllowed}.");
        }

        if (maxPoolSize < 1 || maxPoolSize > MaxAllowed)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(maxPoolSize)} must be between 1 and {MaxAllowed}.");
        }

        if (minPoolSize > maxPoolSize)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(minPoolSize)} must not exceed {nameof(maxPoolSize)}.");
        }

        MinPoolSize = minPoolSize;
        MaxPoolSize = maxPoolSize;
    }
}
