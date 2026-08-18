using System.Text;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Edge.Tests;

public sealed class HmacSigningTests
{
    private static (HmacRequestVerifier Verifier, HmacRequestSigner Signer, byte[] Secret, FakeTimeProvider Time)
        Build(TimeSpan? skew = null)
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-08-17T12:00:00Z"));
        var secret = EdgeTestSupport.NewSecret();
        var verifier = new HmacRequestVerifier(
            EdgeTestSupport.Resolver(secret),
            new InMemoryNonceReplayStore(),
            new SignatureVerificationOptions(skew ?? TimeSpan.FromMinutes(5)),
            time);
        return (verifier, new HmacRequestSigner(time), secret, time);
    }

    private static byte[] Body(string s = "{\"a\":1}") => Encoding.UTF8.GetBytes(s);

    [Fact]
    public void Valid_signature_is_accepted()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, secret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.Accepted, result.Outcome);
    }

    [Fact]
    public void Unknown_connector_is_rejected()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", "intruder", EdgeTestSupport.KeyId, secret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            "intruder", headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.UnknownConnector, result.Outcome);
    }

    [Fact]
    public void Unknown_key_id_is_rejected()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, "rotated-away", secret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, "rotated-away", headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.UnknownKey, result.Outcome);
    }

    [Fact]
    public void Clock_skew_beyond_bound_is_rejected()
    {
        var (verifier, signer, secret, time) = Build(TimeSpan.FromMinutes(1));
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, secret, body);
        time.Advance(TimeSpan.FromMinutes(5));

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.ClockSkew, result.Outcome);
    }

    [Fact]
    public void Tampered_body_fails_digest_check()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, secret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, Body("{\"a\":2}"));

        Assert.Equal(VerificationOutcome.BodyDigestMismatch, result.Outcome);
    }

    [Fact]
    public void Wrong_secret_fails_signature_check()
    {
        var (verifier, signer, _, _) = Build();
        var attackerSecret = EdgeTestSupport.NewSecret();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, attackerSecret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.SignatureMismatch, result.Outcome);
    }

    [Fact]
    public void Replayed_nonce_is_rejected_on_second_use()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, secret, body);

        var first = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);
        var second = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.Accepted, first.Outcome);
        Assert.Equal(VerificationOutcome.ReplayDetected, second.Outcome);
    }

    [Fact]
    public void Missing_headers_are_malformed()
    {
        var (verifier, _, _, _) = Build();
        var result = verifier.Verify("POST", "/api/v1/edge/ingest",
            null, null, null, null, null, null, Body());
        Assert.Equal(VerificationOutcome.Malformed, result.Outcome);
    }

    [Fact]
    public void Path_binding_prevents_cross_path_replay()
    {
        var (verifier, signer, secret, _) = Build();
        var body = Body();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", EdgeTestSupport.ConnectorId, EdgeTestSupport.KeyId, secret, body);

        var result = verifier.Verify("POST", "/api/v1/edge/other",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);

        Assert.Equal(VerificationOutcome.SignatureMismatch, result.Outcome);
    }
}
