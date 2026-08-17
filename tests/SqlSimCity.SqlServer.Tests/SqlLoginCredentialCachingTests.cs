using System.Collections.Concurrent;
using System.Security;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

public class SqlLoginCredentialCachingTests
{
    [Fact]
    public async Task ConcurrentAndSequentialOpensReuseOneCredentialLease()
    {
        var leases = new TrackingLeaseFactory(blockFirstCreate: true);
        var opener = new RecordingOpener();
        using var factory = new SqlConnectionFactory(leases, opener, new TrackingPoolController(leases.Leases));
        var profile = SqlLoginProfile();

        var firstOpen = factory.OpenAsync(profile, CancellationToken.None);
        var secondOpen = factory.OpenAsync(profile, CancellationToken.None);
        Assert.Equal(1, leases.CreateCount);

        leases.CompleteFirstCreate();
        using var first = await firstOpen;
        using var second = await secondOpen;
        using var third = await factory.OpenAsync(profile, CancellationToken.None);

        Assert.Equal(1, leases.CreateCount);
        Assert.Equal(3, opener.Credentials.Count);
        Assert.All(opener.Credentials, credential => Assert.Same(leases.Leases.Single().Credential, credential));
        Assert.False(leases.Leases.Single().IsDisposed);
    }

    [Fact]
    public async Task DifferentSqlLoginProfileConfigurationUsesDifferentLease()
    {
        var leases = new TrackingLeaseFactory();
        var opener = new RecordingOpener();
        using var factory = new SqlConnectionFactory(leases, opener, new TrackingPoolController(leases.Leases));
        var firstProfile = SqlLoginProfile(id: "profile-one", username: "reader-one", secretFile: "password-one");
        var secondProfile = SqlLoginProfile(id: "profile-one", username: "reader-two", secretFile: "password-two");

        using var first = await factory.OpenAsync(firstProfile, CancellationToken.None);
        using var second = await factory.OpenAsync(secondProfile, CancellationToken.None);

        Assert.Equal(2, leases.CreateCount);
        Assert.NotSame(opener.Credentials.ElementAt(0), opener.Credentials.ElementAt(1));
    }

    [Fact]
    public async Task FailedCredentialLoadIsRemovedSoTheNextOpenCanRetry()
    {
        var leases = new TrackingLeaseFactory(failFirstCreate: true);
        var opener = new RecordingOpener();
        using var factory = new SqlConnectionFactory(leases, opener, new TrackingPoolController(leases.Leases));

        await Assert.ThrowsAsync<SecretResolutionException>(
            () => factory.OpenAsync(SqlLoginProfile(), CancellationToken.None));

        using var result = await factory.OpenAsync(SqlLoginProfile(), CancellationToken.None);
        Assert.Equal(2, leases.CreateCount);
        Assert.Single(opener.Credentials);
    }

