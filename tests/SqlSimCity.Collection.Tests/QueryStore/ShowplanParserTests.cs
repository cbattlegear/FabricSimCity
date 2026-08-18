using SqlSimCity.Collection.QueryStore;
using System.Xml;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class ShowplanParserTests
{
    [Fact]
    public async Task ParsesNamespacedPlanAndFingerprintIgnoresAttributeOrder()
    {
        const string first = """
            <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6">
              <BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
                <RelOp NodeId="0" LogicalOp="Select" PhysicalOp="Compute Scalar" Parallel="false">
                  <RelOp NodeId="1" LogicalOp="Clustered Index Scan" PhysicalOp="Clustered Index Scan">
                    <IndexScan><Object Database="[db]" Schema="[dbo]" Table="[T]" Index="[PK_T]" /></IndexScan>
                  </RelOp>
                </RelOp>
              </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
            </ShowPlanXML>
            """;
        const string second = """
            <ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
              <BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
                <RelOp PhysicalOp="Compute Scalar" Parallel="false" LogicalOp="Select" NodeId="0">
                  <RelOp PhysicalOp="Clustered Index Scan" NodeId="1" LogicalOp="Clustered Index Scan">
                    <IndexScan><Object Index="[PK_T]" Table="[T]" Schema="[dbo]" Database="[db]" /></IndexScan>
                  </RelOp>
                </RelOp>
              </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
            </ShowPlanXML>
            """;

        var parser = new SecureShowplanParser();
        var left = await parser.ParseAsync("1", first);
        var right = await parser.ParseAsync("2", second);

        Assert.Equal(left.StructuralFingerprint, right.StructuralFingerprint);
        Assert.Equal(2, left.Nodes.Count);
        Assert.Equal(0, left.Nodes.Single(n => n.NodeId == 1).ParentNodeId);
    }

    [Fact]
    public async Task RejectsDtd()
    {
        var parser = new SecureShowplanParser();
        await Assert.ThrowsAsync<System.Xml.XmlException>(() =>
            parser.ParseAsync("1", "<!DOCTYPE x [<!ENTITY y 'boom'>]><ShowPlanXML>&y;</ShowPlanXML>"));
    }

    [Fact]
    public async Task RedactsHexAndRetainsAllScalarExpressions()
    {
        const string xml = """
            <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
              <BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
                <RelOp NodeId="0" LogicalOp="Compute Scalar" PhysicalOp="Compute Scalar">
                  <ComputeScalar><DefinedValues>
                    <DefinedValue><ScalarOperator ScalarString="[a]+0xDEADBEEF" /></DefinedValue>
                    <DefinedValue><ScalarOperator ScalarString="[b]+1" /></DefinedValue>
                  </DefinedValues></ComputeScalar>
                </RelOp>
              </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
            </ShowPlanXML>
            """;

        var result = await new SecureShowplanParser().ParseAsync("1", xml);
        var predicate = Assert.Single(result.Nodes).Predicate;

        Assert.DoesNotContain("DEADBEEF", predicate, StringComparison.Ordinal);
        Assert.Contains("[a]+?", predicate, StringComparison.Ordinal);
        Assert.Contains("[b]+?", predicate, StringComparison.Ordinal);
    }

    [Fact]
    public async Task FingerprintAndComparisonIgnoreNodeIdRenumbering()
    {
        var parser = new SecureShowplanParser();
        var left = await parser.ParseAsync("left", Plan("0", "1", "Index Scan"));
        var right = await parser.ParseAsync("right", Plan("91", "37", "Index Scan"));

        var comparison = PlanComparer.Compare(left, right);

        Assert.Equal(left.StructuralFingerprint, right.StructuralFingerprint);
        Assert.True(comparison.StructurallyEqual);
        Assert.Empty(comparison.Changes);
    }

    [Fact]
    public async Task RejectsDuplicateIdsMalformedXmlAndConfiguredLimits()
    {
        var duplicate = """
            <ShowPlanXML><RelOp NodeId="0" LogicalOp="A" PhysicalOp="A">
              <RelOp NodeId="0" LogicalOp="B" PhysicalOp="B" />
            </RelOp></ShowPlanXML>
            """;
        await Assert.ThrowsAsync<XmlException>(() =>
            new SecureShowplanParser().ParseAsync("duplicate", duplicate));
        await Assert.ThrowsAsync<XmlException>(() =>
            new SecureShowplanParser().ParseAsync("malformed", "<ShowPlanXML><RelOp"));
        await Assert.ThrowsAsync<XmlException>(() =>
            new SecureShowplanParser(new ShowplanParserLimits(MaximumXmlCharacters: 20))
                .ParseAsync("large", Plan("0", "1", "Scan")));
        await Assert.ThrowsAsync<XmlException>(() =>
            new SecureShowplanParser(new ShowplanParserLimits(MaximumDepth: 2))
                .ParseAsync("deep", Plan("0", "1", "Scan")));
    }

    [Fact]
    public async Task CapturesMaterialWarningAndDiffsPropertyChanges()
    {
        const string leftXml = """
            <ShowPlanXML><BatchSequence><RelOp NodeId="0" LogicalOp="Scan" PhysicalOp="Index Scan"
              EstimateRows="10"><Warnings><SpillToTempDb SpillLevel="2" /></Warnings></RelOp></BatchSequence></ShowPlanXML>
            """;
        const string rightXml = """
            <ShowPlanXML><BatchSequence><RelOp NodeId="8" LogicalOp="Scan" PhysicalOp="Table Scan"
              EstimateRows="20" /></BatchSequence></ShowPlanXML>
            """;
        var parser = new SecureShowplanParser();
        var left = await parser.ParseAsync("left", leftXml);
        var right = await parser.ParseAsync("right", rightXml);

        var warning = Assert.Single(Assert.Single(left.Nodes).Warnings);
        Assert.Equal("SpillToTempDb", warning.Kind);
        Assert.Equal("SpillLevel=2", warning.Detail);
        var comparison = PlanComparer.Compare(left, right);
        Assert.Contains(comparison.Changes, change => change.Path == "root/physical");
        Assert.Contains(comparison.Changes, change => change.Path == "root/warnings");
    }

    [Fact]
    public async Task SiblingNodeIdsDoNotMatterButParsedChildOrderDoes()
    {
        const string first = """
            <ShowPlanXML><RelOp NodeId="0" LogicalOp="Join" PhysicalOp="Nested Loops">
              <RelOp NodeId="1" LogicalOp="Scan A" PhysicalOp="Index Scan" />
              <RelOp NodeId="2" LogicalOp="Scan B" PhysicalOp="Table Scan" />
            </RelOp></ShowPlanXML>
            """;
        const string renumbered = """
            <ShowPlanXML><RelOp NodeId="90" LogicalOp="Join" PhysicalOp="Nested Loops">
              <RelOp NodeId="44" LogicalOp="Scan A" PhysicalOp="Index Scan" />
              <RelOp NodeId="7" LogicalOp="Scan B" PhysicalOp="Table Scan" />
            </RelOp></ShowPlanXML>
            """;
        const string reversed = """
            <ShowPlanXML><RelOp NodeId="90" LogicalOp="Join" PhysicalOp="Nested Loops">
              <RelOp NodeId="7" LogicalOp="Scan B" PhysicalOp="Table Scan" />
              <RelOp NodeId="44" LogicalOp="Scan A" PhysicalOp="Index Scan" />
            </RelOp></ShowPlanXML>
            """;
        var parser = new SecureShowplanParser();
        var a = await parser.ParseAsync("a", first);
        var b = await parser.ParseAsync("b", renumbered);
        var c = await parser.ParseAsync("c", reversed);

        Assert.Equal(a.StructuralFingerprint, b.StructuralFingerprint);
        Assert.NotEqual(a.StructuralFingerprint, c.StructuralFingerprint);
    }

    private static string Plan(string rootId, string childId, string physical) => $"""
        <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
          <BatchSequence><Batch><Statements><StmtSimple CardinalityEstimationModelVersion="160"><QueryPlan>
            <RelOp NodeId="{rootId}" LogicalOp="Select" PhysicalOp="Compute Scalar">
              <RelOp NodeId="{childId}" LogicalOp="Scan" PhysicalOp="{physical}">
                <IndexScan><Object Schema="[dbo]" Table="[T]" /></IndexScan>
              </RelOp>
            </RelOp>
          </QueryPlan></StmtSimple></Statements></Batch></BatchSequence>
        </ShowPlanXML>
        """;
}
