namespace SqlSimCity.SqlServer.Tests;

public class ServerAddressTests
{
    [Fact]
    public void ToDataSourceBareHostReturnsHostOnly()
    {
        var address = new ServerAddress("sql01.internal.example.com");
        Assert.Equal("sql01.internal.example.com", address.ToDataSource());
    }

    [Fact]
    public void ToDataSourceWithInstanceNameUsesBackslashForm()
    {
        var address = new ServerAddress("sql01.internal.example.com", instanceName: "SQLEXPRESS");
        Assert.Equal("sql01.internal.example.com\\SQLEXPRESS", address.ToDataSource());
    }

    [Fact]
    public void ToDataSourceWithPortUsesTcpCommaForm()
    {
        var address = new ServerAddress("sql01.internal.example.com", port: 14330);
        Assert.Equal("tcp:sql01.internal.example.com,14330", address.ToDataSource());
    }

    [Fact]
    public void ConstructorRejectsBothInstanceNameAndPort()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => new ServerAddress("sql01.internal.example.com", instanceName: "SQLEXPRESS", port: 1433));
        Assert.Contains("mutually exclusive", ex.Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65536)]
    [InlineData(int.MaxValue)]
    public void ConstructorRejectsInvalidPort(int port)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress("sql01.example.com", port: port));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(1433)]
    [InlineData(65535)]
    public void ConstructorAcceptsValidPort(int port)
    {
        var address = new ServerAddress("sql01.example.com", port: port);
        Assert.Equal(port, address.Port);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ConstructorRejectsNullOrWhitespaceHost(string? host)
    {
        Assert.ThrowsAny<ArgumentException>(() => new ServerAddress(host!));
    }

    [Fact]
    public void ConstructorRejectsControlCharactersInHost()
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress("sql01\u0000.example.com"));
    }

    [Theory]
    [InlineData("sql01;DROP TABLE")]
    [InlineData("sql01=evil")]
    [InlineData("sql01{evil}")]
    public void ConstructorRejectsConnectionStringFragmentsInHost(string host)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress(host));
    }

    [Fact]
    public void ConstructorRejectsHostLongerThanMaxLength()
    {
        var tooLong = new string('a', 256);
        Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress(tooLong));
    }

    [Fact]
    public void ConstructorRejectsControlCharactersInInstanceName()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new ServerAddress("sql01.example.com", instanceName: "SQL\u0001EXPRESS"));
    }

    [Fact]
    public void ConstructorRejectsEmptyInstanceName()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new ServerAddress("sql01.example.com", instanceName: string.Empty));
    }
}
