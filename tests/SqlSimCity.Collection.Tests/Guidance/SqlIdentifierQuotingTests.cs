using SqlSimCity.Collection.Guidance;

namespace SqlSimCity.Collection.Tests.Guidance;

public class SqlIdentifierQuotingTests
{
    [Theory]
    [InlineData("simple_login", "[simple_login]")]
    [InlineData("has space", "[has space]")]
    [InlineData("", "[]")]
    public void QuoteBracketIdentifierWrapsInBrackets(string input, string expected)
    {
        Assert.Equal(expected, SqlIdentifierQuoting.QuoteBracketIdentifier(input));
    }

    [Theory]
    [InlineData("weird]name", "[weird]]name]")]
    [InlineData("]]", "[]]]]]")]
    public void QuoteBracketIdentifierDoublesEmbeddedClosingBracketsPreventingEarlyTermination(string input, string expected)
    {
        Assert.Equal(expected, SqlIdentifierQuoting.QuoteBracketIdentifier(input));
    }

    [Fact]
    public void QuoteBracketIdentifierInjectionAttemptCannotEscapeTheBrackets()
    {
        // An attacker-controlled principal name trying to break out of the identifier and append
        // a second statement must remain entirely inside one bracketed token: parsing the quoted
        // result as T-SQL would (each ']]' is an escaped bracket, only an unpaired ']' terminates
        // the identifier) must consume the whole string, leaving nothing after it that a parser
        // could interpret as a new, attacker-controlled statement.
        var malicious = "attacker];GRANT CONTROL SERVER TO [attacker";
        var quoted = SqlIdentifierQuoting.QuoteBracketIdentifier(malicious);

        Assert.StartsWith("[", quoted, StringComparison.Ordinal);
        Assert.Equal(quoted.Length, FindBracketIdentifierEnd(quoted));
    }

    /// <summary>
    /// Simulates how T-SQL itself parses a bracket-delimited identifier: starting just after the
    /// opening '[', a ']' immediately followed by another ']' is an escaped literal bracket and
    /// parsing continues; the first unpaired ']' ends the identifier. Returns the index one past
    /// that terminating bracket.
    /// </summary>
    private static int FindBracketIdentifierEnd(string quoted)
    {
        Assert.Equal('[', quoted[0]);
        var i = 1;
        while (i < quoted.Length)
        {
            if (quoted[i] == ']')
            {
                if (i + 1 < quoted.Length && quoted[i + 1] == ']')
                {
                    i += 2;
                    continue;
                }

                return i + 1;
            }

            i += 1;
        }

        throw new InvalidOperationException("Quoted identifier never terminates; this itself would be a bug.");
    }

    [Fact]
    public void QuoteBracketIdentifierNullCharacterThrows()
    {
        Assert.Throws<ArgumentException>(() => SqlIdentifierQuoting.QuoteBracketIdentifier("bad\0name"));
    }

    [Fact]
    public void QuoteBracketIdentifierNullThrowsArgumentNullException()
    {
        Assert.Throws<ArgumentNullException>(() => SqlIdentifierQuoting.QuoteBracketIdentifier(null!));
    }
}
