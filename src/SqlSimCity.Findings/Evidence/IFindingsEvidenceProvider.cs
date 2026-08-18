using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Evidence;

/// <summary>
/// Assembles a bounded <see cref="FindingsEvidenceBundle"/> for one findings evaluation from the same
/// visible sources the other tabs expose. Implementations must be bounded (never load the whole Query
/// Store into memory), read-only, and cancellation-aware.
/// </summary>
public interface IFindingsEvidenceProvider
{
    Task<FindingsEvidenceBundle> GetBundleAsync(CancellationToken cancellationToken);
}

/// <summary>Bounds applied while assembling a bundle, so a 100k-family target never overwhelms a single findings request.</summary>
public sealed record FindingsEvidenceOptions
{
    /// <summary>Maximum number of query families loaded (with detail) into a single evaluation.</summary>
    public int MaxFamilies { get; init; } = 200;

    /// <summary>Maximum number of normalized Showplans loaded for the Showplan advisory rule.</summary>
    public int MaxPlans { get; init; } = 100;

    /// <summary>Ranking metrics paged to select the top families; deduplicated across metrics.</summary>
    public IReadOnlyList<string> Metrics { get; init; } = ["cpu", "duration", "reads"];

    public void Validate()
    {
        if (MaxFamilies is < 1 or > 2000)
            throw new ArgumentOutOfRangeException(nameof(MaxFamilies), MaxFamilies, "MaxFamilies must be between 1 and 2000.");
        if (MaxPlans is < 0 or > 1000)
            throw new ArgumentOutOfRangeException(nameof(MaxPlans), MaxPlans, "MaxPlans must be between 0 and 1000.");
    }
}
