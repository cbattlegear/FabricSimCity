using System.Globalization;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Blocking;

/// <summary>
/// Parses the verbatim <c>wait_resource</c> / <c>resource_description</c> text that SQL Server
/// reports for a lock wait into a structured <see cref="LockResourceV1"/>.
///
/// This type is deliberately pure and does no I/O. It reports exactly what the text states and
/// nothing more:
///
/// <list type="bullet">
/// <item><c>OBJECT: db:objectid:lockPartition</c> and <c>TAB: db:objectid</c> carry the object id
/// outright, so they resolve with no lookup at all.</item>
/// <item><c>KEY: db:hobtid (hash)</c>, <c>HOBT: db:hobtid</c>, and <c>PAGE</c>-with-hobt forms carry
/// only a <c>hobt_id</c>. They are reported <see cref="LockResolutionStatus.RequiresLookup"/> and it
/// is the caller's job to run the bounded <c>sessions.lock_resource_objects</c> probe and call
/// <see cref="Resolve"/>.</item>
/// <item><c>PAGE: db:file:page</c> and <c>RID: db:file:page:slot</c> name a physical location. Going
/// from there to an object needs <c>sys.dm_db_page_info</c> or an allocation scan, which is far too
/// costly for a realtime probe, so they are reported
/// <see cref="LockResolutionStatus.Unresolvable"/> with that reason and are never guessed.</item>
/// <item><c>DATABASE</c>, <c>FILE</c>, <c>APPLICATION</c>, <c>METADATA</c>, and <c>EXTENT</c> locks
/// are not on a user object at all, so they are reported
/// <see cref="LockResolutionStatus.NotObjectScoped"/>.</item>
/// <item><c>XACT: db:tid</c> is a lock on a transaction id, taken by optimized locking in place of
/// holding row and key locks until commit. It is understood in full and names no object, so it is
/// also <see cref="LockResolutionStatus.NotObjectScoped"/> -- see
/// <see href="https://learn.microsoft.com/sql/relational-databases/performance/optimized-locking">Optimized
/// locking</see>.</item>
/// <item>Anything else stays <see cref="LockResourceKind.Unrecognized"/> rather than being coerced
/// into a plausible-looking shape.</item>
/// </list>
/// </summary>
public static class LockResourceParser
{
    private const string RequiresLookupReason =
        "The lock names a hobt_id, not an object_id. Run the sessions.lock_resource_objects probe to resolve it via sys.partitions.";

    private const string PageReason =
        "A page/row lock names a physical location (file:page[:slot]). Mapping that to an object needs sys.dm_db_page_info or an allocation scan, which is too costly for a realtime probe, so no object is claimed.";

    /// <summary>
    /// Why an <c>XACT</c> wait names no building. Written for the reader looking at the map and
    /// wondering where the pin went: it says what is actually happening, and where the table can be
    /// found instead, rather than reporting the engine's vocabulary as unfamiliar.
    /// </summary>
    private const string TransactionReason =
        "This wait is on a transaction id, not on a table. The database has optimized locking enabled, so the blocker holds a single lock on its own transaction and row locks are released as each row is modified -- the wait itself names no object. The blocking session's own statement names the tables involved.";

