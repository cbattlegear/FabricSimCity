using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Negotiation;

/// <summary>
/// Verifies that every <see cref="ProbeExecutionException"/> subclass maps to the documented
/// <see cref="CapabilityState"/>, that the negotiator never broad-catches into a false success,
/// and that any exception type outside the classified hierarchy propagates unhandled -- the
/// documented error boundary from <c>ProbeExecutionException</c>'s own remarks.
/// </summary>
public class CapabilityNegotiatorErrorClassificationTests
{
    private static readonly DateTimeOffset FixedNow = new(2025, 1, 15, 12, 0, 0, TimeSpan.Zero);

    private static CapabilityNegotiator Build(FakeProbeExecutor executor) => new(executor, new FixedTimeProvider(FixedNow));

    [Fact]
    public async Task ServerIdentityPermissionDeniedClassifiesPlatformAsUnsupportedWithPermissionDeniedEvidence()
    {
        var executor = new FakeProbeExecutor
        {
            ServerIdentity = _ => throw new ProbePermissionDeniedException("denied", 229, 14),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "db"), CancellationToken.None);

        Assert.Equal(EnginePlatform.Unsupported, profile.Platform.Platform);
        Assert.Equal(CapabilityState.PermissionDenied, profile.Platform.Evidence.State);
        Assert.Equal(229, profile.Platform.Evidence.SqlErrorNumber);
    }

    [Fact]
    public async Task ServerPermissionCheckObjectUnavailableClassifiesWaitsAsUnsupportedNotSuccess()
    {
        var executor = new FakeProbeExecutor
        {
            ServerPermission = (_, _) => throw new ProbeObjectUnavailableException("no such object", 208, 16),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.NotEqual(CapabilityState.Supported, profile.Waits.State);
        Assert.Equal(CapabilityState.Unsupported, profile.Waits.Evidence.State);
    }

    [Fact]
    public async Task ServerPermissionCheckTransientConnectionFailureClassifiesAsUnavailableNotDenied()
    {
        var executor = new FakeProbeExecutor
        {
            ServerPermission = (_, _) => throw new ProbeTransientConnectionException("throttled", 40501, 20),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        // A transient failure is not the same fact as "permission denied"; conflating them would
        // tell an operator to grant a permission they may already have.
        Assert.NotEqual(CapabilityState.PermissionDenied, profile.Waits.State);
        Assert.Equal(CapabilityState.Unavailable, profile.Waits.Evidence.State);
    }

    [Fact]
    public async Task ServerPermissionCheckTimeoutClassifiesAsUnavailable()
    {
        var executor = new FakeProbeExecutor
        {
            ServerPermission = (_, _) => throw new ProbeTimeoutException("timed out", -2, 11),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Equal(CapabilityState.Unavailable, profile.Waits.Evidence.State);
    }

    [Fact]
    public async Task QueryStorePermissionDeniedReportsPermissionDeniedAvailabilityNotOff()
    {
        var executor = new FakeProbeExecutor
        {
            QueryStoreOptions = (_, _) => throw new ProbePermissionDeniedException("denied", 300, 14),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["fixture_db"];
        Assert.Equal(CapabilityState.PermissionDenied, qs.Availability);
        Assert.Equal(QueryStoreOperationalState.Unknown, qs.OperationalState);
    }

    [Fact]
    public async Task QueryStoreObjectUnavailableReportsUnsupportedAvailability()
    {
        var executor = new FakeProbeExecutor
        {
            QueryStoreOptions = (_, _) => throw new ProbeObjectUnavailableException("no catalog view", 208, 16),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        var qs = profile.QueryStoreByDatabase["fixture_db"];
        Assert.Equal(CapabilityState.Unsupported, qs.Availability);
    }

    [Fact]
    public async Task UnclassifiedExceptionTypePropagatesUnhandledIsNotSwallowedIntoSuccess()
    {
        var executor = new FakeProbeExecutor
        {
            ServerIdentity = _ => throw new InvalidOperationException("a programming bug, not a SQL error"),
        };
        var negotiator = Build(executor);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None));
    }

    [Fact]
    public async Task OperationCanceledPropagatesUnhandled()
    {
        using var cts = new CancellationTokenSource();
        var executor = new FakeProbeExecutor
        {
            ServerIdentity = _ => throw new OperationCanceledException(cts.Token),
        };
        var negotiator = Build(executor);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), cts.Token));
    }

    [Fact]
    public async Task SourceTimestampComesFromInjectedTimeProviderNotWallClock()
    {
        var negotiator = Build(new FakeProbeExecutor());

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Equal(FixedNow, profile.SourceTimestamp);
    }

    [Fact]
    public async Task MissingCapabilityNeverSurfacesAsFalseOrZeroItIsAnExplicitState()
    {
        var executor = new FakeProbeExecutor
        {
            ServerPermission = (_, _) => Task.FromResult<bool?>(null),
            DatabasePermission = (_, _, _) => Task.FromResult<bool?>(null),
        };
        var negotiator = Build(executor);

        var profile = await negotiator.NegotiateAsync(new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Equal(CapabilityState.NotProbed, profile.Waits.State);
        Assert.Equal(CapabilityState.NotProbed, profile.LiveSessions.State);
    }

    [Fact]
    public async Task DeniedLegacyPermissionWithUnknownModernPermissionIsDenied()
    {
        var executor = new FakeProbeExecutor
        {
            ServerPermission = (permission, _) => Task.FromResult<bool?>(
                permission == "VIEW SERVER STATE" ? false : null),
        };

        var profile = await Build(executor).NegotiateAsync(
            new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Equal(CapabilityState.PermissionDenied, profile.Waits.State);
        Assert.Equal(CapabilityState.PermissionDenied, profile.LiveSessions.State);
        Assert.Equal(CapabilityState.PermissionDenied, profile.PlansAndText.State);
    }

    [Theory]
    [MemberData(nameof(MetadataFailures))]
    public async Task MetadataFailureRemainsDistinctFromUnsupported(
        ProbeExecutionException failure,
        CapabilityState expected)
    {
        var executor = new FakeProbeExecutor
        {
            QueryStorePlanMetadata = (_, _) => throw failure,
        };

        var profile = await Build(executor).NegotiateAsync(
            new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Equal(expected, profile.ParameterSensitivePlan.State);
        Assert.Equal(expected, profile.ReadableSecondaryQueryStore.State);
        Assert.Equal(failure.SqlErrorNumber, profile.ParameterSensitivePlan.Evidence.SqlErrorNumber);
    }

    public static TheoryData<ProbeExecutionException, CapabilityState> MetadataFailures => new()
    {
        { new ProbePermissionDeniedException("denied", 229, 14), CapabilityState.PermissionDenied },
        { new ProbeTimeoutException("timeout", -2, 11), CapabilityState.Unavailable },
        { new ProbeAuthenticationException("authentication failed", 18456, 14), CapabilityState.Unavailable },
    };

    [Fact]
    public async Task DatabaseDiscoveryFailureIsVisibleWithClassifiedEvidence()
    {
        var executor = new FakeProbeExecutor
        {
            DatabaseDiscovery = _ => throw new ProbePermissionDeniedException("denied", 229, 14),
        };

        var profile = await Build(executor).NegotiateAsync(
            new CapabilityNegotiationRequest("t", "fixture_db"), CancellationToken.None);

        Assert.Empty(profile.Databases);
        Assert.Equal(CapabilityState.PermissionDenied, profile.DatabaseDiscovery.State);
        Assert.Equal(229, profile.DatabaseDiscovery.Evidence.SqlErrorNumber);
    }

    [Fact]
    public async Task AzureDatabaseIdsIncludeTargetScope()
    {
        var executor = new FakeProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(
                new ServerIdentityResult("azure", "current", null, "Azure SQL Database", 5, false, 4, 4, null, null)),
        };

        var profile = await Build(executor).NegotiateAsync(
            new CapabilityNegotiationRequest("target-a", "fixture_db"), CancellationToken.None);

        Assert.Equal("target-a/database/2", Assert.Single(profile.Databases).DatabaseId);
    }
}
