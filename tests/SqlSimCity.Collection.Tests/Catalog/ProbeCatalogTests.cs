using SqlSimCity.Collection.Catalog;

namespace SqlSimCity.Collection.Tests.Catalog;

public class ProbeCatalogTests
{
    [Fact]
    public void LoadRealEmbeddedCatalogSucceedsAndExposesKnownProbes()
    {
        var catalog = ProbeCatalog.Load();

        Assert.Equal(1, catalog.ManifestVersion);
        Assert.Contains("server.identity", catalog.ProbeIds);
        Assert.Contains("capability.query_store_plan_metadata", catalog.ProbeIds);
        Assert.Contains("capability.azure_resource_governance", catalog.ProbeIds);

        var probe = catalog.Get("server.identity");
        Assert.False(string.IsNullOrWhiteSpace(probe.CommandText));
    }

    [Theory]
    [InlineData("querystore.database_workload_summary_2016")]
    [InlineData("querystore.database_workload_summary_2022")]
    public void AtlasWorkloadProbesAggregateServerSideWithoutBulkPayloads(string probeId)
    {
        var sql = ProbeCatalog.Load().Get(probeId).CommandText;

        Assert.Contains("GROUP BY execution_type", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SUM(execution_count)", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("query_store_query_text", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("query_plan", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DatabaseCityInventoryIsKeysetBoundedAndKeepsIndexesAttached()
    {
        var probe = ProbeCatalog.Load().Get("city.object_inventory_page");
        var sql = probe.CommandText;

        Assert.Equal("database", probe.ConnectionScope);
        Assert.Contains(probe.Parameters, parameter => parameter.Name == "@AfterObjectId");
        Assert.Contains(probe.Parameters, parameter => parameter.Name == "@TopN");
        Assert.Contains("TOP (@TopN)", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("object_id > @AfterObjectId", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("JOIN selected_objects", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("sys.indexes", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("reserved_pages", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("schema_layout_ordinal", sql, StringComparison.OrdinalIgnoreCase);

        var usage = ProbeCatalog.Load().Get("city.index_usage_page");
        Assert.Contains("TOP (@TopN)", usage.CommandText, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("object_id > @AfterObjectId", usage.CommandText, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("JOIN selected_objects", usage.CommandText, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetUnknownIdThrows()
    {
        var catalog = ProbeCatalog.Load();
        Assert.Throws<ProbeCatalogException>(() => catalog.Get("no.such.probe"));
    }

    [Fact]
    public void TryGetUnknownIdReturnsFalseWithoutThrowing()
    {
        var catalog = ProbeCatalog.Load();
        Assert.False(catalog.TryGet("no.such.probe", out var probe));
        Assert.Null(probe);
    }

    [Fact]
    public void LoadMissingManifestResourceThrows()
    {
        var source = new FakeProbeCatalogResourceSource();
        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("sql/manifest.json", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadUnsupportedManifestVersionThrows()
    {
        var manifest = """
            {
              "manifestVersion": 999,
              "connectionScopes": { "server": {} },
              "cadenceClasses": { "onDemand": {} },
              "relativeCosts": { "low": {} },
              "probes": []
            }
            """;
        var source = new FakeProbeCatalogResourceSource().With("sql/manifest.json", manifest);

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("999", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadEmptyProbesArrayThrows()
    {
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes("[]");
        var source = new FakeProbeCatalogResourceSource().With("sql/manifest.json", manifest);

        Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
    }

    [Fact]
    public void LoadDuplicateProbeIdsThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "dup.id", file: "probes/dup/a.sql");
        var probeJson2 = FakeProbeCatalogResourceSource.ValidProbeJson(id: "dup.id", file: "probes/dup/b.sql");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson},{probeJson2}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/dup/a.sql", "SELECT 1;")
            .With("sql/probes/dup/b.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("duplicate ids", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadDuplicateProbeFileThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "probe.one", file: "probes/shared/x.sql");
        var probeJson2 = FakeProbeCatalogResourceSource.ValidProbeJson(id: "probe.two", file: "probes/shared/x.sql");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson},{probeJson2}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/shared/x.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("more than one probe", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("../escape/outside.sql")]
    [InlineData("probes/../../secrets.sql")]
    [InlineData("/etc/passwd")]
    [InlineData("C:/Windows/win.ini")]
    [InlineData(@"probes\windows\style.sql")]
    [InlineData("not-under-probes/x.sql")]
    public void LoadUnsafeProbeFilePathThrows(string unsafePath)
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "unsafe.probe", file: unsafePath);
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource().With("sql/manifest.json", manifest);

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("unsafe file path", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("probes/valid/one.sql")]
    [InlineData("probes/nested/deep/two.sql")]
    public void IsSafeRelativeProbePathAcceptsSafePaths(string safePath)
    {
        Assert.True(ProbeCatalog.IsSafeRelativeProbePath(safePath));
    }

    [Fact]
    public void LoadMissingReferencedFileThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "missing.file", file: "probes/gone/nope.sql");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource().With("sql/manifest.json", manifest);

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("does not exist among the embedded catalog resources", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadParameterDeclaredButNotReferencedInFileThrows()
    {
        var parameters = """[{"name":"@Unused","sqlDbType":"Int","required":true,"description":"unused"}]""";
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "unused.param", file: "probes/p/unused.sql", parametersJson: parameters);
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/unused.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("never references them", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadParameterReferencedButNotDeclaredInManifestThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "undeclared.param", file: "probes/p/undeclared.sql", parametersJson: "[]");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/undeclared.sql", "SELECT * FROM sys.databases WHERE database_id = @DatabaseId;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("that the manifest does not declare", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadUndocumentedConnectionScopeThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "bad.scope", file: "probes/p/scope.sql", connectionScope: "not-a-real-scope");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/scope.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("undocumented connectionScope", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadUndocumentedCadenceClassThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "bad.cadence", file: "probes/p/cadence.sql", cadenceClass: "not-a-real-cadence");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/cadence.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("undocumented cadenceClass", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadUndocumentedRelativeCostThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "bad.cost", file: "probes/p/cost.sql", relativeCost: "extreme");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/cost.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("undocumented relativeCost", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadVersionVariantOfWithoutNotesThrows()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(
            id: "variant.probe",
            file: "probes/p/variant.sql",
            versionVariantOf: "base.probe",
            versionVariantNotes: "");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/variant.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("versionVariantOf but no non-empty versionVariantNotes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadVersionVariantOfWithNotesSucceeds()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(
            id: "variant.probe",
            file: "probes/p/variant.sql",
            versionVariantOf: "base.probe",
            versionVariantNotes: "Adds a column introduced in a later engine build.");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/variant.sql", "SELECT 1;");

        var catalog = ProbeCatalog.Load(source);
        Assert.Contains("variant.probe", catalog.ProbeIds);
    }

    [Fact]
    public void LoadMissingAzureSqlDatabaseObjectThrows()
    {
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes("""
            [{
              "id": "no.azure.object",
              "title": "Test probe",
              "file": "probes/p/noazure.sql",
              "connectionScope": "server",
              "minPlatform": "SQL Server 2019",
              "requiredPermission": "VIEW SERVER STATE",
              "cadenceClass": "onDemand",
              "parameters": [],
              "resultSets": 1,
              "resultContract": "single-row",
              "relativeCost": "low"
            }]
            """);
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/p/noazure.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));
        Assert.Contains("missing the 'azureSqlDatabase' object", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadCollectsMultipleErrorsInOneException()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson(id: "dup.multi", file: "probes/dup/multi.sql", connectionScope: "not-real");
        var probeJson2 = FakeProbeCatalogResourceSource.ValidProbeJson(id: "dup.multi", file: "probes/dup/multi.sql", connectionScope: "not-real");
        var manifest = FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson},{probeJson2}]");
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", manifest)
            .With("sql/probes/dup/multi.sql", "SELECT 1;");

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));

        // Every distinct problem must be reported, not just the first one encountered.
        Assert.Contains("duplicate ids", ex.Message, StringComparison.Ordinal);
        Assert.Contains("more than one probe", ex.Message, StringComparison.Ordinal);
        Assert.Contains("undocumented connectionScope", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("SELECT 1; DROP TABLE dbo.t;")]
    [InlineData("SELECT 1; EXEC sp_executesql N'SELECT 2';")]
    [InlineData("SELECT 1 INTO #copy FROM sys.objects;")]
    [InlineData("DECLARE @x int; SELECT @x;")]
    [InlineData("SET XACT_ABORT ON; SELECT 1;")]
    public void LoadRejectsUnsafeStaticSql(string sql)
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson();
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]"))
            .With("sql/probes/test/probe.sql", sql);

        var ex = Assert.Throws<ProbeCatalogException>(() => ProbeCatalog.Load(source));

        Assert.Contains("read-only SQL validation", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadAllowsDocumentedSafeSetsAndIgnoresMutationWordsInComments()
    {
        var probeJson = FakeProbeCatalogResourceSource.ValidProbeJson();
        var source = new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probeJson}]"))
            .With("sql/probes/test/probe.sql", """
                -- DROP TABLE dbo.t;
                SET NOCOUNT ON;
                SET DEADLOCK_PRIORITY LOW;
                SET LOCK_TIMEOUT 5000;
                WITH source AS (SELECT 1 AS value)
                SELECT value FROM source;
                """);

        Assert.NotNull(ProbeCatalog.Load(source));
    }
}
