using System.Xml;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Pins the deadlock parser against a graph captured verbatim from a real SQL Server 2022
/// <c>system_health</c> session, provoked by two sessions taking the same two rows in opposite
/// orders. The XML is not hand-written: a hand-written fixture only ever proves the parser agrees
/// with whoever wrote it, and the attribute set, the element nesting and the id-reference scheme
/// here are all things the engine decides.
/// </summary>
public sealed class SecureDeadlockGraphParserTests
{
    /// <summary>
    /// The redacted form the probe returns by default: every <c>&lt;process&gt;</c> attribute kept,
    /// <c>&lt;executionStack&gt;</c> and <c>&lt;inputbuf&gt;</c> removed, <c>&lt;resource-list&gt;</c>
    /// whole.
    /// </summary>
    private const string RealRedactedGraph = """
        <deadlock>
          <victim-list>
            <victimProcess id="process21c43b4d088" />
          </victim-list>
          <process-list>
            <process id="process21c43b4d088" taskpriority="0" logused="264" waitresource="KEY: 6:72057594045792256 (8194443284a0)" waittime="4875" ownerId="207700" transactionname="user_transaction" lasttranstarted="2026-08-26T14:08:28.567" XDES="0x21c5b114470" lockMode="X" schedulerid="18" kpid="35248" status="suspended" spid="70" sbid="0" ecid="0" priority="0" trancount="2" lastbatchstarted="2026-08-26T14:08:28.563" lastbatchcompleted="2026-08-26T14:08:28.563" lastattention="1900-01-01T00:00:00.563" clientapp="SQLCMD" hostname="BATTLEGEAR" hostpid="69024" loginname="battlegear\camer" isolationlevel="read committed (2)" xactid="207700" currentdb="6" currentdbname="SimCityDeadlockLab" lockTimeout="4294967295" clientoption1="671088672" clientoption2="128056" />
            <process id="process21c4340bc28" taskpriority="0" logused="264" waitresource="KEY: 6:72057594045726720 (8194443284a0)" waittime="4722" ownerId="207720" transactionname="user_transaction" lasttranstarted="2026-08-26T14:08:28.717" XDES="0x21c59b84470" lockMode="X" schedulerid="3" kpid="60888" status="suspended" spid="71" sbid="0" ecid="0" priority="0" trancount="2" lastbatchstarted="2026-08-26T14:08:28.713" lastbatchcompleted="2026-08-26T14:08:28.713" lastattention="1900-01-01T00:00:00.713" clientapp="SQLCMD" hostname="BATTLEGEAR" hostpid="2816" loginname="battlegear\camer" isolationlevel="read committed (2)" xactid="207720" currentdb="6" currentdbname="SimCityDeadlockLab" lockTimeout="4294967295" clientoption1="671088672" clientoption2="128056" />
          </process-list>
          <resource-list>
            <keylock hobtid="72057594045792256" dbid="6" objectname="SimCityDeadlockLab.dbo.B" indexname="PK__B__3213E83F21F38E08" id="lock21c43be3300" mode="X" associatedObjectId="72057594045792256">
              <owner-list>
                <owner id="process21c4340bc28" mode="X" />
              </owner-list>
              <waiter-list>
                <waiter id="process21c43b4d088" mode="X" requestType="wait" />
              </waiter-list>
            </keylock>
            <keylock hobtid="72057594045726720" dbid="6" objectname="SimCityDeadlockLab.dbo.A" indexname="PK__A__3213E83F0E531E14" id="lock21c43e60480" mode="X" associatedObjectId="72057594045726720">
              <owner-list>
                <owner id="process21c43b4d088" mode="X" />
              </owner-list>
              <waiter-list>
                <waiter id="process21c4340bc28" mode="X" requestType="wait" />
              </waiter-list>
            </keylock>
          </resource-list>
        </deadlock>
        """;

    private static readonly DateTimeOffset OccurredAt = new(2026, 8, 26, 19, 8, 36, 454, TimeSpan.Zero);

    private static DeadlockGraphV1 ParseReal(bool includesSqlText = false) =>
        new SecureDeadlockGraphParser().Parse("deadlock-1", OccurredAt, RealRedactedGraph, includesSqlText);

