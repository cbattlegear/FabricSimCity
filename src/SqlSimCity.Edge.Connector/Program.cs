using System.Collections;
using SqlSimCity.Edge.Connector;
using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Spool;

var log = new StructuredLog();

try
{
    var env = new Dictionary<string, string?>(StringComparer.Ordinal);
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        env[(string)entry.Key] = entry.Value as string;

    var options = ConnectorOptions.FromEnvironment(env);

    if (options.Connected?.InlineSecrets is not null)
    {
        // The connector's normal rule is that no secret ever comes from the
        // environment. A connection-string password is the one opt-in exception,
        // so say so once at startup rather than letting it pass silently.
        log.Warn("connector.inline_connection_string_password", new Dictionary<string, object?>
        {
            ["message"] = "SQLSIMCITY_EDGE_SQL_CONNECTION_STRING carries a password in this process's environment. " +
                "It cannot be rotated without a restart; mount a secret file instead for production.",
        });
    }

    // Load key material from files (fail-closed). Secrets are never read from environment plaintext.
    var signingSecret = FileSigningSecret.Load(options.SigningSecretFile);
    using var spoolKey = SpoolKeyLoader.Load(options.SpoolKeyFile);

    var spool = new EncryptedSpool(
        new SpoolOptions
        {
            DataDirectory = options.SpoolDirectory,
            MaxBytes = options.SpoolMaxBytes,
            MaxItems = options.SpoolMaxItems,
            MaxAge = options.SpoolMaxAge,
        },
        spoolKey);

    using var handler = new SocketsHttpHandler
    {
        AllowAutoRedirect = false, // Never follow a redirect to an http downgrade.
        ConnectTimeout = TimeSpan.FromSeconds(15),
    };
    using var httpClient = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };

    var transport = new HttpDeliveryClient(
        httpClient,
        new HttpDeliveryOptions
        {
            IngestEndpoint = options.IngestEndpoint,
            ConnectorId = options.ConnectorId,
            KeyId = options.KeyId,
            AllowLoopbackHttp = options.AllowLoopbackHttp,
        },
        secretAccessor: signingSecret.Read);

    var pump = new DeliveryPump(spool, transport);

    var bootId = Guid.NewGuid().ToString("N");
    var epochId = bootId; // A fresh process boot is a fresh epoch; the central resets deltas accordingly.
    await using var connectedProvider = options.SourceMode == ConnectorSourceMode.Connected
        ? await ConnectedObservationProvider.CreateAsync(options.Connected!)
        : null;
    IObservationProvider provider = (IObservationProvider?)connectedProvider ??
        new FixtureObservationProvider(options.FixturesDirectory, options.TargetId);
    var collector = new ConnectorObservationCollector(options, provider, bootId, epochId);

    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        cts.Cancel();
    };
    AppDomain.CurrentDomain.ProcessExit += (_, _) => cts.Cancel();

    using var health = LoopbackHealthServer.TryStart(options.LoopbackHealthPort, spool, pump, log);

    var runtime = new ConnectorRuntime(options, log, collector, pump, spool, TimeProvider.System);
    await runtime.RunAsync(cts.Token);
    return 0;
}
catch (ConnectorConfigurationException ex)
{
    log.Error("connector.config_error", new Dictionary<string, object?> { ["message"] = ex.Message });
    return 78; // EX_CONFIG
}
catch (Exception ex)
{
    log.Error("connector.fatal", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
    return 1;
}
