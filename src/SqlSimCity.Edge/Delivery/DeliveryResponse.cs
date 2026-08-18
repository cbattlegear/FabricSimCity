namespace SqlSimCity.Edge.Delivery;

/// <summary>How the central server (or the transport) responded to a delivery attempt.</summary>
public enum DeliveryOutcome
{
    /// <summary>The batch was accepted (new or idempotent duplicate).</summary>
    Accepted,

    /// <summary>The batch conflicts with central state and must not be retried unchanged.</summary>
    Conflict,

    /// <summary>Authentication or authorization failed; retrying the same request is futile and must stop.</summary>
    AuthRejected,

    /// <summary>The batch was too large and must be split at chunk boundaries before retry.</summary>
    PayloadTooLarge,

    /// <summary>The server asked the connector to slow down; honor <see cref="DeliveryResponse.RetryAfter"/>.</summary>
    RateLimited,

    /// <summary>A transient network or server error; retry later with backoff.</summary>
    Transient,

    /// <summary>The server permanently rejected the batch (bad request); it must not be retried unchanged.</summary>
    PermanentReject,
}

/// <summary>The result of one delivery attempt.</summary>
public sealed record DeliveryResponse(DeliveryOutcome Outcome, TimeSpan? RetryAfter = null)
{
    public static readonly DeliveryResponse Accepted = new(DeliveryOutcome.Accepted);
}