    /// <summary>
    /// Parses <paramref name="rawResource"/>. Returns null for null/whitespace input, because "the
    /// engine reported no wait resource" is a different fact from "we parsed it and learned nothing".
    /// </summary>
    public static LockResourceV1? Parse(string? rawResource)
    {
        if (string.IsNullOrWhiteSpace(rawResource))
        {
            return null;
        }

        var raw = rawResource.Trim();
        var separator = raw.IndexOf(':');
        if (separator <= 0)
        {
            return Unrecognized(raw, "The resource text has no 'KIND: ...' prefix, so no lock form could be identified.");
        }

        var prefix = raw[..separator].Trim();
        var body = raw[(separator + 1)..].Trim();

        return prefix.ToUpperInvariant() switch
        {
            "OBJECT" => ParseObject(raw, body),
            "TAB" => ParseObject(raw, body),
            "KEY" => ParseHobt(raw, body, LockResourceKind.Key),
            "HOBT" => ParseHobt(raw, body, LockResourceKind.HoBt),
            "ALLOCUNIT" => ParseHobt(raw, body, LockResourceKind.AllocationUnit),
            "PAGE" => ParsePage(raw, body, LockResourceKind.Page),
            "RID" => ParsePage(raw, body, LockResourceKind.Rid),
            "EXTENT" => NotObjectScoped(raw, body, LockResourceKind.Extent, "An extent lock covers an allocation extent, not a single user object."),
            "FILE" => NotObjectScoped(raw, body, LockResourceKind.File, "A file lock is on a database file, not a user object."),
            "DATABASE" => NotObjectScoped(raw, body, LockResourceKind.Database, "A database lock is database-wide, not on a user object."),
            "APPLICATION" => NotObjectScoped(raw, body, LockResourceKind.Application, "An application lock is a user-defined name taken with sp_getapplock; it is not a database object."),
            "METADATA" => NotObjectScoped(raw, body, LockResourceKind.Metadata, "A metadata lock is on a catalog subresource, not on a user object."),
            "XACT" => ParseTransaction(raw, body),
            _ => Unrecognized(raw, $"'{prefix}' is not a lock-resource form this build understands, so nothing is claimed about it."),
        };
    }

    /// <summary>
    /// Completes a <see cref="LockResolutionStatus.RequiresLookup"/> resource with the object/index
    /// identity a lookup returned. Anything already resolved, or resolvable only at a cost we refuse
    /// to pay, is returned unchanged -- resolution is additive and never overwrites a fact the engine
    /// already stated. The caller supplies <paramref name="reason"/> so the record says where the
    /// identity actually came from rather than assuming a live catalog read.
    /// </summary>
    public static LockResourceV1 Resolve(
        LockResourceV1 resource,
        int objectId,
        int? indexId,
        string? schemaName,
        string? objectName,
        string? indexName,
        string reason)
    {
        ArgumentNullException.ThrowIfNull(resource);
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        if (resource.Status != LockResolutionStatus.RequiresLookup)
        {
            return resource;
        }

        return resource with
        {
            ObjectId = objectId,
            IndexId = indexId,
            SchemaName = schemaName,
            ObjectName = objectName,
            IndexName = indexName,
            Status = LockResolutionStatus.Resolved,
            Reason = reason,
        };
    }

    /// <summary>
    /// The reason a connected collector records when the <c>sessions.lock_resource_objects</c> probe
    /// resolved a hobt against the live catalog.
    /// </summary>
    public const string CatalogLookupReason =
        "Resolved from the lock's hobt_id via sys.partitions in the database that reported the lock.";

    /// <summary>
    /// Records that a bounded lookup ran and did not cover this hobt. The resource keeps
    /// <see cref="LockResolutionStatus.RequiresLookup"/> -- the caller learned that the lookup missed,
    /// not that the lock has no object.
    /// </summary>
    public static LockResourceV1 MarkLookupMissed(LockResourceV1 resource, string reason)
    {
        ArgumentNullException.ThrowIfNull(resource);
        if (resource.Status != LockResolutionStatus.RequiresLookup)
        {
            return resource;
        }

        return resource with { Reason = reason };
    }

    private static LockResourceV1 ParseObject(string raw, string body)
    {
        // OBJECT: 7:1234567:0   |   TAB: 7:1234567
        var parts = Split(body);
        var databaseId = ParseInt(parts, 0);
        var objectId = ParseInt(parts, 1);
        if (objectId is null)
        {
            return new LockResourceV1(
                raw,
                LockResourceKind.Object,
                databaseId,
                null,
                null,
                null,
                null,
                null,
                LockResolutionStatus.Unrecognized,
                "The OBJECT/TAB resource did not carry a readable object id, so no object is claimed.");
        }

        return new LockResourceV1(
            raw,
            LockResourceKind.Object,
            databaseId,
            objectId,
            null,
            null,
            null,
            null,
            LockResolutionStatus.Resolved,
            "The lock resource names the object id directly; no catalog lookup was needed.");
    }