    [Fact]
    public void ReadsBothParticipantsAndMarksOnlyTheVictim()
    {
        var graph = ParseReal();

        Assert.Equal(2, graph.Processes.Count);
        Assert.Equal(["process21c43b4d088"], graph.VictimProcessIds);

        var victim = Assert.Single(graph.Processes, p => p.IsVictim);
        Assert.Equal("process21c43b4d088", victim.Id);
        Assert.Equal(70, victim.SessionId);

        var survivor = Assert.Single(graph.Processes, p => !p.IsVictim);
        Assert.Equal(71, survivor.SessionId);
    }

    [Fact]
    public void KeepsTheAttributesThatSurviveRedaction()
    {
        // These are exactly the fields that make a redacted graph usable: without them the only way
        // to describe a deadlock would be the statement text the probe deliberately drops.
        var victim = Assert.Single(ParseReal().Processes, p => p.IsVictim);

        Assert.Equal(6, victim.DatabaseId);
        Assert.Equal("SimCityDeadlockLab", victim.DatabaseName);
        Assert.Equal("X", victim.LockMode);
        Assert.Equal("KEY: 6:72057594045792256 (8194443284a0)", victim.WaitResource);
        Assert.Equal(4875, victim.WaitTimeMs);
        Assert.Equal("user_transaction", victim.TransactionName);
        Assert.Equal("read committed (2)", victim.IsolationLevel);
        Assert.Equal("SQLCMD", victim.ClientApplication);
        Assert.Equal("BATTLEGEAR", victim.HostName);
        Assert.Equal(@"battlegear\camer", victim.LoginName);
    }

    [Fact]
    public void ResolvesEachResourceToTheObjectItNames()
    {
        // The three-part object name is the single most load-bearing field for a map that places a
        // deadlock on the road between two tables. If this regresses, a pin has nowhere to go.
        var graph = ParseReal();

        Assert.Equal(2, graph.Resources.Count);
        Assert.All(graph.Resources, r => Assert.Equal("keylock", r.ResourceKind));
        Assert.Equal(
            ["SimCityDeadlockLab.dbo.A", "SimCityDeadlockLab.dbo.B"],
            graph.Resources.Select(r => r.ObjectName ?? "<none>").Order().ToArray());

        var lockedB = Assert.Single(graph.Resources, r => r.ObjectName == "SimCityDeadlockLab.dbo.B");
        Assert.Equal(6, lockedB.DatabaseId);
        Assert.Equal("PK__B__3213E83F21F38E08", lockedB.IndexName);
        Assert.Equal(72057594045792256L, lockedB.AssociatedObjectId);
    }

    [Fact]
    public void OwnersAndWaitersPointBackAtRealProcessesAndFormTheCycle()
    {
        // A deadlock graph is only meaningful if the id references resolve. A parser that read
        // owners and waiters into the wrong lists, or lost them, would still produce two processes
        // and two resources and describe no cycle at all.
        var graph = ParseReal();
        var processIds = graph.Processes.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);

        foreach (var resource in graph.Resources)
        {
            var owner = Assert.Single(resource.Owners);
            var waiter = Assert.Single(resource.Waiters);
            Assert.Contains(owner.ProcessId, processIds);
            Assert.Contains(waiter.ProcessId, processIds);
            Assert.Equal("X", owner.Mode);
            Assert.Equal("X", waiter.Mode);
            Assert.Equal("wait", waiter.RequestType);

            // Each participant waits on what the other holds; that is the cycle.
            Assert.NotEqual(owner.ProcessId, waiter.ProcessId);
        }

