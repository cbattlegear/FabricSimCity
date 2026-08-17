using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public sealed record ShowplanParserLimits(
    int MaximumXmlCharacters = 8 * 1024 * 1024,
    int MaximumDepth = 128,
    int MaximumNodes = 20_000,
    int MaximumTextCharacters = 1_000_000);

public sealed class SecureShowplanParser
{
    private const string Caveat =
        "Compiled plan structure with aggregate query-level Query Store runtime only; Query Store does not provide actual operator progress or actual operator metrics.";
    private readonly ShowplanParserLimits _limits;

    public SecureShowplanParser(ShowplanParserLimits? limits = null) =>
        _limits = limits ?? new ShowplanParserLimits();

    public async Task<NormalizedShowplanV1> ParseAsync(
        string planId,
        string xml,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(planId);
        ArgumentNullException.ThrowIfNull(xml);
        if (xml.Length > _limits.MaximumXmlCharacters)
        {
            throw new XmlException($"Showplan exceeds the {_limits.MaximumXmlCharacters}-character limit.");
        }

        var settings = new XmlReaderSettings
        {
            Async = true,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = _limits.MaximumXmlCharacters,
            MaxCharactersFromEntities = 0,
            IgnoreComments = true,
            IgnoreProcessingInstructions = true,
        };

        using var textReader = new StringReader(xml);
        using var reader = XmlReader.Create(textReader, settings);
        var builders = new List<NodeBuilder>();
        var nodeStack = new Stack<NodeBuilder>();
        var elementStack = new Stack<string>();
        var text = new StringBuilder();
        string version = "unknown";
        string? ceVersion = null;
        decimal? desiredMemory = null;
        decimal? requiredMemory = null;
        var optimization = QueryOptimizationKind.None;
        string? dispatcherExpression = null;
        var elementCount = 0;

        while (await reader.ReadAsync())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (reader.Depth > _limits.MaximumDepth)
            {
                throw new XmlException($"Showplan exceeds the maximum depth of {_limits.MaximumDepth}.");
            }

            if (reader.NodeType == XmlNodeType.Element)
            {
                if (++elementCount > _limits.MaximumNodes)
                {
                    throw new XmlException($"Showplan exceeds the {_limits.MaximumNodes}-node limit.");
                }

                var local = reader.LocalName;
                elementStack.Push(local);
                if (local == "ShowPlanXML")
                {
                    version = Attribute(reader, "Version") ?? version;
                }
                else if (local == "StmtSimple")
                {
                    ceVersion = Attribute(reader, "CardinalityEstimationModelVersion") ?? ceVersion;
                }
                else if (local == "MemoryGrantInfo")
                {
                    desiredMemory = DecimalAttribute(reader, "SerialDesiredMemory");
                    requiredMemory = DecimalAttribute(reader, "SerialRequiredMemory");
                }
                else if (local == "RelOp")
                {
                    var builder = new NodeBuilder(
                        IntAttribute(reader, "NodeId") ?? throw new XmlException("RelOp is missing NodeId."),
                        nodeStack.TryPeek(out var parent) ? parent.NodeId : null,
                        Attribute(reader, "LogicalOp") ?? "Unknown",
                        Attribute(reader, "PhysicalOp") ?? "Unknown")
                    {
                        EstimatedRows = DecimalAttribute(reader, "EstimateRows"),
                        EstimatedCpuCost = DecimalAttribute(reader, "EstimateCPU"),
                        EstimatedIoCost = DecimalAttribute(reader, "EstimateIO"),
                        EstimatedTotalSubtreeCost = DecimalAttribute(reader, "EstimatedTotalSubtreeCost"),
                        Parallel = string.Equals(Attribute(reader, "Parallel"), "true", StringComparison.OrdinalIgnoreCase),
                    };
                    builders.Add(builder);
                    nodeStack.Push(builder);
                }
                else if (local == "Object" && nodeStack.TryPeek(out var objectNode))
                {
                    objectNode.ObjectReference = new ShowplanObjectV1(
                        Attribute(reader, "Database"), Attribute(reader, "Schema"),
                        Attribute(reader, "Table"), Attribute(reader, "Index"));
                }
                else if (local == "ScalarOperator" && nodeStack.TryPeek(out var scalarNode) &&
                         Attribute(reader, "ScalarString") is { } scalar)
                {
                    scalarNode.AddExpression(SanitizeExpression(scalar));
                }
                else if (local.Contains("Warning", StringComparison.OrdinalIgnoreCase) &&
                         nodeStack.TryPeek(out var warningNode))
                {
                    warningNode.Warnings.Add(new ShowplanWarningV1(local, Attribute(reader, "ColumnsWithNoStatistics")));
                }
                else if (local is "ParameterSensitivePredicate" or "DispatcherExpression")
                {
                    optimization = QueryOptimizationKind.ParameterSensitivePlan;
                    dispatcherExpression = CanonicalAttributes(reader);
                }
                else if (local.Contains("OptionalParameter", StringComparison.OrdinalIgnoreCase))
                {
                    optimization = QueryOptimizationKind.OptionalParameterPlanOptimization;
                }

                if (reader.IsEmptyElement)
                {
                    elementStack.Pop();
                    if (local == "RelOp") nodeStack.Pop();
                }
            }
            else if (reader.NodeType is XmlNodeType.Text or XmlNodeType.CDATA)
            {
                if (text.Length + reader.Value.Length > _limits.MaximumTextCharacters)
                {
                    throw new XmlException($"Showplan text exceeds the {_limits.MaximumTextCharacters}-character limit.");
                }
                text.Append(reader.Value);
                if (elementStack.TryPeek(out var current) && current is "ScalarString" or "Predicate")
                {
                    if (nodeStack.TryPeek(out var predicateNode)) predicateNode.AddExpression(SanitizeExpression(reader.Value));
                }
                if (elementStack.TryPeek(out current) && current is "DispatcherExpression")
                {
                    dispatcherExpression = SanitizeExpression(reader.Value);
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (reader.LocalName == "RelOp" && nodeStack.Count > 0) nodeStack.Pop();
                if (elementStack.Count > 0) elementStack.Pop();
            }
        }

        var nodes = builders.Select(builder => builder.Build()).OrderBy(node => node.NodeId).ToArray();
        var fingerprint = StructuralPlanFingerprint.Compute(nodes, optimization, dispatcherExpression);
        return new NormalizedShowplanV1(
            "1.0", planId, version, ceVersion, desiredMemory, requiredMemory, nodes,
            optimization, dispatcherExpression, fingerprint, Caveat,
            new QueryStoreEvidenceV1(QueryStoreSource.QueryStore, DataStatus.Available, null, null,
                "Normalized from a single on-demand Query Store Showplan document.", Caveat));
    }

