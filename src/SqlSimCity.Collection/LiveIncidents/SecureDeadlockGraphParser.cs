using System.Globalization;
using System.Xml;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.LiveIncidents;

/// <param name="MaximumXmlCharacters">
/// Cap on the graph document. A deadlock graph is bounded by the engine's own deadlock monitor --
/// it describes a cycle, not a workload -- so this is a pathological-input guard rather than a
/// working limit. Measured on a real two-process deadlock: 2.4 KB redacted, 12.7 KB with statement
/// text.
/// </param>
/// <param name="MaximumDepth">
/// A deadlock graph is four elements deep at most (deadlock / resource-list / keylock /
/// owner-list / owner). Anything deeper is not a graph this parser understands.
/// </param>
/// <param name="MaximumProcesses">
/// Cap on participants retained. A deadlock cycle involving hundreds of processes is a
/// parallelism deadlock, still legitimate, so this is set well above anything observed rather
/// than at the two-process common case.
/// </param>
/// <param name="MaximumResources">Cap on resources retained, for the same reason.</param>
/// <param name="MaximumParticipantsPerResource">
/// Cap on owner/waiter references retained for one resource. This is the one list that grows with
/// concurrency rather than with the size of the cycle.
/// </param>
/// <param name="MaximumStatementCharacters">
/// Cap on a single participant's statement text, applied only when the graph was fetched with
/// statement text included. Truncation is recorded in the text itself so a reader never mistakes a
/// clipped batch for a short one.
/// </param>
public sealed record DeadlockParserLimits(
    int MaximumXmlCharacters = 4 * 1024 * 1024,
    int MaximumDepth = 32,
    int MaximumProcesses = 512,
    int MaximumResources = 512,
    int MaximumParticipantsPerResource = 512,
    int MaximumStatementCharacters = 8 * 1024);

/// <summary>
/// Parses one <c>&lt;deadlock&gt;</c> graph as recorded by the <c>system_health</c> session.
/// <para>
/// The graph arrives as XML from a server the application does not control, so it is read with the
/// same hardening <c>SecureShowplanParser</c> applies to plan XML: DTD processing prohibited, no
/// resolver, no entity expansion, and every retained list bounded. An unparseable graph is reported
/// as unparseable; it is never partially rendered as a smaller deadlock than it was.
/// </para>
/// <para>
/// The parser is forgiving about what it does not recognise and strict about what it reports.
/// Resource elements are named by the engine (<c>keylock</c>, <c>objectlock</c>, <c>pagelock</c>,
/// <c>ridlock</c>, <c>exchangeEvent</c>, and more the engine may add), so the element name is
/// carried through verbatim rather than matched against a closed list -- an unrecognised resource
/// kind is still reported with its owners and waiters instead of being silently dropped, because a
/// dropped resource turns a cycle into an unexplained one.
/// </para>
/// </summary>
public sealed class SecureDeadlockGraphParser
{
    private readonly DeadlockParserLimits _limits;

    public SecureDeadlockGraphParser(DeadlockParserLimits? limits = null) =>
        _limits = limits ?? new DeadlockParserLimits();

    /// <summary>
    /// Parses <paramref name="xml"/> into a <see cref="DeadlockGraphV1"/>.
    /// </summary>
    /// <param name="id">
    /// The probe's stable deadlock identifier. It is supplied rather than derived here because it
    /// is computed from the graph's redacted form in SQL, so that requesting statement text does
    /// not change a deadlock's identity.
    /// </param>
    /// <param name="occurredAt">When the engine recorded the deadlock, not when it was read.</param>
    /// <param name="xml">The <c>&lt;deadlock&gt;</c> element, redacted or complete.</param>
    /// <param name="includesSqlText">
    /// Whether the graph was fetched with statement text. This is reported on the result as-is so a
    /// consumer can tell "no statement was recorded" from "statement text was not requested".
    /// </param>
    /// <exception cref="XmlException">The graph is not well-formed, or exceeds a stated limit.</exception>
    public DeadlockGraphV1 Parse(
        string id,
        DateTimeOffset occurredAt,
        string xml,
        bool includesSqlText,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        ArgumentNullException.ThrowIfNull(xml);
        if (xml.Length > _limits.MaximumXmlCharacters)
        {
            throw new XmlException(
                $"Deadlock graph exceeds the {_limits.MaximumXmlCharacters}-character limit.");
        }

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = _limits.MaximumXmlCharacters,
            MaxCharactersFromEntities = 0,
            IgnoreComments = true,
            IgnoreProcessingInstructions = true,
        };

