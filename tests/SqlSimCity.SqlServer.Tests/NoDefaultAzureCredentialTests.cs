namespace SqlSimCity.SqlServer.Tests;

public class NoDefaultAzureCredentialTests
{
    [Fact]
    public void SourceFilesNeverReferenceDefaultAzureCredentialOrCredentialChains()
    {
        var sourceDirectory = FindSqlServerSourceDirectory();
        var offendingFiles = new List<string>();

        foreach (var file in Directory.EnumerateFiles(sourceDirectory, "*.cs", SearchOption.AllDirectories))
        {
            // Doc comments are allowed (and expected) to name
            // DefaultAzureCredential explicitly to document that it is *not*
            // used; only an actual construction site is disqualifying.
            var codeOnly = string.Join('\n', File.ReadLines(file).Where(line => !line.TrimStart().StartsWith("///", StringComparison.Ordinal)));
            if (codeOnly.Contains("new DefaultAzureCredential", StringComparison.Ordinal)
                || codeOnly.Contains("DefaultAzureCredential(", StringComparison.Ordinal)
                || codeOnly.Contains("new ChainedTokenCredential", StringComparison.Ordinal)
                || codeOnly.Contains("ChainedTokenCredential(", StringComparison.Ordinal))
            {
                offendingFiles.Add(file);
            }
        }

        Assert.Empty(offendingFiles);
    }

    [Fact]
    public void ProductionAssemblyContainsNoDefaultAzureCredentialConstructionSite()
    {
        // Complements the source scan: even a call reached indirectly
        // (for example through a helper built at runtime) would still need a
        // constructor reference baked into the compiled IL's metadata, which
        // is visible as a referenced member on some type in the assembly.
        var productionAssembly = typeof(SqlConnectionFactory).Assembly;
        var referencedMemberDeclaringTypes = productionAssembly
            .GetTypes()
            .SelectMany(t => t.GetMethods(System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Static
                | System.Reflection.BindingFlags.Instance
                | System.Reflection.BindingFlags.DeclaredOnly))
            .Select(m => m.ReturnType.FullName)
            .Where(name => name is not null)
            .ToHashSet(StringComparer.Ordinal);

        Assert.DoesNotContain("Azure.Identity.DefaultAzureCredential", referencedMemberDeclaringTypes);
        Assert.DoesNotContain("Azure.Identity.ChainedTokenCredential", referencedMemberDeclaringTypes);
    }

    private static string FindSqlServerSourceDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "SqlSimCity.slnx")))
        {
            directory = directory.Parent;
        }

        if (directory is null)
        {
            throw new InvalidOperationException("Could not locate the repository root from the test output directory.");
        }

        return Path.Combine(directory.FullName, "src", "SqlSimCity.SqlServer");
    }
}
