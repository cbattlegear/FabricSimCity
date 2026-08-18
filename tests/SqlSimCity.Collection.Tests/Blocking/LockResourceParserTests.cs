using SqlSimCity.Collection.Blocking;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests;

public sealed class LockResourceParserTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ParseReturnsNullWhenNoResourceWasReported(string? raw)
    {
        Assert.Null(LockResourceParser.Parse(raw));
    }

    [Fact]
    public void ParseResolvesObjectLocksWithoutAnyLookup()
    {
        var parsed = LockResourceParser.Parse("OBJECT: 7:1234567:0");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Object, parsed!.Kind);
        Assert.Equal(7, parsed.DatabaseId);
        Assert.Equal(1234567, parsed.ObjectId);
        Assert.Equal(LockResolutionStatus.Resolved, parsed.Status);
        Assert.Null(parsed.HobtId);
    }

    [Fact]
    public void ParseResolvesTabLocksTheSameWayAsObjectLocks()
    {
        var parsed = LockResourceParser.Parse("TAB: 5:98765");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Object, parsed!.Kind);
        Assert.Equal(5, parsed.DatabaseId);
        Assert.Equal(98765, parsed.ObjectId);
        Assert.Equal(LockResolutionStatus.Resolved, parsed.Status);
    }

    [Fact]
    public void ParseKeepsKeyLocksAsHobtsThatStillNeedALookup()
    {
        var parsed = LockResourceParser.Parse("KEY: 7:72057594043170816 (8194443284a0)");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Key, parsed!.Kind);
        Assert.Equal(7, parsed.DatabaseId);
        Assert.Equal(72057594043170816L, parsed.HobtId);
        Assert.Null(parsed.ObjectId);
        Assert.Equal(LockResolutionStatus.RequiresLookup, parsed.Status);
        Assert.Contains("hobt_id", parsed.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ParseReadsHobtLocksWithoutAHash()
    {
        var parsed = LockResourceParser.Parse("HOBT: 7:72057594043170816");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.HoBt, parsed!.Kind);
        Assert.Equal(72057594043170816L, parsed.HobtId);
        Assert.Equal(LockResolutionStatus.RequiresLookup, parsed.Status);
    }

    [Fact]
    public void ParseReadsAllocationUnitLocksAsHobtScoped()
    {
        var parsed = LockResourceParser.Parse("ALLOCUNIT: 7:72057594043170816");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.AllocationUnit, parsed!.Kind);
        Assert.Equal(72057594043170816L, parsed.HobtId);
        Assert.Equal(LockResolutionStatus.RequiresLookup, parsed.Status);
    }

    [Theory]
    [InlineData("PAGE: 7:1:26483", LockResourceKind.Page)]
    [InlineData("RID: 7:1:26483:12", LockResourceKind.Rid)]
    public void ParseRefusesToGuessAnObjectForPhysicalLocations(string raw, LockResourceKind expected)
    {
        var parsed = LockResourceParser.Parse(raw);

        Assert.NotNull(parsed);
        Assert.Equal(expected, parsed!.Kind);
        Assert.Equal(7, parsed.DatabaseId);
        Assert.Null(parsed.ObjectId);
        Assert.Null(parsed.HobtId);
        Assert.Equal(LockResolutionStatus.Unresolvable, parsed.Status);
        Assert.Contains("too costly", parsed.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("DATABASE: 7:0", LockResourceKind.Database)]
    [InlineData("FILE: 7:1", LockResourceKind.File)]
    [InlineData("EXTENT: 7:1:26480", LockResourceKind.Extent)]
    [InlineData("APPLICATION: 7:[nightly-load]:(hash)", LockResourceKind.Application)]
    [InlineData("METADATA: database_id = 7 SCHEMA(schema_id = 1)", LockResourceKind.Metadata)]
    public void ParseMarksNonObjectLocksAsNotObjectScoped(string raw, LockResourceKind expected)
    {
        var parsed = LockResourceParser.Parse(raw);

        Assert.NotNull(parsed);
        Assert.Equal(expected, parsed!.Kind);
        Assert.Null(parsed.ObjectId);
        Assert.Equal(LockResolutionStatus.NotObjectScoped, parsed.Status);
        Assert.NotEmpty(parsed.Reason);
    }

    [Fact]
    public void ParseLeavesUnknownFormsUnrecognizedRatherThanGuessing()
    {
        var parsed = LockResourceParser.Parse("SOMETHINGNEW: 7:1:2");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Unrecognized, parsed!.Kind);
        Assert.Equal(LockResolutionStatus.Unrecognized, parsed.Status);
        Assert.Null(parsed.ObjectId);
        Assert.Contains("SOMETHINGNEW", parsed.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseReportsTextWithNoKindPrefixAsUnrecognized()
    {
        var parsed = LockResourceParser.Parse("7:1:26483");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Unrecognized, parsed!.Kind);
        Assert.Equal(LockResolutionStatus.Unrecognized, parsed.Status);
    }

    [Fact]
    public void ParseIsCaseInsensitiveOnThePrefix()
    {
        var parsed = LockResourceParser.Parse("key: 7:72057594043170816 (8194443284a0)");

        Assert.NotNull(parsed);
        Assert.Equal(LockResourceKind.Key, parsed!.Kind);
        Assert.Equal(72057594043170816L, parsed.HobtId);
    }

    [Fact]
    public void ParseAlwaysPreservesTheEngineText()
    {
        const string raw = "KEY: 7:72057594043170816 (8194443284a0)";

        Assert.Equal(raw, LockResourceParser.Parse(raw)!.RawResource);
    }

    [Fact]
    public void ResolveCompletesAHobtLockWithCatalogIdentity()
    {
        var parsed = LockResourceParser.Parse("KEY: 7:72057594043170816 (8194443284a0)")!;

        var resolved = LockResourceParser.Resolve(parsed, 200, 1, "dbo", "OrderHeader", "PK_OrderHeader", LockResourceParser.CatalogLookupReason);

        Assert.Equal(LockResolutionStatus.Resolved, resolved.Status);
        Assert.Equal(200, resolved.ObjectId);
        Assert.Equal(1, resolved.IndexId);
        Assert.Equal("dbo", resolved.SchemaName);
        Assert.Equal("OrderHeader", resolved.ObjectName);
        Assert.Equal("PK_OrderHeader", resolved.IndexName);
        Assert.Equal(72057594043170816L, resolved.HobtId);
        Assert.Equal(7, resolved.DatabaseId);
    }

    [Fact]
    public void ResolveLeavesAPageLockAlone()
    {
        var parsed = LockResourceParser.Parse("PAGE: 7:1:26483")!;

        var resolved = LockResourceParser.Resolve(parsed, 200, 1, "dbo", "OrderHeader", null, LockResourceParser.CatalogLookupReason);

        Assert.Same(parsed, resolved);
        Assert.Null(resolved.ObjectId);
        Assert.Equal(LockResolutionStatus.Unresolvable, resolved.Status);
    }

    [Fact]
    public void ResolveDoesNotOverwriteAnObjectIdTheEngineAlreadyStated()
    {
        var parsed = LockResourceParser.Parse("OBJECT: 7:1234567:0")!;

        var resolved = LockResourceParser.Resolve(parsed, 999, null, "dbo", "Wrong", null, LockResourceParser.CatalogLookupReason);

        Assert.Equal(1234567, resolved.ObjectId);
        Assert.Null(resolved.ObjectName);
    }

    [Fact]
    public void MarkLookupMissedKeepsRequiresLookupAndRecordsWhy()
    {
        var parsed = LockResourceParser.Parse("KEY: 7:72057594043170816 (8194443284a0)")!;

        var missed = LockResourceParser.MarkLookupMissed(parsed, "The bounded lookup covered 200 hobts and did not include this one.");

        Assert.Equal(LockResolutionStatus.RequiresLookup, missed.Status);
        Assert.Null(missed.ObjectId);
        Assert.Contains("bounded lookup", missed.Reason, StringComparison.Ordinal);
    }
}
