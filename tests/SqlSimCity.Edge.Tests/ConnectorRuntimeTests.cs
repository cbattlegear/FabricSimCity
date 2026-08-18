using SqlSimCity.Edge.Connector;
using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Tests;

public sealed class ConnectorRuntimeTests
{
    [Fact]
    public async Task RequestedShutdownStillRunsFinalSpoolDrain()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "runtime-drain-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var key = new SpoolKey(1, new byte[32]);
            var spool = new EncryptedSpool(
                new SpoolOptions { DataDirectory = root }, key);
            var transport = new FirstTransientTransport();
            var pump = new DeliveryPump(spool, transport);
            pump.Submit(EdgeTestSupport.SampleBatch());
            var options = new ConnectorOptions
            {
                ConnectorId = "connector",
                TargetId = "target",
                KeyId = "key",
                IngestEndpoint = new Uri("https://central.example/api/v1/edge/ingest"),
                SigningSecretFile = "signing",
                SpoolDirectory = root,
                SpoolKeyFile = "spool-key",
                FixturesDirectory = root,
                CollectInterval = TimeSpan.FromHours(1),
                DeliverInterval = TimeSpan.FromHours(1),
            };
            var collector = new ConnectorObservationCollector(
                options, new CancellableProvider(), "boot", "epoch");
            var runtime = new ConnectorRuntime(
                options, new StructuredLog(), collector, pump, spool, TimeProvider.System);
            using var cancellation = new CancellationTokenSource();
            var running = runtime.RunAsync(cancellation.Token);

            await transport.FirstCall.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await cancellation.CancelAsync();
            await running;

            Assert.Equal(2, transport.Calls);
            Assert.Equal(0, spool.GetStatus().ItemCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class CancellableProvider : IObservationProvider
    {
        public async Task<IReadOnlyList<ObservationInput>> CollectAsync(
            DateTimeOffset now,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return [];
        }
    }

    private sealed class FirstTransientTransport : IDeliveryTransport
    {
        public TaskCompletionSource FirstCall { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Calls { get; private set; }

        public Task<DeliveryResponse> SendAsync(
            ObservationBatchV1 batch,
            CancellationToken cancellationToken)
        {
            Calls++;
            if (Calls == 1)
            {
                FirstCall.TrySetResult();
                return Task.FromResult(new DeliveryResponse(
                    DeliveryOutcome.Transient, TimeSpan.FromHours(1)));
            }
            return Task.FromResult(DeliveryResponse.Accepted);
        }
    }
}