    private static LockResourceV1 ParseHobt(string raw, string body, LockResourceKind kind)
    {
        // KEY: 7:72057594043170816 (8194443284a0)   |   HOBT: 7:72057594043170816
        var parts = Split(body);
        var databaseId = ParseInt(parts, 0);
        var hobtId = ParseLong(parts, 1);
        if (hobtId is null)
        {
            return new LockResourceV1(
                raw,
                kind,
                databaseId,
                null,
                null,
                null,
                null,
                null,
                LockResolutionStatus.Unrecognized,
                "The resource did not carry a readable hobt_id, so no object is claimed.");
        }

        return new LockResourceV1(
            raw,
            kind,
            databaseId,
            null,
            null,
            null,
            null,
            null,
            LockResolutionStatus.RequiresLookup,
            RequiresLookupReason)
        {
            HobtId = hobtId,
        };
    }

    private static LockResourceV1 ParsePage(string raw, string body, LockResourceKind kind)
    {
        // PAGE: 7:1:26483   |   RID: 7:1:26483:12
        var parts = Split(body);
        var databaseId = ParseInt(parts, 0);
        return new LockResourceV1(
            raw,
            kind,
            databaseId,
            null,
            null,
            null,
            null,
            null,
            LockResolutionStatus.Unresolvable,
            PageReason);
    }

    private static LockResourceV1 NotObjectScoped(string raw, string body, LockResourceKind kind, string reason)
    {
        var parts = Split(body);
        return new LockResourceV1(
            raw,
            kind,
            ParseInt(parts, 0),
            null,
            null,
            null,
            null,
            null,
            LockResolutionStatus.NotObjectScoped,
            reason);
    }

    /// <summary>
    /// Reads an <c>XACT</c> resource -- a lock on a transaction id, which optimized locking uses in
    /// place of holding row and key locks to the end of a transaction.
    ///
    /// This is <see cref="LockResolutionStatus.NotObjectScoped"/> rather than
    /// <see cref="LockResourceKind.Unrecognized"/>: the form is understood completely, and what it
    /// states is that the waiter is queued behind another *transaction*, not behind a row of any
    /// particular table. Reporting it as unrecognised claimed a gap in this parser that does not
    /// exist, and inviting a lookup would be worse -- there is no object id to find, because under
    /// TID locking the row and page locks that would have named one are released as each row is
    /// modified rather than held until commit.
    ///
    /// The text is accepted in both shapes the engine writes it. <c>wait_resource</c> prefixes the
    /// database id (<c>XACT: 7:1299696</c>); <c>sys.dm_tran_locks.resource_description</c> carries
    /// the transaction id alone, because that view reports the database in its own column. The
    /// transaction id is the last numeric component either way.
    /// </summary>
    private static LockResourceV1 ParseTransaction(string raw, string body)
    {
        var parts = Split(body);
        var transactionId = parts.Length >= 2 ? ParseLong(parts, 1) : ParseLong(parts, 0);
        // A leading 0 is a placeholder, not database 0 -- no database has id 0, so recording one
        // would invent a fact the text never stated.
        var databaseId = parts.Length >= 2 ? ParseInt(parts, 0) : null;
        if (databaseId is <= 0)
        {
            databaseId = null;
        }

        return new LockResourceV1(
            raw,
            LockResourceKind.Transaction,
            databaseId,
            null,
            null,
            null,
            null,
            null,
            LockResolutionStatus.NotObjectScoped,
            TransactionReason)
        {
            TransactionId = transactionId,
        };
    }

    private static LockResourceV1 Unrecognized(string raw, string reason) => new(
        raw,
        LockResourceKind.Unrecognized,
        null,
        null,
        null,
        null,
        null,
        null,
        LockResolutionStatus.Unrecognized,
        reason);

    /// <summary>
    /// Splits the body on ':' after dropping any trailing parenthesised hash, which KEY resources
    /// carry (<c>KEY: 7:72057594043170816 (8194443284a0)</c>).
    /// </summary>
    private static string[] Split(string body)
    {
        var trimmed = body;
        var paren = trimmed.IndexOf('(');
        if (paren >= 0)
        {
            trimmed = trimmed[..paren];
        }

        return trimmed.Split(':', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    }

    private static int? ParseInt(string[] parts, int index) =>
        index < parts.Length && int.TryParse(parts[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;

    private static long? ParseLong(string[] parts, int index) =>
        index < parts.Length && long.TryParse(parts[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
}