        using var textReader = new StringReader(xml);
        using var reader = XmlReader.Create(textReader, settings);

        var victims = new List<string>();
        var processes = new List<ProcessBuilder>();
        var resources = new List<ResourceBuilder>();
        ProcessBuilder? currentProcess = null;
        ResourceBuilder? currentResource = null;
        var participantList = ParticipantList.None;

        while (reader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (reader.Depth > _limits.MaximumDepth)
            {
                throw new XmlException($"Deadlock graph exceeds the {_limits.MaximumDepth}-element depth limit.");
            }

            if (reader.NodeType == XmlNodeType.EndElement)
            {
                switch (reader.LocalName)
                {
                    case "process":
                        currentProcess = null;
                        break;
                    case "owner-list":
                    case "waiter-list":
                        participantList = ParticipantList.None;
                        break;
                    case "resource-list":
                        currentResource = null;
                        break;
                }

                continue;
            }

            if (reader.NodeType == XmlNodeType.Text && currentProcess is not null)
            {
                // Statement text arrives as the text content of <inputbuf> or of a frame inside
                // <executionStack>, and only when the caller asked for it. The first non-empty run
                // wins: <executionStack> precedes <inputbuf>, and the innermost executing statement
                // is more useful than the whole submitted batch.
                currentProcess.AppendStatement(reader.Value, _limits.MaximumStatementCharacters);
                continue;
            }

            if (reader.NodeType != XmlNodeType.Element)
            {
                continue;
            }

            switch (reader.LocalName)
            {
                case "victimProcess":
                {
                    var victimId = reader.GetAttribute("id");
                    if (!string.IsNullOrWhiteSpace(victimId) && victims.Count < _limits.MaximumProcesses)
                    {
                        victims.Add(victimId);
                    }

                    break;
                }

                case "process":
                {
                    var processId = reader.GetAttribute("id");
                    if (string.IsNullOrWhiteSpace(processId))
                    {
                        // Every owner/waiter reference is by id, so a process without one cannot be
                        // connected to anything it held or wanted. Reporting it as an anonymous
                        // participant would add a node to the cycle that no edge can reach.
                        break;
                    }

                    if (processes.Count >= _limits.MaximumProcesses)
                    {
                        throw new XmlException(
                            $"Deadlock graph exceeds the {_limits.MaximumProcesses}-process limit.");
                    }

                    var builder = new ProcessBuilder(processId)
                    {
                        SessionId = ParseInt(reader.GetAttribute("spid")),
                        DatabaseId = ParseInt(reader.GetAttribute("currentdb")),
                        DatabaseName = Trimmed(reader.GetAttribute("currentdbname")),
                        LockMode = Trimmed(reader.GetAttribute("lockMode")),
                        WaitResource = Trimmed(reader.GetAttribute("waitresource")),
                        WaitTimeMs = ParseLong(reader.GetAttribute("waittime")),
                        TransactionName = Trimmed(reader.GetAttribute("transactionname")),
                        IsolationLevel = Trimmed(reader.GetAttribute("isolationlevel")),
                        ClientApplication = Trimmed(reader.GetAttribute("clientapp")),
                        HostName = Trimmed(reader.GetAttribute("hostname")),
                        LoginName = Trimmed(reader.GetAttribute("loginname")),
                    };
                    processes.Add(builder);

                    // A self-closing <process/> raises no EndElement, so the "currently open
                    // process" must be cleared here rather than waiting for one that never comes --
                    // otherwise the next sibling's text would be attributed to this participant.
                    currentProcess = reader.IsEmptyElement ? null : builder;
                    break;
                }

                case "owner-list":
                    participantList = ParticipantList.Owners;
                    break;

                case "waiter-list":
                    participantList = ParticipantList.Waiters;
                    break;

                case "owner":
                case "waiter":
                {
                    if (currentResource is null || participantList == ParticipantList.None)
                    {
                        break;
                    }

                    var participantId = reader.GetAttribute("id");
                    if (string.IsNullOrWhiteSpace(participantId))
                    {
                        break;
                    }

                    var participant = new DeadlockParticipantV1(
                        participantId,
                        Trimmed(reader.GetAttribute("mode")),
                        Trimmed(reader.GetAttribute("requestType")));
                    var target = participantList == ParticipantList.Owners
                        ? currentResource.Owners
                        : currentResource.Waiters;
                    if (target.Count < _limits.MaximumParticipantsPerResource)
                    {
                        target.Add(participant);
                    }

                    break;
                }

                case "deadlock":
                case "victim-list":
                case "process-list":
                case "resource-list":
                case "executionStack":
                case "frame":
                case "inputbuf":
                    break;

                default:
                {
                    // Anything else at resource-list depth is a resource, whatever the engine calls
                    // it. Matching on a closed list here would drop resource kinds added by a newer
                    // engine and leave the cycle unexplained.
                    if (reader.Depth != ResourceDepth)
                    {
                        break;
                    }

                    if (resources.Count >= _limits.MaximumResources)
                    {
                        throw new XmlException(
                            $"Deadlock graph exceeds the {_limits.MaximumResources}-resource limit.");
                    }

                    currentResource = new ResourceBuilder(reader.LocalName)
                    {
                        DatabaseId = ParseInt(reader.GetAttribute("dbid")),
                        ObjectName = Trimmed(reader.GetAttribute("objectname")),
                        IndexName = Trimmed(reader.GetAttribute("indexname")),
                        AssociatedObjectId = ParseLong(reader.GetAttribute("associatedObjectId")),
                    };
                    resources.Add(currentResource);
                    break;
                }
            }
        }