    [Fact]
    public async Task InvalidationClearsPoolBeforeDisposingAnUnusedCredential()
    {
        var leases = new TrackingLeaseFactory();
        var pools = new TrackingPoolController(leases.Leases);
        using var factory = new SqlConnectionFactory(leases, new RecordingOpener(), pools);
        var profile = SqlLoginProfile();

        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        await factory.InvalidateSqlLoginProfileAsync(profile);

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.False(pools.PasswordWasDisposedWhenCleared.Single());
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task FactoryDisposalClearsPoolBeforeDisposingAnUnusedCredential()
    {
        var leases = new TrackingLeaseFactory();
        var pools = new TrackingPoolController(leases.Leases);
        var factory = new SqlConnectionFactory(leases, new RecordingOpener(), pools);

        using (await factory.OpenAsync(SqlLoginProfile(), CancellationToken.None))
        {
        }

        await factory.DisposeAsync();

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.False(pools.PasswordWasDisposedWhenCleared.Single());
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task InvalidationDefersPasswordDisposalUntilReturnedConnectionIsDisposed()
    {
        var leases = new TrackingLeaseFactory();
        var pools = new TrackingPoolController(leases.Leases);
        using var factory = new SqlConnectionFactory(leases, new RecordingOpener(), pools);
        var profile = SqlLoginProfile();

        var result = await factory.OpenAsync(profile, CancellationToken.None);
        await factory.InvalidateSqlLoginProfileAsync(profile);

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.False(lease.IsDisposed);
        result.Connection.Dispose();
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task OpenFailureDoesNotDisposeTheSharedCredential()
    {
        var leases = new TrackingLeaseFactory();
        var opener = new FailOnceOpener();
        using var factory = new SqlConnectionFactory(leases, opener, new TrackingPoolController(leases.Leases));
        var profile = SqlLoginProfile();

        await Assert.ThrowsAsync<InvalidOperationException>(() => factory.OpenAsync(profile, CancellationToken.None));
        using var result = await factory.OpenAsync(profile, CancellationToken.None);

        Assert.Equal(1, leases.CreateCount);
        Assert.False(leases.Leases.Single().IsDisposed);
    }

    [Fact]
    public async Task PoolClearFailureDuringInvalidationPropagatesAndKeepsPasswordValid()
    {
        var leases = new TrackingLeaseFactory();
        var pools = new FailingPoolController();
        using var factory = new SqlConnectionFactory(leases, new RecordingOpener(), pools);
        var profile = SqlLoginProfile();

        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        await Assert.ThrowsAsync<InvalidOperationException>(() => factory.InvalidateSqlLoginProfileAsync(profile));

        var lease = Assert.Single(leases.Leases);
        Assert.False(lease.IsDisposed);

        // The failure is not a permanent dead end: the same lease is still
        // cached and still reused by the next open, and a later retry of
        // invalidation retires it once the underlying failure clears.
        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        Assert.Equal(1, leases.CreateCount);
        pools.FailNextClear = false;
        await factory.InvalidateSqlLoginProfileAsync(profile);
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task FactoryDisposalSurfacesPoolClearFailureInsteadOfSwallowingIt()
    {
        var leases = new TrackingLeaseFactory();
        var pools = new FailingPoolController();
        var factory = new SqlConnectionFactory(leases, new RecordingOpener(), pools);

        using (await factory.OpenAsync(SqlLoginProfile(), CancellationToken.None))
        {
        }

        var ex = await Assert.ThrowsAsync<AggregateException>(() => factory.DisposeAsync().AsTask());

        Assert.Single(ex.InnerExceptions);
        var lease = Assert.Single(leases.Leases);
        Assert.False(lease.IsDisposed);
    }

    private static ConnectionProfile SqlLoginProfile(
        string id = "sql-login-profile",
        string username = "svc-reader",
        string secretFile = "sql-password") =>
        TestProfiles.Build(
            id: new ConnectionProfileId(id),
            authentication: new SqlLoginAuthenticationStrategy(username, new SecretFileReference(secretFile)));

    private sealed class TrackingLeaseFactory : ISqlLoginCredentialLeaseFactory
    {
        private readonly TaskCompletionSource<SqlLoginCredentialLease>? _firstCreate;
        private bool _failFirstCreate;

        public TrackingLeaseFactory(bool blockFirstCreate = false, bool failFirstCreate = false)
        {
            _failFirstCreate = failFirstCreate;
            if (blockFirstCreate)
            {
                _firstCreate = new TaskCompletionSource<SqlLoginCredentialLease>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }

        public int CreateCount { get; private set; }

        public List<SqlLoginCredentialLease> Leases { get; } = [];

        public Task<SqlLoginCredentialLease> CreateAsync(
            SqlLoginAuthenticationStrategy authentication,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CreateCount++;
            if (_failFirstCreate)
            {
                _failFirstCreate = false;
                return Task.FromException<SqlLoginCredentialLease>(
                    new SecretResolutionException("simulated secret failure"));
            }

            var lease = new SqlLoginCredentialLease(authentication.Username, Password());
            Leases.Add(lease);
            return _firstCreate is null
                ? Task.FromResult(lease)
                : _firstCreate.Task;
        }

        public void CompleteFirstCreate()
        {
            Assert.NotNull(_firstCreate);
            _firstCreate.SetResult(Leases.Single());
        }

        private static SecureString Password()
        {
            var password = new SecureString();
            password.AppendChar('p');
            password.MakeReadOnly();
            return password;
        }
    }

    private sealed class TrackingPoolController : ISqlConnectionPoolController
    {
        private readonly IReadOnlyList<SqlLoginCredentialLease> _leases;

        public TrackingPoolController(IReadOnlyList<SqlLoginCredentialLease> leases)
        {
            _leases = leases;
        }

        public int ClearCount { get; private set; }

        public List<bool> PasswordWasDisposedWhenCleared { get; } = [];

        public void ClearPool(SqlConnection connection)
        {
            ClearCount++;
            var credential = connection.Credential;
            var lease = _leases.Single(lease => ReferenceEquals(lease.Credential, credential));
            PasswordWasDisposedWhenCleared.Add(lease.IsDisposed);
        }
    }

    private sealed class FailingPoolController : ISqlConnectionPoolController
    {
        public bool FailNextClear { get; set; } = true;

        public void ClearPool(SqlConnection connection)
        {
            if (FailNextClear)
            {
                throw new InvalidOperationException("simulated pool clear failure");
            }
        }
    }

    private sealed class RecordingOpener : ISqlConnectionOpener
    {
        private readonly ConcurrentQueue<SqlCredential?> _credentials = [];

        public ConcurrentQueue<SqlCredential?> Credentials => _credentials;

        public Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _credentials.Enqueue(connection.Credential);
            return Task.CompletedTask;
        }
    }

    private sealed class FailOnceOpener : ISqlConnectionOpener
    {
        private bool _fail = true;

        public Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_fail)
            {
                _fail = false;
                throw new InvalidOperationException("simulated network failure");
            }

            return Task.CompletedTask;
        }
    }
}
