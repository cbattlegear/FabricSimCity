using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Collection.Tests.Probes;

/// <summary>
/// Requirement 2 coverage: <c>waiting_task_address</c>, <c>resource_address</c>, and
/// <c>blocking_task_address</c> are <c>varbinary(8)</c> columns. Casting a <see cref="byte[]"/> to
/// <see cref="string"/> throws <see cref="InvalidCastException"/> at runtime for every row; the
/// fix encodes them as a deterministic <c>0x</c>-prefixed hex string instead.
/// </summary>
public class SqlLiveIncidentProbeExecutorTests
{
    [Fact]
    public void NullVarbinaryEncodesAsNull()
    {
        Assert.Null(SqlLiveIncidentProbeExecutor.FormatVarbinaryHex(null));
    }

    [Fact]
    public void EmptyVarbinaryEncodesAsBareHexPrefix()
    {
        Assert.Equal("0x", SqlLiveIncidentProbeExecutor.FormatVarbinaryHex([]));
    }

    [Fact]
    public void VarbinaryEightBytesEncodesAsUppercaseZeroXHex()
    {
        byte[] taskAddress = [0x00, 0x00, 0x00, 0x0A, 0xBC, 0xDE, 0xF1, 0x23];

        var encoded = SqlLiveIncidentProbeExecutor.FormatVarbinaryHex(taskAddress);

        Assert.Equal("0x0000000ABCDEF123", encoded);
    }

    [Fact]
    public void VarbinaryEncodingIsDeterministicAndUppercase()
    {
        byte[] resourceAddress = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0];

        var first = SqlLiveIncidentProbeExecutor.FormatVarbinaryHex(resourceAddress);
        var second = SqlLiveIncidentProbeExecutor.FormatVarbinaryHex((byte[])resourceAddress.Clone());

        Assert.Equal("0x123456789ABCDEF0", first);
        Assert.Equal(first, second);
        Assert.DoesNotContain(first!["0x".Length..], c => char.IsLower(c));
    }

    [Fact]
    public void VarbinaryEncodingNeverThrowsForAnyByteValue()
    {
        byte[] allBytes = [0xFF, 0x00, 0x7F, 0x80, 0x01];

        var encoded = SqlLiveIncidentProbeExecutor.FormatVarbinaryHex(allBytes);

        Assert.Equal("0xFF007F8001", encoded);
    }
}
