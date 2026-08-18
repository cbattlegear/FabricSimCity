using System.Net;
using System.Text;
using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// An optional, loopback-only health endpoint. It binds strictly to <c>127.0.0.1</c> and answers a
/// single generic GET with a small JSON status (spool occupancy, paused/auth-fault flags). It exposes
/// no target ids, no evidence, and no control surface — there is deliberately no inbound command API
/// on the connector. Binding is best-effort: a failure to bind is logged and the connector continues.
/// </summary>
public sealed class LoopbackHealthServer : IDisposable
{
    private readonly HttpListener _listener;
    private readonly EncryptedSpool _spool;
    private readonly DeliveryPump _pump;
    private readonly StructuredLog _log;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    private LoopbackHealthServer(HttpListener listener, EncryptedSpool spool, DeliveryPump pump, StructuredLog log)
    {
        _listener = listener;
        _spool = spool;
        _pump = pump;
        _log = log;
    }

    public static LoopbackHealthServer? TryStart(int port, EncryptedSpool spool, DeliveryPump pump, StructuredLog log)
    {
        if (port == 0)
            return null;

        try
        {
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
            var server = new LoopbackHealthServer(listener, spool, pump, log);
            server._loop = server.AcceptLoopAsync();
            log.Info("connector.health_listening", new Dictionary<string, object?> { ["port"] = port });
            return server;
        }
        catch (Exception ex) when (ex is HttpListenerException or PlatformNotSupportedException)
        {
            log.Warn("connector.health_bind_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
            return null;
        }
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (_cts.IsCancellationRequested)
            {
                return;
            }
            catch (HttpListenerException)
            {
                return;
            }

            try
            {
                var status = _spool.GetStatus();
                var body = Encoding.UTF8.GetBytes(
                    $"{{\"status\":\"healthy\",\"spoolItems\":{status.ItemCount},\"paused\":{status.Paused.ToString().ToLowerInvariant()},\"authFaulted\":{_pump.AuthFaulted.ToString().ToLowerInvariant()}}}");
                context.Response.StatusCode = 200;
                context.Response.ContentType = "application/json";
                context.Response.OutputStream.Write(body, 0, body.Length);
            }
            catch (Exception)
            {
                // Never let a health request affect delivery.
            }
            finally
            {
                context.Response.Close();
            }
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try
        {
            _listener.Stop();
            _listener.Close();
        }
        catch (ObjectDisposedException)
        {
        }

        _cts.Dispose();
    }
}