    private static string? Attribute(XmlReader reader, string name) => reader.GetAttribute(name);
    private static int? IntAttribute(XmlReader reader, string name) =>
        int.TryParse(Attribute(reader, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;
    private static decimal? DecimalAttribute(XmlReader reader, string name) =>
        decimal.TryParse(Attribute(reader, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;
    private static string SanitizeExpression(string value)
    {
        var sanitized = Regex.Replace(value, @"N?'(?:''|[^'])*'", "?", RegexOptions.CultureInvariant);
        sanitized = Regex.Replace(sanitized, @"\b0x[0-9A-Fa-f]+\b", "?", RegexOptions.CultureInvariant);
        return Regex.Replace(
            sanitized,
            @"(?<![\w@])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?",
            "?",
            RegexOptions.CultureInvariant);
    }
    private static string? CanonicalAttributes(XmlReader reader)
    {
        if (!reader.HasAttributes) return null;
        var attributes = new List<string>();
        while (reader.MoveToNextAttribute())
            attributes.Add($"{reader.LocalName}={SanitizeExpression(reader.Value)}");
        reader.MoveToElement();
        attributes.Sort(StringComparer.Ordinal);
        return string.Join(';', attributes);
    }

    private sealed class NodeBuilder(int nodeId, int? parentNodeId, string logicalOperation, string physicalOperation)
    {
        public int NodeId { get; } = nodeId;
        public int? ParentNodeId { get; } = parentNodeId;
        public string LogicalOperation { get; } = logicalOperation;
        public string PhysicalOperation { get; } = physicalOperation;
        public decimal? EstimatedRows { get; init; }
        public decimal? EstimatedCpuCost { get; init; }
        public decimal? EstimatedIoCost { get; init; }
        public decimal? EstimatedTotalSubtreeCost { get; init; }
        public bool Parallel { get; init; }
        public ShowplanObjectV1? ObjectReference { get; set; }
        private List<string> Expressions { get; } = [];
        public List<ShowplanWarningV1> Warnings { get; } = [];

        public void AddExpression(string expression) => Expressions.Add(expression);

        public ShowplanNodeV1 Build() => new(
            NodeId, ParentNodeId, LogicalOperation, PhysicalOperation, EstimatedRows,
            EstimatedCpuCost, EstimatedIoCost, EstimatedTotalSubtreeCost, Parallel,
            ObjectReference,
            Expressions.Count == 0 ? null : string.Join(" && ", Expressions.Order(StringComparer.Ordinal)),
            Warnings);
    }
}

public static class StructuralPlanFingerprint
{
    public static string Compute(
        IEnumerable<ShowplanNodeV1> nodes,
        QueryOptimizationKind optimization,
        string? dispatcherExpression)
    {
        var canonical = new StringBuilder().Append(optimization).Append('|').Append(dispatcherExpression).AppendLine();
        foreach (var node in nodes.OrderBy(node => node.NodeId))
        {
            canonical.Append(node.NodeId).Append('>').Append(node.ParentNodeId).Append('|')
                .Append(node.LogicalOperation).Append('|').Append(node.PhysicalOperation).Append('|')
                .Append(node.Parallel).Append('|').Append(node.ObjectReference?.Database).Append('|')
                .Append(node.ObjectReference?.Schema).Append('|').Append(node.ObjectReference?.Table).Append('|')
                .Append(node.ObjectReference?.Index).Append('|').Append(node.Predicate).Append('|')
                .Append(node.EstimatedRows).Append('|').Append(node.EstimatedCpuCost).Append('|')
                .Append(node.EstimatedIoCost).Append('|').Append(node.EstimatedTotalSubtreeCost).AppendLine();
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()))).ToLowerInvariant();
    }
}
