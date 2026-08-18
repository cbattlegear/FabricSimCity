using System.Collections.ObjectModel;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the join that turns Query Store families into city evidence. The rules under test are
/// all forms of one promise: the join reports what the plans actually named, and says so plainly
/// when it could not resolve something, rather than inventing an attribution.
/// </summary>
public sealed class QueryStoreCityAttributionTests
{
    private const string DatabaseId = FakeQueryStore.DatabaseId;
    private const string CustomerId = "target/database/sales/object/10";
    private const string OrderId = "target/database/sales/object/20";

    private static readonly IReadOnlyList<CityAttributionObject> PageObjects =
    [
        new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
        new(OrderId, "dbo", "OrderHeader", DatabaseObjectKind.Table),
    ];

    private static Task<CityAttributionResult> AttributeAsync(
        FakeQueryStore store,
        IReadOnlyList<CityAttributionObject>? pageObjects = null,
        IReadOnlyDictionary<string, string>? databaseIdsByName = null) =>
        new QueryStoreCityAttribution(store).AttributeAsync(
            DatabaseId,
            "sales",
            DatabaseCityMetric.Cpu,
            pageObjects ?? PageObjects,
            databaseIdsByName ?? new Dictionary<string, string> { ["sales"] = DatabaseId },
            topFamilyCount: 12,
            CancellationToken.None);

    [Fact]
    public async Task SingleObjectPlanIsConfirmedAndCarriesTheFamilyTotalsUndivided()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal("family-1", family.FamilyId);
        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
        Assert.Equal(QueryAttributionConfidence.Confirmed, family.Confidence);
        Assert.Equal("900", family.TotalCpuMicroseconds);

