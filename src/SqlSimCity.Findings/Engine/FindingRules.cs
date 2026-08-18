using SqlSimCity.Findings.Rules;

namespace SqlSimCity.Findings.Engine;

/// <summary>The canonical, ordered set of findings rules SQLSimCity ships with, including the explicitly unsupported ones.</summary>
public static class FindingRules
{
    public static IReadOnlyList<IFindingRule> Default() =>
    [
        new QueryStoreHealthRule(),
        new PlanRegressionRule(),
        new PlanInstabilityRule(),
        new ForcedPlanFailureRule(),
        new VariantImbalanceRule(),
        new AbortedExceptionShareRule(),
        new DominantWaitRule(),
        new QueryResourceDominanceRule(),
        new RootBlockerRule(),
        new MemoryGrantQueueRule(),
        new LogSpacePressureRule(),
        new FileIoPressureRule(),
        new ShowplanAdvisoryRule(),
        new TempdbAttributionRule(),
        new PerOperatorAttributionRule(),
    ];
}
