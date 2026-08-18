using SqlSimCity.Collection.Negotiation;

namespace SqlSimCity.Collection.Tests.Negotiation;

public class QueryStoreReadOnlyReasonTests
{
    [Fact]
    public void ZeroDescribesNotReadOnly()
    {
        Assert.Equal("Query Store is not read-only.", QueryStoreReadOnlyReason.Describe(0));
    }

    [Theory]
    [InlineData(1, "read-only mode")]
    [InlineData(2, "single-user mode")]
    [InlineData(4, "emergency mode")]
    [InlineData(8, "readable secondary replica")]
    [InlineData(65536, "max_storage_size_mb")]
    [InlineData(131072, "distinct statements")]
    [InlineData(262144, "in-memory Query Store data")]
    [InlineData(524288, "disk size limit")]
    public void SingleBitDescribesTheDocumentedReason(int bit, string expectedFragment)
    {
        var description = QueryStoreReadOnlyReason.Describe(bit);
        Assert.Contains(expectedFragment, description, StringComparison.Ordinal);
    }

    [Fact]
    public void MultipleBitsDescribesAllOfThem()
    {
        var description = QueryStoreReadOnlyReason.Describe(1 | 65536);
        Assert.Contains("read-only mode", description, StringComparison.Ordinal);
        Assert.Contains("max_storage_size_mb", description, StringComparison.Ordinal);
    }

    [Fact]
    public void UndocumentedBitIsReportedByHexValueNeverSilentlyDropped()
    {
        const int undocumentedBit = 1 << 20;
        var description = QueryStoreReadOnlyReason.Describe(undocumentedBit);
        Assert.Contains("0x" + undocumentedBit.ToString("X", System.Globalization.CultureInfo.InvariantCulture), description, StringComparison.Ordinal);
    }

    [Fact]
    public void KnownAndUndocumentedBitsTogetherReportsBoth()
    {
        const int undocumentedBit = 1 << 20;
        var description = QueryStoreReadOnlyReason.Describe(1 | undocumentedBit);
        Assert.Contains("read-only mode", description, StringComparison.Ordinal);
        Assert.Contains("undocumented bit", description, StringComparison.Ordinal);
    }
}
