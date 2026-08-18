using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Collection.Tests.Probes;

/// <summary>
/// Regression coverage for a live Azure SQL Database failure: the server-identity probe threw
/// <see cref="InvalidCastException"/> on every sampling cycle, which aborted the whole cycle
/// instead of degrading one field.
///
/// The unit suite could not see it because every live-incident test substitutes a fake probe
/// executor, so the real <c>SqlDataReader</c> projection is never exercised. These tests cover the
/// two pure helpers that projection now depends on, which is the part that can be verified without
/// a live Azure SQL Database.
/// </summary>
public sealed class AzureSqlRowShapeTests
{
    [Fact]
    public void IsHadrEnabledTreatsAzureSqlNullAsNotEnabled()
    {
        // SERVERPROPERTY('IsHadrEnabled') is documented "Applies to: SQL Server", and SERVERPROPERTY
        // returns NULL for any property unsupported on the connected engine, so this is NULL on both
        // Azure SQL Database and Azure SQL Managed Instance.
        Assert.False(SqlClientProbeExecutor.IsHadrEnabled(DBNull.Value));
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, true)]
    public void IsHadrEnabledStillReadsRealSqlServerValues(int raw, bool expected)
    {
        Assert.Equal(expected, SqlClientProbeExecutor.IsHadrEnabled(raw));
    }

    [Fact]
    public void RowShapeFailuresAreClassifiedSoOneSubsystemDegradesInsteadOfTheWholeCycle()
    {
        // The live-incident collector records an UnavailableFieldV1 for any ProbeExecutionException
        // and still publishes the rest of the snapshot, but it cannot catch what it does not
        // recognize. Left unclassified, one platform-specific NULL costs every other subsystem's
        // evidence for that cycle.
        //
        // CA2201 forbids raising runtime-reserved exception types; these are only constructed to be
        // passed to a pure classification predicate, never thrown, and testing those exact types is
        // the entire point of this test.
#pragma warning disable CA2201
        Assert.True(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new InvalidCastException()));
        Assert.True(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new IndexOutOfRangeException()));
        Assert.True(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new FormatException()));
        Assert.True(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new OverflowException()));
#pragma warning restore CA2201
    }

    [Fact]
    public void GenuineProgrammingFaultsAreStillLeftToPropagate()
    {
        // Requirement 5 draws a deliberate boundary: a programming bug, a missing dependency, or an
        // out-of-memory condition must not be laundered into a per-probe "unavailable" result.
#pragma warning disable CA2201
        Assert.False(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new NullReferenceException()));
        Assert.False(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new OutOfMemoryException()));
#pragma warning restore CA2201
        Assert.False(SqlLiveIncidentProbeExecutor.IsRowShapeFailure(new OperationCanceledException()));
    }
}
