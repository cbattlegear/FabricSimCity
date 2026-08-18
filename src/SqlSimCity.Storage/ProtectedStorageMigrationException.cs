namespace SqlSimCity.Storage;

/// <summary>
/// The on-disk schema version (<c>PRAGMA user_version</c>) is newer than this
/// build supports, or a migration step failed. Never leaves a store partially
/// migrated: each migration step runs inside a transaction.
/// </summary>
public sealed class ProtectedStorageMigrationException : Exception
{
    public ProtectedStorageMigrationException(string message)
        : base(message)
    {
    }

    public ProtectedStorageMigrationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
