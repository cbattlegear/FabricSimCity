namespace SqlSimCity.Collection.Negotiation;

/// <summary>
/// Decodes <c>sys.database_query_store_options.readonly_reason</c>'s documented bitmap into a
/// short, human-readable, non-secret sentence. Bit meanings are taken verbatim from Microsoft's
/// own reference documentation for that column; a bit this decoder does not recognize is reported
/// by its numeric value rather than silently dropped, so an undocumented future bit is still
/// visible to a reader instead of disappearing.
/// </summary>
public static class QueryStoreReadOnlyReason
{
    private static readonly (int Bit, string Description)[] KnownBits =
    [
        (1, "the database is in read-only mode"),
        (2, "the database is in single-user mode"),
        (4, "the database is in emergency mode"),
        (8, "the database is a readable secondary replica"),
        (65536, "Query Store reached its configured max_storage_size_mb limit"),
        (131072, "the number of distinct statements reached Query Store's internal memory limit"),
        (262144, "in-memory Query Store data waiting to be persisted reached the internal memory limit"),
        (524288, "the database reached its disk size limit"),
    ];

    public static string Describe(int readonlyReason)
    {
        if (readonlyReason == 0)
        {
            return "Query Store is not read-only.";
        }

        var reasons = new List<string>();
        var remaining = readonlyReason;
        foreach (var (bit, description) in KnownBits)
        {
            if ((readonlyReason & bit) != 0)
            {
                reasons.Add(description);
                remaining &= ~bit;
            }
        }

        if (remaining != 0)
        {
            reasons.Add($"an undocumented bit (0x{remaining:X}) is also set");
        }

        return "Query Store is read-only because " + string.Join("; ", reasons) + ".";
    }
}
