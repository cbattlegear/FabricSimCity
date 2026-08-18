namespace SqlSimCity.Collection.Negotiation;

/// <summary>One capability-negotiation request: which target, scoped to which single database for per-database facts.</summary>
public sealed record CapabilityNegotiationRequest(string TargetId, string DatabaseName);
