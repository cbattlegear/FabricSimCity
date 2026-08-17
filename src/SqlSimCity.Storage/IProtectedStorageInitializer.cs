namespace SqlSimCity.Storage;

/// <summary>
/// Performs the fail-closed startup sequence for protected storage: schema
/// migration and encrypted canary creation/verification. A host must await
/// <see cref="EnsureReadyAsync"/> before serving traffic when protected storage
/// is enabled; any exception must prevent the process from becoming ready.
/// </summary>
public interface IProtectedStorageInitializer
{
    Task EnsureReadyAsync(CancellationToken cancellationToken = default);
}
