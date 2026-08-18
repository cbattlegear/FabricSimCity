using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Collection.Tests.Probes;

/// <summary>
/// Exercises <see cref="SqlExceptionClassifier"/>'s pure number/class -&gt; classification decision
/// directly. <c>Microsoft.Data.SqlClient.SqlException</c> has no public constructor for an
/// arbitrary error number, so <see cref="SqlExceptionClassifier.ClassifyByNumberAndClass"/> exists
/// specifically to make this classification table testable without one.
/// </summary>
public class SqlExceptionClassifierTests
{
    [Theory]
    [InlineData(207)]
    [InlineData(208)]
    [InlineData(4121)]
    public void ObjectOrColumnErrorsClassifyAsObjectUnavailable(int number)
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(number, 16, "test.probe");
        Assert.IsType<ProbeObjectUnavailableException>(result);
        Assert.Equal(number, result.SqlErrorNumber);
    }

    [Theory]
    [InlineData(229)]
    [InlineData(230)]
    [InlineData(262)]
    [InlineData(297)]
    [InlineData(300)]
    [InlineData(15247)]
    [InlineData(15274)]
    [InlineData(15281)]
    [InlineData(33665)]
    public void PermissionErrorsClassifyAsPermissionDenied(int number)
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(number, 14, "test.probe");
        Assert.IsType<ProbePermissionDeniedException>(result);
    }

    [Theory]
    [InlineData(40197)]
    [InlineData(40501)]
    [InlineData(40613)]
    [InlineData(40615)]
    [InlineData(10928)]
    [InlineData(10929)]
    [InlineData(10053)]
    [InlineData(10054)]
    [InlineData(10060)]
    [InlineData(233)]
    [InlineData(64)]
    public void TransientErrorsClassifyAsTransientConnection(int number)
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(number, 16, "test.probe");
        Assert.IsType<ProbeTransientConnectionException>(result);
    }

    [Fact]
    public void LoginFailureIsAuthenticationUnavailableNotTransient()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(18456, 14, "test.probe");

        Assert.IsType<ProbeAuthenticationException>(result);
        Assert.DoesNotContain("transient", result.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CannotOpenDatabaseIsDatabaseUnavailableNotTransient()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(4060, 11, "test.probe");

        Assert.IsType<ProbeDatabaseUnavailableException>(result);
        Assert.DoesNotContain("transient", result.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void HighSeverityClassClassifiesAsTransientConnectionEvenForAnUnknownNumber()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(999999, 20, "test.probe");
        Assert.IsType<ProbeTransientConnectionException>(result);
    }

    [Fact]
    public void NegativeTwoClassifiesAsTimeout()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(-2, 11, "test.probe");
        Assert.IsType<ProbeTimeoutException>(result);
    }

    [Fact]
    public void UnrecognizedNumberAndLowClassClassifiesAsUnknownNotSuccess()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(50000, 10, "test.probe");
        Assert.IsType<ProbeUnknownException>(result);
    }

    [Fact]
    public void ReasonNeverContainsProbeSpecificSecretsOnlyTheCuratedSentence()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(229, 14, "capability.server_permission_check");
        Assert.DoesNotContain("password", result.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("capability.server_permission_check", result.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void SqlErrorNumberAndClassArePreservedOnTheResultingException()
    {
        var result = SqlExceptionClassifier.ClassifyByNumberAndClass(207, 16, "test.probe");
        Assert.Equal(207, result.SqlErrorNumber);
        Assert.Equal((byte)16, result.SqlErrorClass);
    }
}
