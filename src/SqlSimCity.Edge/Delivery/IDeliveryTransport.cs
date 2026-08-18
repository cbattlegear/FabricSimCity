using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Delivery;

/// <summary>
/// Sends one sealed batch to the central ingestion endpoint. Abstracted so the delivery pump can be
/// tested against an in-memory fake with no real network, and so a real HTTPS transport can be
/// swapped in without changing pump logic.
/// </summary>
public interface IDeliveryTransport
{
    Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken);
}
