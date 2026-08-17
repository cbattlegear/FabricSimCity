namespace SqlSimCity.SqlServer.Tests;

public class PoolBoundsTests
{
    [Fact]
    public void ConstructorAcceptsValidBounds()
    {
        var bounds = new PoolBounds(minPoolSize: 1, maxPoolSize: 10);
        Assert.Equal(1, bounds.MinPoolSize);
        Assert.Equal(10, bounds.MaxPoolSize);
    }

    [Fact]
    public void ConstructorAcceptsZeroMinimum()
    {
        var bounds = new PoolBounds(minPoolSize: 0, maxPoolSize: 5);
        Assert.Equal(0, bounds.MinPoolSize);
    }

    [Fact]
    public void ConstructorRejectsMinGreaterThanMax()
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new PoolBounds(minPoolSize: 10, maxPoolSize: 5));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    public void ConstructorRejectsOutOfRangeMinimum(int min)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new PoolBounds(minPoolSize: min, maxPoolSize: 1001));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1001)]
    public void ConstructorRejectsOutOfRangeMaximum(int max)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => new PoolBounds(minPoolSize: 0, maxPoolSize: max));
    }
}
