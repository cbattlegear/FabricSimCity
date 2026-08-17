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

    [Theory]
    [InlineData("sql01")]
    [InlineData("sql01.internal.example.com")]
    [InlineData("192.0.2.25")]
    public void ConstructorAcceptsDnsFqdnAndIpv4Hosts(string host)
    {
        var address = new ServerAddress(host);

        Assert.Equal(host, address.Host);
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

    [Theory]
    [InlineData("sql01,1433")]
    [InlineData("sql01\\SQLEXPRESS")]
    [InlineData("tcp:sql01")]
    [InlineData("np:sql01")]
    [InlineData("sql01:1433")]
    [InlineData(" sql01.example.com")]
    [InlineData("sql01.example.com ")]
    [InlineData("sql 01.example.com")]
    [InlineData("sql01/evil")]
    [InlineData("sql01'evil")]
    [InlineData("sql01\"evil")]
    [InlineData("sql01[evil]")]
    [InlineData("[sql01")]
    [InlineData("sql01]")]
    public void ConstructorRejectsEmbeddedRoutingSyntaxAndWhitespace(string host)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress(host));
    }

    [Theory]
    [InlineData("2001:db8::1")]
    [InlineData("[2001:db8::1]")]
    public void ConstructorRejectsIpv6UntilSqlClientTcpSyntaxIsSupported(string host)
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(() => new ServerAddress(host, port: 1433));

        Assert.Contains("IPv6", ex.Message);
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

    [Theory]
    [InlineData("SQLEXPRESS")]
    [InlineData("_named_instance")]
    [InlineData("Instance1")]
    public void ConstructorAcceptsValidInstanceNameShapes(string instanceName)
    {
        var address = new ServerAddress("sql01.example.com", instanceName: instanceName);
        Assert.Equal(instanceName, address.InstanceName);
    }

    [Theory]
    [InlineData("SQL EXPRESS")]
    [InlineData("SQL\tEXPRESS")]
    [InlineData("SQL,EXPRESS")]
    [InlineData("SQL\\EXPRESS")]
    [InlineData("SQL:EXPRESS")]
    [InlineData("SQL/EXPRESS")]
    [InlineData("SQL'EXPRESS")]
    [InlineData("SQL\"EXPRESS")]
    [InlineData("SQL[EXPRESS]")]
    [InlineData("1SQLEXPRESS")]
    [InlineData("-SQLEXPRESS")]
    [InlineData("SQL.EXPRESS")]
    public void ConstructorRejectsInstanceNameRoutingSyntaxWhitespaceAndInvalidShape(string instanceName)
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new ServerAddress("sql01.example.com", instanceName: instanceName));
    }
}