        var exposure = result.ExposureByObjectId[CustomerId];
        Assert.Equal("900", exposure.TotalCpuMicroseconds);
        Assert.Equal("30", exposure.ExecutionCount);
        Assert.Equal(QueryAttributionConfidence.Confirmed, exposure.Confidence);
    }

    [Fact]
    public async Task MultiObjectPlanStaysProbableAndIsNeverSplitAcrossItsObjects()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "1000", executions: "10", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal([CustomerId, OrderId], family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Equal("1000", family.TotalCpuMicroseconds);

        // Neither building may claim a share of a total the plan never attributed to it.
        Assert.Empty(result.ExposureByObjectId);
    }

    [Fact]
    public async Task IndexedViewStaysProbableBecauseTheOptimizerCanExpandIt()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "500", executions: "5", plans:
            [Plan("plan-1", Reference(table: "CustomerSummary"))]);

        var result = await AttributeAsync(store, pageObjects:
        [
            new("target/database/sales/object/30", "dbo", "CustomerSummary", DatabaseObjectKind.IndexedView),
        ]);

        var family = Assert.Single(result.Families);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Contains("indexed view", family.Rationale, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReferenceToAnObjectOutsideThePageIsDisclosedRatherThanDropped()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "700", executions: "7", plans:
            [Plan("plan-1", Reference(table: "Invoice"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Empty(family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Unknown, family.Confidence);
        Assert.Contains("dbo.Invoice", family.Rationale, StringComparison.Ordinal);
        Assert.Empty(result.ExposureByObjectId);
    }

    [Fact]
    public async Task CoReferencedObjectsInOnePlanBecomeAConfirmedRoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        var route = Assert.Single(result.Routes);
        Assert.Equal(CustomerId, route.FromObjectId);
        Assert.Equal(OrderId, route.ToId);
        Assert.Equal(DatabaseCityRouteKind.ObjectReference, route.Kind);
        Assert.Equal(EdgeConfidence.Confirmed, route.Confidence);
    }

    [Fact]
    public async Task ReferenceToAnotherDatabaseBecomesAProbableCrossDatabaseRoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(database: "warehouse", table: "FactSale"))]);

        var result = await AttributeAsync(store, databaseIdsByName: new Dictionary<string, string>
        {
            ["sales"] = DatabaseId,
            ["warehouse"] = "target/database/warehouse",
        });

        var route = Assert.Single(result.Routes);
        Assert.Equal(CustomerId, route.FromObjectId);
        Assert.Equal("target/database/warehouse", route.ToId);
        Assert.Equal(DatabaseCityRouteKind.CrossDatabaseReference, route.Kind);
        Assert.Equal(EdgeConfidence.Probable, route.Confidence);

        // The local object is still only one local reference, but the cross-database hop means the
        // family's cost cannot be claimed entirely by this database's building.
        Assert.Equal(QueryAttributionConfidence.Probable, Assert.Single(result.Families).Confidence);
    }

    [Fact]
    public async Task ReferenceToAnUnknownDatabaseIsNotGuessedIntoARoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(database: "elsewhere", table: "FactSale"))]);

        var result = await AttributeAsync(store);

        Assert.Empty(result.Routes);
        var family = Assert.Single(result.Families);
        Assert.Contains("elsewhere.dbo.FactSale", family.Rationale, StringComparison.Ordinal);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Empty(result.ExposureByObjectId);
    }

    [Fact]
    public async Task AnOnPageObjectDoesNotAbsorbTotalsFromAPlanThatAlsoNamedAnOffPageObject()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "800", executions: "8", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "Invoice"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Contains("dbo.Invoice", family.Rationale, StringComparison.Ordinal);

        // The plan touched something this page cannot show, so the Customer building must not be
        // credited with the whole family.
        Assert.Empty(result.ExposureByObjectId);
    }

    [Fact]
    public async Task WaitCategoriesArePublishedOnlyWhenTheyReconcileWithTheFamilyTotal()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "2", waitMilliseconds: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))], runtimeWaits:
            [
                new Dictionary<string, string> { ["CPU"] = "10", ["Buffer IO"] = "5" },
                new Dictionary<string, string> { ["CPU"] = "15" },
            ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal("30", family.TotalWaitMilliseconds);
        Assert.Equal("25", family.WaitMillisecondsByCategory["CPU"]);
        Assert.Equal("5", family.WaitMillisecondsByCategory["Buffer IO"]);
    }

    [Fact]
    public async Task WaitCategoriesAreWithheldWhenTheyDoNotReconcile()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "2", waitMilliseconds: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))], runtimeWaits:
            [new Dictionary<string, string> { ["CPU"] = "10" }]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        // Reporting 10 ms of CPU wait against a 30 ms total would imply the other 20 ms were
        // uncategorised, which the buckets do not say. Publish nothing instead.
        Assert.Equal("30", family.TotalWaitMilliseconds);
        Assert.Empty(family.WaitMillisecondsByCategory);
    }

    [Fact]
    public async Task OtherWorkloadCountsTheRemainingFamiliesAndLeavesUnaggregatedTotalsNull()
    {
        var store = new FakeQueryStore { TotalCount = "57" };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);
        store.AddFamily("family-2", cpu: "50", executions: "1", plans:
            [Plan("plan-2", Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        Assert.Equal("55", result.OtherWorkload.FamilyCount);
        Assert.Null(result.OtherWorkload.TotalCpuMicroseconds);
        Assert.Null(result.OtherWorkload.ExecutionCount);
        Assert.Contains("never zero", result.OtherWorkload.Evidence.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OtherWorkloadFamilyCountIsUnknownWhenQueryStoreDidNotPublishATotal()
    {
        var store = new FakeQueryStore { TotalCount = null };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var result = await AttributeAsync(store);

        Assert.Null(result.OtherWorkload.FamilyCount);
    }

    [Fact]
    public async Task PlansBeyondThePerFamilyBudgetAreDisclosedAsSkipped()
    {
        var plans = Enumerable
            .Range(0, QueryStoreCityAttribution.MaxPlansPerFamily + 3)
            .Select(i => Plan($"plan-{i}", Reference(table: "Customer")))
            .ToArray();
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans: plans);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal(QueryStoreCityAttribution.MaxPlansPerFamily, store.PlansRequested);
        Assert.Contains("incomplete", family.Rationale, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AQueryStoreFailureLeavesThePageHonestlyUnattributedInsteadOfFailing()
    {
        var result = await AttributeAsync(new FakeQueryStore { ThrowOnQueries = true });

        Assert.Empty(result.Families);
        Assert.Empty(result.Routes);
        Assert.Empty(result.ExposureByObjectId);
        Assert.Equal(DataStatus.Unknown, result.Evidence.Status);
    }

    [Fact]
    public async Task AMissingPlanReducesConfidenceRatherThanBeingTreatedAsNoReferences()
    {
        var store = new FakeQueryStore { ReturnNullPlans = true };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Empty(family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Unknown, family.Confidence);
    }

    [Fact]
    public async Task BracketQuotedAndDifferentlyCasedReferencesMatchTheSameBuilding()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(schema: "[DBO]", table: "[customer]"))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
    }

    [Fact]
    public async Task AnUnqualifiedReferenceIsNotResolvedWhenTwoSchemasShareTheName()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(schema: null, table: "Customer"))]);

        var result = await AttributeAsync(store, pageObjects:
        [
            new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
            new(OrderId, "sales", "Customer", DatabaseObjectKind.Table),
        ]);

        Assert.Empty(Assert.Single(result.Families).ObjectIds);
    }

    private static ShowplanObjectV1 Reference(
        string? database = null,
        string? schema = "dbo",
        string? table = null,
        string? index = null) => FakeQueryStore.Reference(database, schema, table, index);

    private static (string PlanId, ShowplanObjectV1[] References) Plan(
        string planId,
        params ShowplanObjectV1[] references) => FakeQueryStore.Plan(planId, references);
}
