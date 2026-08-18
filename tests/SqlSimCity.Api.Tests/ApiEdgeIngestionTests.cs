using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Api.Tests;

public sealed class ApiEdgeIngestionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "sqlsimcity-edge-api-" + Guid.NewGuid().ToString("N"));
    private readonly byte[] _secret = new byte[32];

    public ApiEdgeIngestionTests()
    {
        Directory.CreateDirectory(_root);
        for (var i = 0; i < _secret.Length; i++)
            _secret[i] = (byte)(i + 1);
        File.WriteAllText(Path.Combine(_root, "edge-1.key"), Convert.ToBase64String(_secret));
        File.WriteAllText(Path.Combine(_root, "catalog.json"),
            "{\"formatVersion\":1,\"connectors\":[{\"connectorId\":\"edge-1\",\"keys\":[{\"keyId\":\"k1\",\"secretFile\":\"edge-1.key\"}]}]}");
    }

    private WebApplicationFactory<ApiAssemblyMarker> EnabledFactory() =>
        new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(builder =>
        {
            builder.UseSetting("EdgeIngestion:Enabled", "true");
            builder.UseSetting("EdgeIngestion:SecretCatalogFile", Path.Combine(_root, "catalog.json"));
            builder.UseSetting("EdgeIngestion:SecretsDirectory", _root);
            builder.UseSetting("EdgeIngestion:NonceJournalPath", Path.Combine(_root, "nonces.log"));
            // In-process test clients share one rate-limit partition; keep it out of the way here.
            builder.UseSetting("HttpSecurity:ApiPermitLimit", "10000");
        });

    private static ObservationBatchV1 SampleBatch()
    {
        var builder = new ObservationBatchBuilder("edge-1", "target-1", "epoch-1", "boot-1");
        var freshness = new ObservationFreshnessV1(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);
        builder.AddSection(ObservationSection.Atlas, 1, DateTimeOffset.UnixEpoch, freshness, new { hello = "world" });
        return builder.Build(Guid.NewGuid().ToString("N"), DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
    }

    private HttpRequestMessage SignedRequest(byte[] body, byte[]? signingSecret = null)
    {
        var signer = new HmacRequestSigner();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", "edge-1", "k1", signingSecret ?? _secret, body);
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/edge/ingest")
        {
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Connector, headers.ConnectorId);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.KeyId, headers.KeyId);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Timestamp,
            headers.UnixTimeSeconds.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Nonce, headers.Nonce);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.ContentSha256, headers.BodySha256Hex);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Signature, headers.Signature);
        return request;
    }

    [Fact]
    public async Task IngestIsNotProcessedWhenDisabledByDefault()
    {
        await using var factory = new WebApplicationFactory<ApiAssemblyMarker>();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());

        using var request = SignedRequest(body);
        using var response = await client.SendAsync(request);

        // With ingestion disabled the route is never mapped, so a batch is never accepted (202).
        Assert.NotEqual(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Fact]
    public async Task ValidSignedBatchIsAccepted()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());

        using var request = SignedRequest(body);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Fact]
    public async Task WrongSecretIsRejectedUnauthorized()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());
        var attacker = new byte[32];
        Array.Fill(attacker, (byte)9);

        using var request = SignedRequest(body, attacker);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task NonJsonContentTypeIsRejected()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes("not json"));
        content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");

        using var response = await client.PostAsync("/api/v1/edge/ingest", content);

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
    }

    [Fact]
    public async Task StatusEndpointReportsIngestedTarget()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());
        using (var request = SignedRequest(body))
        using (await client.SendAsync(request)) { }

        using var status = await client.GetAsync("/api/v1/edge/status");
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        Assert.Contains("target-1", await status.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
                Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // The nonce journal may still be held briefly by a disposing host; cleanup is best-effort.
        }
    }
}
