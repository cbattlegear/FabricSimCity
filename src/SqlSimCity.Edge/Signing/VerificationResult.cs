namespace SqlSimCity.Edge.Signing;

/// <summary>The outcome of verifying a signed connector request. Every non-<see cref="Accepted"/> value is a rejection.</summary>
public enum VerificationOutcome
{
    Accepted,
    Malformed,
    UnknownConnector,
    UnknownKey,
    ClockSkew,
    BodyDigestMismatch,
    SignatureMismatch,
    ReplayDetected,
}

/// <summary>
/// A verification decision plus a fixed, non-secret reason suitable for a curated error response.
/// The reason never echoes header values, body content, or secret material.
/// </summary>
public sealed record VerificationResult(VerificationOutcome Outcome, string Reason)
{
    public bool IsAccepted => Outcome == VerificationOutcome.Accepted;

    public static readonly VerificationResult Accepted = new(VerificationOutcome.Accepted, "Accepted.");
}
