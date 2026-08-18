using SqlSimCity.Api;

namespace SqlSimCity.Api.Tests;

public sealed class WebRootResolverTests
{
    [Fact]
    public void PublishedWebRootIsResolvedFromAssemblyDirectory()
    {
        var baseDirectory = Path.Combine(Path.GetPathRoot(Environment.CurrentDirectory)!, "unrelated", "publish");
        string? checkedPath = null;

        var result = WebRootResolver.Resolve(baseDirectory, path =>
        {
            checkedPath = path;
            return true;
        });

        var expectedRoot = Path.GetFullPath(Path.Combine(baseDirectory, "wwwroot"));
        Assert.Equal(expectedRoot, result);
        Assert.Equal(Path.Combine(expectedRoot, "index.html"), checkedPath);
    }

    [Fact]
    public void ApiOnlyDevelopmentDoesNotRequireBuiltFrontend()
    {
        var result = WebRootResolver.Resolve(Environment.CurrentDirectory, _ => false);

        Assert.Null(result);
    }
}
