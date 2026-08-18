using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Collection.Tests.Catalog;

public class SqlTextScannerTests
{
    [Fact]
    public void StripCommentsRemovesLineCommentsPreservesOtherText()
    {
        var sql = "SELECT 1 -- a trailing comment\nFROM sys.databases;";
        var stripped = SqlTextScanner.StripComments(sql);
        Assert.DoesNotContain("trailing comment", stripped, StringComparison.Ordinal);
        Assert.Contains("SELECT 1", stripped, StringComparison.Ordinal);
        Assert.Contains("FROM sys.databases;", stripped, StringComparison.Ordinal);
    }

    [Fact]
    public void StripCommentsRemovesBlockCommentsPreservesOtherText()
    {
        var sql = "SELECT 1 /* a block\nspanning lines */ FROM sys.databases;";
        var stripped = SqlTextScanner.StripComments(sql);
        Assert.DoesNotContain("spanning lines", stripped, StringComparison.Ordinal);
        Assert.Contains("SELECT 1", stripped, StringComparison.Ordinal);
    }

    [Fact]
    public void StripCommentsPreservesCommentMarkersInsideStringLiterals()
    {
        var sql = "SELECT '-- not a comment' AS c, '/* not a comment */' AS d;";
        var stripped = SqlTextScanner.StripComments(sql);
        Assert.Contains("-- not a comment", stripped, StringComparison.Ordinal);
        Assert.Contains("/* not a comment */", stripped, StringComparison.Ordinal);
    }

    [Fact]
    public void StripCommentsHandlesEscapedQuotesInsideStringLiterals()
    {
        var sql = "SELECT 'it''s -- still a string' AS c FROM sys.databases;";
        var stripped = SqlTextScanner.StripComments(sql);
        Assert.Contains("it''s -- still a string", stripped, StringComparison.Ordinal);
        Assert.Contains("FROM sys.databases;", stripped, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtractParameterNamesFindsNamedParameters()
    {
        var sql = "SELECT * FROM sys.databases WHERE database_id = @DatabaseId AND state = @State;";
        var names = SqlTextScanner.ExtractParameterNames(sql);
        Assert.Equal(new HashSet<string> { "@DatabaseId", "@State" }, names);
    }

    [Fact]
    public void ExtractParameterNamesExcludesSystemVariables()
    {
        var sql = "SELECT @@SERVERNAME, @@VERSION, @RealParam;";
        var names = SqlTextScanner.ExtractParameterNames(sql);
        Assert.Equal(new HashSet<string> { "@RealParam" }, names);
    }

    [Fact]
    public void ExtractParameterNamesIgnoresParametersInsideComments()
    {
        var sql = "SELECT 1 -- @NotAParameter\n/* @AlsoNot */ WHERE x = @Real;";
        var names = SqlTextScanner.ExtractParameterNames(sql);
        Assert.Equal(new HashSet<string> { "@Real" }, names);
    }

    [Fact]
    public void ExtractParameterNamesAlsoMatchesTextInsideStringLiterals()
    {
        // StripComments deliberately preserves string-literal content (its own remarks document
        // this), so a literal that happens to contain '@Word' is still picked up here -- exactly
        // the same, documented limitation as the ported test/lib/sqlGuard.mjs behavior this class
        // mirrors. No real probe in this catalog relies on that edge case.
        var sql = "SELECT '@LooksLikeAParameter' AS c WHERE x = @Real;";
        var names = SqlTextScanner.ExtractParameterNames(sql);
        Assert.Equal(new HashSet<string> { "@LooksLikeAParameter", "@Real" }, names);
    }

    [Fact]
    public void ExtractParameterNamesNoParametersReturnsEmptySet()
    {
        var names = SqlTextScanner.ExtractParameterNames("SELECT 1;");
        Assert.Empty(names);
    }
}
