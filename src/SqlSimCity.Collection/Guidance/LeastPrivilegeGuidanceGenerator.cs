using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Guidance;

/// <summary>
/// Generates least-privilege GRANT guidance as plain text/T-SQL script, tailored to one
/// negotiated <see cref="TargetCapabilityProfileV1"/>. SqlSimCity never executes a grant: this
/// class only produces a string for an operator to review, edit, and run themselves, and every
/// identifier it writes goes through <see cref="SqlIdentifierQuoting"/> first.
/// </summary>
public sealed class LeastPrivilegeGuidanceGenerator
{
    /// <summary>Builds a commented GRANT script recommending the minimum permissions this negotiated profile needs.</summary>
    public static string GenerateGrantScript(TargetCapabilityProfileV1 profile, string principalName)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentException.ThrowIfNullOrWhiteSpace(principalName);

        var quotedPrincipal = SqlIdentifierQuoting.QuoteBracketIdentifier(principalName);
        var majorVersion = EngineVersion.TryParseMajorVersion(profile.Platform.ProductVersion);
        var modernPermissionModel = majorVersion is int mv && mv >= 16;

        var lines = new List<string>
        {
            "-- SqlSimCity least-privilege guidance (generated text only; review before running).",
            "-- SqlSimCity never executes GRANT/DENY/REVOKE statements itself.",
        };

        switch (profile.Platform.Platform)
        {
            case EnginePlatform.AzureSqlDatabase:
                lines.Add("-- Azure SQL Database enforces database-scoped permissions; connect to the target");
                lines.Add("-- database itself (not master) before running this script.");
                lines.Add($"GRANT VIEW DATABASE STATE TO {quotedPrincipal};");
                lines.Add("-- Some service tiers and Microsoft Entra role configurations impose additional");
                lines.Add("-- restrictions on top of VIEW DATABASE STATE; verify against the current tier's");
                lines.Add("-- documented permission model before granting this broadly.");
                break;

            case EnginePlatform.AzureSqlManagedInstance:
                lines.Add("-- Azure SQL Managed Instance follows the same permission-name split as SQL Server");
                lines.Add("-- on-premises, keyed to the connected engine build's major version.");
                AppendServerAndDatabaseGrants(lines, quotedPrincipal, modernPermissionModel);
                break;

            case EnginePlatform.SqlServerOnPremises:
                AppendServerAndDatabaseGrants(lines, quotedPrincipal, modernPermissionModel);
                break;

            default:
                lines.Add("-- This target's platform was not recognized as one SqlSimCity negotiates capabilities");
                lines.Add("-- for; no grant is recommended.");
                break;
        }

        return string.Join(Environment.NewLine, lines) + Environment.NewLine;
    }

    private static void AppendServerAndDatabaseGrants(List<string> lines, string quotedPrincipal, bool modernPermissionModel)
    {
        if (modernPermissionModel)
        {
            lines.Add("-- SQL Server 2022 (16.x) and later split VIEW SERVER/DATABASE STATE into a narrower");
            lines.Add("-- PERFORMANCE STATE permission; grant that instead of the legacy STATE permission.");
            lines.Add($"GRANT VIEW SERVER PERFORMANCE STATE TO {quotedPrincipal};");
            lines.Add($"GRANT VIEW DATABASE PERFORMANCE STATE TO {quotedPrincipal};");
        }
        else
        {
            lines.Add("-- SQL Server 2019 (15.x) and earlier require the broader legacy STATE permission.");
            lines.Add($"GRANT VIEW SERVER STATE TO {quotedPrincipal};");
            lines.Add($"GRANT VIEW DATABASE STATE TO {quotedPrincipal};");
        }
    }
}
