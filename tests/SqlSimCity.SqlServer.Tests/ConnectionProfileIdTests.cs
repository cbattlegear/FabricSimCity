namespace SqlSimCity.SqlServer.Tests;

public class ConnectionProfileIdTests
{
    [Fact]
    public void ConstructorAcceptsSimpleValue()
    {
        var id = new ConnectionProfileId("warehouse-prod-01");
        Assert.Equal("warehouse-prod-01", id.Value);
        Assert.Equal("warehouse-prod-01", id.ToString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ConstructorRejectsNullOrWhitespace(string? value)
    {
        Assert.ThrowsAny<ArgumentException>(() => new ConnectionProfileId(value!));
    }

    [Fact]
    public void ConstructorRejectsControlCharacters()
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new ConnectionProfileId("warehouse\u0007prod"));
    }

    [Fact]
    public void ConstructorRejectsValueLongerThanMaxLength()
    {
        var tooLong = new string('a', 129);
        Assert.Throws<ConnectionProfileValidationException>(() => new ConnectionProfileId(tooLong));
    }

    [Fact]
    public void ImplicitConversionFromStringWorks()
    {
        ConnectionProfileId id = "warehouse-prod-01";
        Assert.Equal("warehouse-prod-01", id.Value);
    }
}
