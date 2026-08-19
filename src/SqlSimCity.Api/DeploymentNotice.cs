namespace SqlSimCity.Api;

/// <summary>
/// Resolves whether an operator has acknowledged the deployment security notice
/// the UI shows by default -- that SQLSimCity ships with no login of its own, so
/// anyone who can reach the page sees all evidence.
///
/// Acknowledging is a display decision and nothing more. It suppresses the
/// browser banner so a demo or a screen recording is not dominated by a notice
/// its audience has already read, and it changes nothing about how the service
/// behaves: no authentication appears, no host binding relaxes, and the startup
/// warnings this process writes to its log -- an inline connection string, or
/// query text and plan XML retained in the clear -- are deliberately left at
/// warning level and are never suppressed by this setting. The log stays the
/// durable record precisely because the screen no longer carries it.
///
/// Two spellings resolve, first one present wins: the
/// <c>Deployment:AcknowledgeSecurityWarnings</c> configuration key (settable as
/// the <c>Deployment__AcknowledgeSecurityWarnings</c> environment variable), then
/// the unprefixed <c>SQLSIMCITY_ACKNOWLEDGE_SECURITY_WARNINGS</c> environment
/// variable, matching how <see cref="SqlSimCityConnectionString"/> is spelled.
///
/// The default is false, and it fails toward showing the notice: only an explicit
/// affirmative hides it. A value that is neither affirmative nor negative stops
/// startup rather than being guessed at, because silently treating a typo as
/// "keep warning" would leave an operator believing they had configured
/// something they had not.
/// </summary>
public static class DeploymentNotice
{
    /// <summary>The configuration key, using the standard section-scoped spelling.</summary>
    public const string ConfigurationKey = "Deployment:AcknowledgeSecurityWarnings";

    /// <summary>The unprefixed environment variable, for parity with the connection string.</summary>
    public const string EnvironmentVariableName = "SQLSIMCITY_ACKNOWLEDGE_SECURITY_WARNINGS";

    public static bool IsAcknowledged(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        foreach (var key in new[] { ConfigurationKey, EnvironmentVariableName })
        {
            var raw = configuration[key];
            if (string.IsNullOrWhiteSpace(raw)) continue;
            return Parse(raw.Trim(), key);
        }

        return false;
    }

    private static bool Parse(string value, string key) => value.ToLowerInvariant() switch
    {
        "true" or "1" or "yes" or "on" => true,
        "false" or "0" or "no" or "off" => false,
        _ => throw new InvalidOperationException(
            $"{key} must be true or false (1/0, yes/no, and on/off are also accepted); " +
            $"'{value}' is neither, and the deployment security notice is not something to guess at."),
    };
}
