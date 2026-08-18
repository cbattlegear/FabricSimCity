using System.Globalization;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>Numeric helpers shared by rules and the deterministic finding ordering.</summary>
public static class FindingImpact
{
    public static decimal Parse(string? value) =>
        value is not null && decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : 0m;

    public static bool TryParse(string? value, out decimal parsed) =>
        decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out parsed);

    public static string Format(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>The parsed magnitude used to order findings within a dimension; a null/non-numeric magnitude sorts last.</summary>
    public static decimal MagnitudeOf(FindingV1 finding) => Parse(finding.Impact.Magnitude);
}

/// <summary>
/// The total product of one findings evaluation: the ordered, firing findings plus the read-only
/// engine status that explains every rule's outcome and every source's freshness.
/// </summary>
public sealed record FindingsEvaluation(
    IReadOnlyList<FindingV1> Findings,
    FindingsEngineStatusV1 Status);
