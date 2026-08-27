using System.Reflection;
using SqlSimCity.Collection;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// The live sampler and the Query Store collector each report a <c>binary(8)</c> query hash, and the
/// city map joins a running request to a query family by comparing those two as strings. The join is
/// therefore only as good as the agreement between two renderings produced in different files.
/// <para>
/// A disagreement here is silent and expensive: a hash rendered <c>0x634927f9f8cc7502</c> on one side
/// and <c>634927F9F8CC7502</c> on the other matches nothing, and "no request matched a family" is
/// drawn exactly like "no request is running". These tests pin the shared converter and the value it
/// produces so that failure has to be a red test rather than an empty map.
/// </para>
/// </summary>
public sealed class QueryHashJoinKeyTests
{
    // A real sys.query_store_query.query_hash value, as bytes. Pinned as a literal so the expected
    // rendering below is a fact about the format and not a restatement of the code under test.
    private static readonly byte[] SampleHash = [0x63, 0x49, 0x27, 0xF9, 0xF8, 0xCC, 0x75, 0x02];

    private const string SampleHashText = "634927F9F8CC7502";

    [Fact]
    public void RenderProducesUppercaseHexWithoutAnOxPrefix()
    {
        Assert.Equal(SampleHashText, QueryHashFormat.Render(SampleHash));
        Assert.DoesNotContain("0x", QueryHashFormat.Render(SampleHash), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void QueryStoreCollectorRendersHashesThroughTheSharedConverter()
    {
        // Reached by reflection on purpose. The point of this test is that the *production* Query
        // Store rendering equals the live rendering, so asserting against a reimplementation of it
        // here would prove nothing. If Hash is renamed or removed, this fails loudly rather than
        // quietly ceasing to check anything.
        var hash = typeof(SqlQueryStoreIncrementalSource).GetMethod(
            "Hash", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(hash);

        var queryStoreRendering = (string?)hash!.Invoke(null, [SampleHash]);

        Assert.Equal(SampleHashText, queryStoreRendering);
        Assert.Equal(QueryHashFormat.ToJoinKey(SampleHash), queryStoreRendering);
    }

    [Fact]
    public void AnAllZeroHashIsAnAbsenceRatherThanAFamily()
    {
        // The engine reports 0x0000000000000000 for a request it did not hash. Letting that through
        // would collide every unhashed request onto one shared key that no Query Store family owns,
        // which reads as a busy road rather than as missing evidence.
        Assert.Null(QueryHashFormat.ToJoinKey(new byte[8]));
        Assert.Null(QueryHashFormat.ToJoinKey((byte[]?)null));
        Assert.Null(QueryHashFormat.ToJoinKey([]));
        Assert.Null(QueryHashFormat.ToJoinKey((object?)DBNull.Value));
    }

    [Fact]
    public async Task ACollectedRequestCarriesTheJoinKeyInTheSameFormTheFamilyDoes()
    {
        var row = new ActiveRequestRow(
            71, "app_user", "app-host", "MyApp", "running",
            null, null, 0, "running", "SELECT", null, null, null, null,
            DateTimeOffset.UnixEpoch, 5, 5, 1, 1, 1, 0, 5, "AppDb", "SELECT 1", "SELECT 1",
            0, 1, "SELECT 1".Length, "SELECT 1".Length,
            SampleHash, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        var unhashedRow = row with
        {
            SessionId = 72,
            SelectionRank = 2,
            QueryHash = new byte[8],
            QueryPlanHash = null,
        };

        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(
                FakeLiveIncidentProbeExecutor.DefaultIdentity(DateTimeOffset.UnixEpoch)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([row, unhashedRow]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var hashed = Assert.Single(snapshot.Requests, r => r.SessionId == 71);
        Assert.Equal(SampleHashText, hashed.QueryHash);
        Assert.Equal("0102030405060708", hashed.QueryPlanHash);

        var unhashed = Assert.Single(snapshot.Requests, r => r.SessionId == 72);
        Assert.Null(unhashed.QueryHash);
        Assert.Null(unhashed.QueryPlanHash);
    }
}
