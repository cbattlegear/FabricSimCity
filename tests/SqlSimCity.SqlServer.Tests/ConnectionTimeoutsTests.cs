namespace SqlSimCity.SqlServer.Tests;

public class ConnectionTimeoutsTests
{
    [Fact]
    public void ConstructorAcceptsValidTimeouts()
    {
        var timeouts = new ConnectionTimeouts(connectTimeoutSeconds: 15, commandTimeoutSeconds: 30);
        Assert.Equal(15, timeouts.ConnectTimeoutSeconds);
        Assert.Equal(30, timeouts.CommandTimeoutSeconds);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(301)]
    [InlineData(-1)]
    public void ConstructorRejectsOutOfRangeConnectTimeout(int seconds)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ConnectionTimeouts(seconds, commandTimeoutSeconds: 30));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(3601)]
    [InlineData(-1)]
    public void ConstructorRejectsOutOfRangeCommandTimeout(int seconds)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ConnectionTimeouts(connectTimeoutSeconds: 15, seconds));
    }

    [Fact]
    public void ConstructorAcceptsBoundaryValues()
    {
        var timeouts = new ConnectionTimeouts(
            connectTimeoutSeconds: ConnectionTimeouts.MaxConnectSeconds,
            commandTimeoutSeconds: ConnectionTimeouts.MaxCommandSeconds);
        Assert.Equal(ConnectionTimeouts.MaxConnectSeconds, timeouts.ConnectTimeoutSeconds);
        Assert.Equal(ConnectionTimeouts.MaxCommandSeconds, timeouts.CommandTimeoutSeconds);
    }
}
