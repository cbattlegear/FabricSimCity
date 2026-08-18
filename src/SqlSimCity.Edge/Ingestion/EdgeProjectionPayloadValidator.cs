using System.Text.Json;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Ingestion;

public static class EdgeProjectionPayloadValidator
{
    public static string? Validate(PublishedEdgeGeneration generation)
    {
        try
        {
            var atlas = Read<AtlasObservationV1>(generation, ObservationSection.Atlas);
            var capabilities = Read<CapabilitiesSnapshotV1>(generation, ObservationSection.Capabilities);
            var queryStore = Read<QueryStoreObservationV1>(generation, ObservationSection.QueryStore);
            var city = Read<DatabaseCityObservationV1>(generation, ObservationSection.DatabaseCity);
            var live = Read<LiveIncidentResponseV1>(generation, ObservationSection.Live);

            if (!string.Equals(atlas.Snapshot.Target.TargetId, generation.TargetId, StringComparison.Ordinal))
                return "Atlas payload target does not match the observation target.";
            if (capabilities.Targets.Any(target =>
                    !string.Equals(target.TargetId, generation.TargetId, StringComparison.Ordinal)))
                return "Capability payload target does not match the observation target.";
            if (live.Snapshot is not null &&
                !string.Equals(live.Snapshot.Target.TargetId, generation.TargetId, StringComparison.Ordinal))
                return "Live payload target does not match the observation target.";
            if (atlas.Snapshot is null || atlas.Status is null ||
                capabilities.Targets is null || queryStore.Status is null ||
                queryStore.Families is null || queryStore.Plans is null ||
                city.Pages is null || city.Summaries.Databases is null)
                return "Projection payload contains a null collection.";
            if (queryStore.Families.Select(value => value.Family.FamilyId)
                    .Distinct(StringComparer.Ordinal).Count() != queryStore.Families.Count)
                return "Query Store payload contains duplicate family ids.";
            if (queryStore.Plans.Select(value => value.PlanId)
                    .Distinct(StringComparer.Ordinal).Count() != queryStore.Plans.Count)
                return "Query Store payload contains duplicate plan ids.";
            if (city.Pages.Select(value => $"{value.DatabaseId}\u0001{value.Metric}")
                    .Distinct(StringComparer.Ordinal).Count() != city.Pages.Count)
                return "Database City payload contains duplicate database/metric pages.";
            if (capabilities.Targets.Any(target =>
                    target.QueryStoreByDatabase.Values.Any(value => value is null)) ||
                queryStore.Families.Any(family =>
                    family.Runtime.Any(runtime =>
                        runtime.WaitMilliseconds.Values.Any(value => value is null))))
                return "Projection payload contains a null dictionary value.";
            return null;
        }
        catch (JsonException)
        {
            return "Projection section is not a valid standard payload.";
        }
        catch (NotSupportedException)
        {
            return "Projection section uses an unsupported payload type.";
        }
        catch (InvalidOperationException)
        {
            return "Projection section violates a required standard payload shape.";
        }
    }

    private static T Read<T>(PublishedEdgeGeneration generation, ObservationSection section)
    {
        var content = generation.Sections[section].Content;
        using var document = JsonDocument.Parse(content);
        if (ContainsNullArrayElement(document.RootElement))
            throw new JsonException("Projection arrays cannot contain null elements.");
        return JsonSerializer.Deserialize<T>(content, EdgeJson.Options)
               ?? throw new JsonException("Projection section is empty.");
    }

    private static bool ContainsNullArrayElement(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Null || ContainsNullArrayElement(item))
                    return true;
            }
            return false;
        }
        if (element.ValueKind != JsonValueKind.Object)
            return false;
        foreach (var property in element.EnumerateObject())
        {
            if (ContainsNullArrayElement(property.Value))
                return true;
        }
        return false;
    }
}