        var victimSet = new HashSet<string>(victims, StringComparer.Ordinal);
        return new DeadlockGraphV1(
            id,
            occurredAt,
            processes.Select(p => p.Build(victimSet.Contains(p.Id))).ToArray(),
            resources.Select(r => r.Build()).ToArray(),
            victims,
            includesSqlText);
    }

    /// <summary>
    /// Depth of a resource element: <c>deadlock</c> is 0, <c>resource-list</c> is 1, so each
    /// resource sits at 2.
    /// </summary>
    private const int ResourceDepth = 2;

    private enum ParticipantList
    {
        None,
        Owners,
        Waiters,
    }

    private static string? Trimmed(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Trim();
    }

    private static int? ParseInt(string? value) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private static long? ParseLong(string? value) =>
        long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private sealed class ProcessBuilder(string id)
    {
        private string? _statement;

        public string Id { get; } = id;

        public int? SessionId { get; init; }

        public int? DatabaseId { get; init; }

        public string? DatabaseName { get; init; }

        public string? LockMode { get; init; }

        public string? WaitResource { get; init; }

        public long? WaitTimeMs { get; init; }

        public string? TransactionName { get; init; }

        public string? IsolationLevel { get; init; }

        public string? ClientApplication { get; init; }

        public string? HostName { get; init; }

        public string? LoginName { get; init; }

        public void AppendStatement(string value, int maximumCharacters)
        {
            if (_statement is not null || string.IsNullOrWhiteSpace(value))
            {
                return;
            }

            var trimmed = value.Trim();
            _statement = trimmed.Length <= maximumCharacters
                ? trimmed
                : trimmed[..maximumCharacters] + "... [truncated]";
        }

        public DeadlockProcessV1 Build(bool isVictim) => new(
            Id,
            SessionId,
            isVictim,
            DatabaseId,
            DatabaseName,
            LockMode,
            WaitResource,
            WaitTimeMs,
            TransactionName,
            IsolationLevel,
            ClientApplication,
            HostName,
            LoginName,
            _statement);
    }

    private sealed class ResourceBuilder(string resourceKind)
    {
        public string ResourceKind { get; } = resourceKind;

        public int? DatabaseId { get; init; }

        public string? ObjectName { get; init; }

        public string? IndexName { get; init; }

        public long? AssociatedObjectId { get; init; }

        public List<DeadlockParticipantV1> Owners { get; } = [];

        public List<DeadlockParticipantV1> Waiters { get; } = [];

        public DeadlockResourceV1 Build() => new(
            ResourceKind,
            DatabaseId,
            ObjectName,
            IndexName,
            AssociatedObjectId,
            Owners.ToArray(),
            Waiters.ToArray());
    }
}
