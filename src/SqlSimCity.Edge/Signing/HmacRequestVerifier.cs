using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Signing;

/// <summary>Bounds for accepting a signed request.</summary>
/// <param name="ClockSkew">Maximum absolute difference between the request timestamp and now.</param>
public sealed record SignatureVerificationOptions(TimeSpan ClockSkew)
{
    public static readonly SignatureVerificationOptions Default = new(TimeSpan.FromMinutes(5));

    /// <summary>How long a nonce must be remembered: the full window a request could still be valid.</summary>
    public TimeSpan NonceRetention => ClockSkew + ClockSkew;
}

/// <summary>
/// Authenticates an inbound connector request from its signature headers and body. Verification is
/// fail-closed and ordered so that cheap, non-cryptographic checks (allowlist, timestamp) run first,
/// the HMAC is compared in constant time, and a nonce is only ever consumed <em>after</em> the
/// signature is proven valid — so an unauthenticated caller can neither burn nonces nor learn timing
/// information about the secret. Reasons are fixed strings and never include header or body content.
/// </summary>
public sealed class HmacRequestVerifier
{
    private readonly IConnectorSecretResolver _secrets;
    private readonly INonceReplayStore _nonces;
    private readonly SignatureVerificationOptions _options;
    private readonly TimeProvider _timeProvider;

    public HmacRequestVerifier(
        IConnectorSecretResolver secrets,
        INonceReplayStore nonces,
        SignatureVerificationOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        _secrets = secrets ?? throw new ArgumentNullException(nameof(secrets));
        _nonces = nonces ?? throw new ArgumentNullException(nameof(nonces));
        _options = options ?? SignatureVerificationOptions.Default;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    /// <summary>
    /// Verifies a request. The header values are the connector's presented claims; <paramref name="body"/>
    /// is the exact received bytes. A rejection never mutates the replay store.
    /// </summary>
    public VerificationResult Verify(
        string method,
        string path,
        string? connectorId,
        string? keyId,
        string? timestampHeader,
        string? nonce,
        string? contentDigestHeader,
        string? signatureHeader,
        ReadOnlySpan<byte> body)
    {
        if (string.IsNullOrWhiteSpace(method) ||
            string.IsNullOrWhiteSpace(path) ||
            string.IsNullOrWhiteSpace(connectorId) ||
            string.IsNullOrWhiteSpace(keyId) ||
            string.IsNullOrWhiteSpace(timestampHeader) ||
            string.IsNullOrWhiteSpace(nonce) ||
            string.IsNullOrWhiteSpace(contentDigestHeader) ||
            string.IsNullOrWhiteSpace(signatureHeader))
        {
            return new VerificationResult(VerificationOutcome.Malformed, "Required signature headers are missing.");
        }

        if (nonce.Length is < 8 or > 128)
            return new VerificationResult(VerificationOutcome.Malformed, "Nonce length is out of range.");

        if (!_secrets.IsAllowed(connectorId))
            return new VerificationResult(VerificationOutcome.UnknownConnector, "Connector is not allowlisted.");

        if (!long.TryParse(timestampHeader, NumberStyles.Integer, CultureInfo.InvariantCulture, out var unixSeconds))
            return new VerificationResult(VerificationOutcome.Malformed, "Timestamp is not a valid Unix time.");

        var now = _timeProvider.GetUtcNow();
        var requestTime = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
        if ((now - requestTime).Duration() > _options.ClockSkew)
            return new VerificationResult(VerificationOutcome.ClockSkew, "Timestamp is outside the allowed clock skew.");

        // The presented content digest must match the actual body before we trust anything derived
        // from it, so a signature over a fabricated digest can never be paired with different bytes.
        var actualDigest = EdgeJson.Sha256Hex(body);
        if (!FixedTimeEqualsHex(actualDigest, contentDigestHeader))
            return new VerificationResult(VerificationOutcome.BodyDigestMismatch, "Body digest does not match the signed digest.");

        if (!_secrets.TryResolveSecret(connectorId, keyId, out var secret))
            return new VerificationResult(VerificationOutcome.UnknownKey, "Signing key id is unknown for this connector.");

        try
        {
            var canonical = new CanonicalSignedRequest(method, path, unixSeconds, nonce, connectorId, keyId, actualDigest);
            var expected = HmacRequestSigner.ComputeSignature(secret, canonical);
            if (!FixedTimeEqualsBase64(expected, signatureHeader))
                return new VerificationResult(VerificationOutcome.SignatureMismatch, "Request signature is invalid.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
        }

        // Only a fully authenticated request is allowed to consume a nonce, so replay-store writes
        // cannot be driven by unauthenticated traffic.
        var expiresAt = requestTime + _options.NonceRetention;
        return _nonces.TryRegister(connectorId, nonce, expiresAt)
            ? VerificationResult.Accepted
            : new VerificationResult(VerificationOutcome.ReplayDetected, "Request nonce has already been used.");
    }

    private static bool FixedTimeEqualsHex(string expected, string candidate)
    {
        var candidateBytes = Encoding.ASCII.GetBytes(candidate);
        var expectedBytes = Encoding.ASCII.GetBytes(expected);
        return CryptographicOperations.FixedTimeEquals(expectedBytes, candidateBytes);
    }

    private static bool FixedTimeEqualsBase64(string expected, string candidate)
    {
        // Compare the raw ASCII of both base64 strings in constant time. Length mismatch still
        // returns false but FixedTimeEquals requires equal-length spans, so pad-compare via ASCII.
        var expectedBytes = Encoding.ASCII.GetBytes(expected);
        var candidateBytes = Encoding.ASCII.GetBytes(candidate);
        if (expectedBytes.Length != candidateBytes.Length)
        {
            // Still perform a fixed-time comparison against itself to avoid leaking via early return.
            _ = CryptographicOperations.FixedTimeEquals(expectedBytes, expectedBytes);
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(expectedBytes, candidateBytes);
    }
}
