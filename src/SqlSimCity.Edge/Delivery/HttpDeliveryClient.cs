using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Edge.Delivery;

/// <summary>Configuration for the outward HTTPS delivery transport.</summary>
public sealed record HttpDeliveryOptions
{
    /// <summary>The absolute central ingestion URL. Must be HTTPS unless it is an explicit loopback dev endpoint.</summary>
    public required Uri IngestEndpoint { get; init; }

    /// <summary>Opaque connector identity presented for signing.</summary>
    public required string ConnectorId { get; init; }

    /// <summary>Signing key id (for rotation) presented in the request.</summary>
    public required string KeyId { get; init; }

    /// <summary>Allow plain HTTP only when the endpoint is a loopback address, for local development.</summary>
    public bool AllowLoopbackHttp { get; init; }

    internal void Validate()
    {
        ArgumentNullException.ThrowIfNull(IngestEndpoint);
        if (string.IsNullOrWhiteSpace(ConnectorId))
            throw new ArgumentException("Delivery ConnectorId must be configured.");
        if (string.IsNullOrWhiteSpace(KeyId))
            throw new ArgumentException("Delivery KeyId must be configured.");
        if (!IngestEndpoint.IsAbsoluteUri)
            throw new ArgumentException("Delivery IngestEndpoint must be an absolute URI.");

        if (IngestEndpoint.Scheme == Uri.UriSchemeHttps)
            return;

        var isLoopback = IngestEndpoint.IsLoopback;
        if (IngestEndpoint.Scheme == Uri.UriSchemeHttp && AllowLoopbackHttp && isLoopback)
            return;

        throw new ArgumentException(
            "Delivery IngestEndpoint must use HTTPS. Plain HTTP is permitted only for an explicit loopback development endpoint.");
    }
}

/// <summary>
/// Delivers sealed batches to the central endpoint over HTTPS, signing each request with the
/// connector's shared secret. HTTP downgrade is refused at construction (only a loopback dev endpoint
/// may be plain HTTP). The secret is fetched per request from a caller-supplied accessor and zeroed
/// immediately after signing; it is never retained, logged, or placed in a header.
/// </summary>
public sealed class HttpDeliveryClient : IDeliveryTransport
{
    private readonly HttpClient _httpClient;
    private readonly HttpDeliveryOptions _options;
    private readonly HmacRequestSigner _signer;
    private readonly Func<byte[]> _secretAccessor;

    public HttpDeliveryClient(
        HttpClient httpClient,
        HttpDeliveryOptions options,
        Func<byte[]> secretAccessor,
        HmacRequestSigner? signer = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _options.Validate();
        _secretAccessor = secretAccessor ?? throw new ArgumentNullException(nameof(secretAccessor));
        _signer = signer ?? new HmacRequestSigner();
    }

    public async Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(batch);
        var body = EdgeJson.SerializeToUtf8Bytes(batch);

        using var request = new HttpRequestMessage(HttpMethod.Post, _options.IngestEndpoint)
        {
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };

        var secret = _secretAccessor();
        try
        {
            var headers = _signer.Sign(
                "POST", _options.IngestEndpoint.PathAndQuery, _options.ConnectorId, _options.KeyId, secret, body);
            foreach (var (name, value) in headers.ToHeaderMap())
                request.Headers.TryAddWithoutValidation(name, value);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
        }

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            return new DeliveryResponse(DeliveryOutcome.Transient);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Request timeout (not a shutdown cancellation) — treat as transient.
            return new DeliveryResponse(DeliveryOutcome.Transient);
        }

        using (response)
        {
            return Map(response);
        }
    }

    private static DeliveryResponse Map(HttpResponseMessage response) => response.StatusCode switch
    {
        HttpStatusCode.OK or HttpStatusCode.Accepted or HttpStatusCode.NoContent => DeliveryResponse.Accepted,
        HttpStatusCode.Conflict => new DeliveryResponse(DeliveryOutcome.Conflict),
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new DeliveryResponse(DeliveryOutcome.AuthRejected),
        HttpStatusCode.RequestEntityTooLarge => new DeliveryResponse(DeliveryOutcome.PayloadTooLarge),
        HttpStatusCode.TooManyRequests => new DeliveryResponse(DeliveryOutcome.RateLimited, ParseRetryAfter(response)),
        HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity or HttpStatusCode.UnsupportedMediaType
            => new DeliveryResponse(DeliveryOutcome.PermanentReject),
        _ when (int)response.StatusCode >= 500 => new DeliveryResponse(DeliveryOutcome.Transient),
        _ => new DeliveryResponse(DeliveryOutcome.PermanentReject),
    };

    private static TimeSpan? ParseRetryAfter(HttpResponseMessage response)
    {
        var retryAfter = response.Headers.RetryAfter;
        if (retryAfter is null)
            return null;
        if (retryAfter.Delta is { } delta)
            return delta;
        if (retryAfter.Date is { } date)
        {
            var remaining = date - DateTimeOffset.UtcNow;
            return remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero;
        }

        return null;
    }
}
