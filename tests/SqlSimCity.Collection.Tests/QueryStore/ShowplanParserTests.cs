using SqlSimCity.Collection.QueryStore;

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
}
