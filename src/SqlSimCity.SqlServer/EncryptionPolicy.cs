namespace SqlSimCity.SqlServer;

/// <summary>
/// The TLS encryption requirement for a connection. There is no "optional"
/// case: every profile either requires TLS (<see cref="Mandatory"/>, the SQL
/// Server 2019-compatible default) or requires TDS 8.0 strict TLS
/// (<see cref="Strict"/>), which a profile opts into only once the target is
/// known to support it (SQL Server 2022+ or Azure SQL).
/// </summary>
public enum EncryptionPolicy
{
    /// <summary>TLS is required; the connection fails if the server cannot negotiate it. Supported since SQL Server 2019 and earlier.</summary>
    Mandatory,

    /// <summary>TDS 8.0 strict TLS is required; the connection fails if the server does not support it. Requires SQL Server 2022+ or Azure SQL.</summary>
    Strict,
}