        var lockedA = Assert.Single(graph.Resources, r => r.ObjectName == "SimCityDeadlockLab.dbo.A");
        var lockedB = Assert.Single(graph.Resources, r => r.ObjectName == "SimCityDeadlockLab.dbo.B");
        Assert.Equal(lockedA.Owners[0].ProcessId, lockedB.Waiters[0].ProcessId);
        Assert.Equal(lockedB.Owners[0].ProcessId, lockedA.Waiters[0].ProcessId);
    }

    [Fact]
    public void AttributesEachParticipantsStatementToThatParticipant()
    {
        // Statement text arrives as loose text nodes under whichever <process> is currently open, so
        // "which participant said this" is positional state the parser has to keep correctly. Getting
        // it wrong would report the blocker's batch as the victim's, which reverses the story a
        // deadlock tells.
        const string twoBatches = """
            <deadlock>
              <victim-list><victimProcess id="p1" /></victim-list>
              <process-list>
                <process id="p1" spid="70" currentdb="6">
                  <executionStack><frame procname="adhoc" line="1">UPDATE dbo.B SET Val = 1 WHERE Id = 1;</frame></executionStack>
                  <inputbuf>
            BEGIN TRAN; UPDATE dbo.A SET Val = 1 WHERE Id = 1; UPDATE dbo.B SET Val = 1 WHERE Id = 1;   </inputbuf>
                </process>
                <process id="p2" spid="71" currentdb="6">
                  <executionStack><frame procname="adhoc" line="1">UPDATE dbo.A SET Val = 2 WHERE Id = 1;</frame></executionStack>
                  <inputbuf>
            BEGIN TRAN; UPDATE dbo.B SET Val = 2 WHERE Id = 1; UPDATE dbo.A SET Val = 2 WHERE Id = 1;   </inputbuf>
                </process>
              </process-list>
              <resource-list />
            </deadlock>
            """;

        var graph = new SecureDeadlockGraphParser().Parse("d", OccurredAt, twoBatches, includesSqlText: true);

        Assert.Equal("UPDATE dbo.B SET Val = 1 WHERE Id = 1;", Assert.Single(graph.Processes, p => p.Id == "p1").Statement);
        Assert.Equal("UPDATE dbo.A SET Val = 2 WHERE Id = 1;", Assert.Single(graph.Processes, p => p.Id == "p2").Statement);
    }

    [Fact]
    public void ARedactedGraphReportsNoStatementForAnyParticipant()
    {
        // Every <process> in a redacted graph is attribute-only and therefore self-closing, which
        // raises no EndElement. Nothing may be invented to fill the gap: the absence is disclosed by
        // IncludesSqlText, not papered over.
        Assert.All(ParseReal().Processes, p => Assert.Null(p.Statement));
    }

    [Fact]
    public void ReportsWhetherStatementTextWasRequestedRatherThanInferringItFromAbsence()
    {
        // A consumer must be able to tell "text was not asked for" from "this participant ran
        // nothing". Absence alone cannot carry that, so the flag travels with the graph.
        Assert.False(ParseReal(includesSqlText: false).IncludesSqlText);
        Assert.True(ParseReal(includesSqlText: true).IncludesSqlText);
    }

    [Fact]
    public void ReadsStatementTextWhenTheGraphCarriesIt()
    {
        const string withText = """
            <deadlock>
              <victim-list><victimProcess id="p1" /></victim-list>
              <process-list>
                <process id="p1" spid="70" currentdb="6">
                  <executionStack>
                    <frame procname="adhoc" line="1">UPDATE dbo.B SET Val = 1 WHERE Id = 1;</frame>
                  </executionStack>
                  <inputbuf>
            BEGIN TRAN; UPDATE dbo.A SET Val = 1 WHERE Id = 1; UPDATE dbo.B SET Val = 1 WHERE Id = 1;   </inputbuf>
                </process>
              </process-list>
              <resource-list />
            </deadlock>
            """;

        var process = Assert.Single(
            new SecureDeadlockGraphParser().Parse("d", OccurredAt, withText, includesSqlText: true).Processes);

        // The executing statement, not the whole submitted batch: the frame precedes the inputbuf
        // and is the more specific answer to "what was this participant doing".
        Assert.Equal("UPDATE dbo.B SET Val = 1 WHERE Id = 1;", process.Statement);
    }

    [Fact]
    public void CarriesAnUnrecognisedResourceKindThroughInsteadOfDroppingIt()
    {
        // The engine names resource elements, and the set is its to extend. Dropping one that this
        // build does not recognise would turn a real cycle into an unexplained one.
        const string exchange = """
            <deadlock>
              <victim-list><victimProcess id="p1" /></victim-list>
              <process-list><process id="p1" spid="70" /><process id="p2" spid="71" /></process-list>
              <resource-list>
                <exchangeEvent id="Pipe123" WaitType="e_waitPipeNewRow" nodeId="4">
                  <owner-list><owner id="p1" /></owner-list>
                  <waiter-list><waiter id="p2" /></waiter-list>
                </exchangeEvent>
                <somethingNewerEngine dbid="9" objectname="db.dbo.T">
                  <owner-list><owner id="p2" mode="X" /></owner-list>
                  <waiter-list><waiter id="p1" mode="S" /></waiter-list>
                </somethingNewerEngine>
              </resource-list>
            </deadlock>
            """;

        var graph = new SecureDeadlockGraphParser().Parse("d", OccurredAt, exchange, includesSqlText: false);

        Assert.Equal(["exchangeEvent", "somethingNewerEngine"], graph.Resources.Select(r => r.ResourceKind).ToArray());

        var parallelism = graph.Resources[0];
        Assert.Null(parallelism.ObjectName);
        Assert.Equal("p1", Assert.Single(parallelism.Owners).ProcessId);
        Assert.Equal("p2", Assert.Single(parallelism.Waiters).ProcessId);

        var unknown = graph.Resources[1];
        Assert.Equal("db.dbo.T", unknown.ObjectName);
        Assert.Equal(9, unknown.DatabaseId);
    }

    [Fact]
    public void OwnerAndWaiterListsAreNotConflated()
    {
        // Both lists hold the same element shape under sibling parents, so a parser that tracked
        // only "am I inside a resource" would fill one list twice and lose the direction of the
        // wait -- which is the difference between "held by" and "waiting for".
        const string asymmetric = """
            <deadlock>
              <victim-list><victimProcess id="p1" /></victim-list>
              <process-list><process id="p1" spid="1" /><process id="p2" spid="2" /><process id="p3" spid="3" /></process-list>
              <resource-list>
                <objectlock dbid="5" objectname="db.dbo.T" mode="X">
                  <owner-list><owner id="p1" mode="X" /><owner id="p2" mode="IX" /></owner-list>
                  <waiter-list><waiter id="p3" mode="S" requestType="wait" /></waiter-list>
                </objectlock>
              </resource-list>
            </deadlock>
            """;

        var resource = Assert.Single(
            new SecureDeadlockGraphParser().Parse("d", OccurredAt, asymmetric, includesSqlText: false).Resources);

        Assert.Equal(["p1", "p2"], resource.Owners.Select(o => o.ProcessId).ToArray());
        Assert.Equal(["p3"], resource.Waiters.Select(w => w.ProcessId).ToArray());
        Assert.Equal("IX", resource.Owners[1].Mode);
        Assert.Equal("wait", resource.Waiters[0].RequestType);
    }

    [Fact]
    public void RefusesADocumentTypeDeclarationRatherThanResolvingIt()
    {
        // The graph is XML from a server this application does not control, so the usual XML attack
        // surface applies even though the content is diagnostic.
        const string withDtd = """
            <!DOCTYPE deadlock [<!ENTITY x "expanded">]>
            <deadlock><victim-list /><process-list /><resource-list /></deadlock>
            """;

        Assert.Throws<XmlException>(() =>
            new SecureDeadlockGraphParser().Parse("d", OccurredAt, withDtd, includesSqlText: false));
    }

    [Fact]
    public void RejectsAGraphOverTheStatedSizeLimit()
    {
        var limits = new DeadlockParserLimits(MaximumXmlCharacters: 64);
        var ex = Assert.Throws<XmlException>(() =>
            new SecureDeadlockGraphParser(limits).Parse("d", OccurredAt, RealRedactedGraph, includesSqlText: false));

        Assert.Contains("64", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsAGraphWithMoreParticipantsThanTheStatedLimit()
    {
        // Refusing outright is deliberate. Silently keeping the first N participants would report a
        // smaller cycle than actually occurred, which reads as a less serious deadlock.
        var limits = new DeadlockParserLimits(MaximumProcesses: 1);
        Assert.Throws<XmlException>(() =>
            new SecureDeadlockGraphParser(limits).Parse("d", OccurredAt, RealRedactedGraph, includesSqlText: false));
    }

    [Fact]
    public void MalformedXmlThrowsRatherThanReturningAPartialGraph()
    {
        Assert.Throws<XmlException>(() =>
            new SecureDeadlockGraphParser().Parse("d", OccurredAt, "<deadlock><process-list>", includesSqlText: false));
    }

    [Fact]
    public void CarriesTheSuppliedIdentityAndTimestampWithoutSubstitutingItsOwn()
    {
        // The id is computed in SQL from the graph's redacted form so it does not change when
        // statement text is requested, and the timestamp is when the engine recorded the deadlock.
        // Deriving either here would date a historical event to when it was read.
        var graph = ParseReal();

        Assert.Equal("deadlock-1", graph.Id);
        Assert.Equal(OccurredAt, graph.OccurredAt);
    }
}
