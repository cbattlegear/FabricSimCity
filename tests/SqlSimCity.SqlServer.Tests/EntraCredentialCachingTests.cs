using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

/// <summary>
/// Mirrors <see cref="SqlLoginCredentialCachingTests"/> for the Entra
/// credential/callback cache: every case here has an equivalent SQL-login
/// case because both lease kinds share <see cref="SqlConnectionFactory"/>'s
/// generic renting, retirement, and shutdown-reporting code paths.
/// </summary>
public class EntraCredentialCachingTests
{
    [Fact]
    public async Task ConcurrentAndSequentialOpensReuseOneCallbackDelegate()
    {
        var leases = new TrackingEntraLeaseFactory(blockFirstCreate: true);
        var opener = new RecordingCallbackOpener();
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), opener, new TrackingEntraPoolController(leases.Leases), entraLeaseFactory: leases);
        var profile = ManagedIdentityProfile();

        var firstOpen = factory.OpenAsync(profile, CancellationToken.None);
        var secondOpen = factory.OpenAsync(profile, CancellationToken.None);
        Assert.Equal(1, leases.CreateCount);

        leases.CompleteFirstCreate();
        using var first = await firstOpen;
        using var second = await secondOpen;
        using var third = await factory.OpenAsync(profile, CancellationToken.None);

        Assert.Equal(1, leases.CreateCount);
        Assert.Equal(3, opener.Callbacks.Count);
        Assert.All(opener.Callbacks, callback => Assert.Same(leases.Leases.Single().Callback, callback));
        Assert.False(leases.Leases.Single().IsDisposed);
    }

    [Fact]
    public async Task DifferentTenantOrClientUsesADifferentLeaseAndCallback()
    {
        var leases = new TrackingEntraLeaseFactory();
        var opener = new RecordingCallbackOpener();
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), opener, new TrackingEntraPoolController(leases.Leases), entraLeaseFactory: leases);
        var firstProfile = ServicePrincipalSecretProfile(secretFile: "secret-one");
        var secondProfile = ServicePrincipalSecretProfile(secretFile: "secret-two");

        using var first = await factory.OpenAsync(firstProfile, CancellationToken.None);
        using var second = await factory.OpenAsync(secondProfile, CancellationToken.None);

        Assert.Equal(2, leases.CreateCount);
        Assert.NotSame(opener.Callbacks.ElementAt(0), opener.Callbacks.ElementAt(1));
    }

    [Fact]
    public async Task FailedCredentialCreationIsNotCachedSoTheNextOpenCanRetry()
    {
        var leases = new TrackingEntraLeaseFactory(failFirstCreate: true);
        var opener = new RecordingCallbackOpener();
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), opener, new TrackingEntraPoolController(leases.Leases), entraLeaseFactory: leases);
        var profile = ManagedIdentityProfile();

        await Assert.ThrowsAsync<SecretResolutionException>(() => factory.OpenAsync(profile, CancellationToken.None));

        using var result = await factory.OpenAsync(profile, CancellationToken.None);
        Assert.Equal(2, leases.CreateCount);
        Assert.Single(opener.Callbacks);
    }

    [Fact]
    public async Task InvalidationClearsPoolBeforeDisposingAnUnusedCertificate()
    {
        var leases = new TrackingEntraLeaseFactory(withCertificate: true);
        var pools = new TrackingEntraPoolController(leases.Leases);
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, entraLeaseFactory: leases);
        var profile = ServicePrincipalCertificateProfile();

        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        await factory.InvalidateEntraProfileAsync(profile);

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.False(pools.CertificateWasDisposedWhenCleared.Single());
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task FactoryDisposalClearsPoolBeforeDisposingAnUnusedCertificate()
    {
        var leases = new TrackingEntraLeaseFactory(withCertificate: true);
        var pools = new TrackingEntraPoolController(leases.Leases);
        var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, entraLeaseFactory: leases);

        using (await factory.OpenAsync(ServicePrincipalCertificateProfile(), CancellationToken.None))
        {
        }

        await factory.DisposeAsync();

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task InvalidationDefersCertificateDisposalUntilReturnedConnectionIsDisposed()
    {
        var leases = new TrackingEntraLeaseFactory(withCertificate: true);
        var pools = new TrackingEntraPoolController(leases.Leases);
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, entraLeaseFactory: leases);
        var profile = ServicePrincipalCertificateProfile();

        var result = await factory.OpenAsync(profile, CancellationToken.None);
        await factory.InvalidateEntraProfileAsync(profile);

        var lease = Assert.Single(leases.Leases);
        Assert.Equal(1, pools.ClearCount);
        Assert.False(lease.IsDisposed);
        result.Connection.Dispose();
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task OpenFailureDoesNotDisposeTheSharedCredential()
    {
        var leases = new TrackingEntraLeaseFactory();
        var opener = new FailOnceCallbackOpener();
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), opener, new TrackingEntraPoolController(leases.Leases), entraLeaseFactory: leases);
        var profile = ManagedIdentityProfile();

        await Assert.ThrowsAsync<InvalidOperationException>(() => factory.OpenAsync(profile, CancellationToken.None));
        using var result = await factory.OpenAsync(profile, CancellationToken.None);

        Assert.Equal(1, leases.CreateCount);
        Assert.False(leases.Leases.Single().IsDisposed);
    }

    [Fact]
    public async Task PoolClearFailureDuringInvalidationPropagatesAndKeepsCertificateValid()
    {
        var leases = new TrackingEntraLeaseFactory(withCertificate: true);
        var pools = new FailingPoolController();
        using var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, entraLeaseFactory: leases);
        var profile = ServicePrincipalCertificateProfile();

        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        await Assert.ThrowsAsync<InvalidOperationException>(() => factory.InvalidateEntraProfileAsync(profile));

        var lease = Assert.Single(leases.Leases);
        Assert.False(lease.IsDisposed);

        // The failure is not a permanent dead end: once the pool controller
        // stops failing, the same lease still retires successfully instead
        // of being stuck "half retired" from the earlier failed attempt.
        pools.FailNextClear = false;
        await factory.InvalidateEntraProfileAsync(profile);
        Assert.True(lease.IsDisposed);
    }

    [Fact]
    public async Task FactoryDisposalSurfacesPoolClearFailureInsteadOfSwallowingIt()
    {
        var leases = new TrackingEntraLeaseFactory();
        var pools = new FailingPoolController();
        var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, entraLeaseFactory: leases);

        using (await factory.OpenAsync(ManagedIdentityProfile(), CancellationToken.None))
        {
        }

        var ex = await Assert.ThrowsAsync<AggregateException>(() => factory.DisposeAsync().AsTask());

        Assert.Single(ex.InnerExceptions);
        var lease = Assert.Single(leases.Leases);
        Assert.False(lease.IsDisposed);
    }

    [Fact]
    public async Task PoolClearFailureNeverLeaksTheClientSecretInTheExceptionMessage()
    {
        var secrets = new InMemorySecretFileProvider().With("client-secret", "super-secret-value");
        var pools = new FailingPoolController();
        var factory = new SqlConnectionFactory(
            new UnusedSqlLoginCredentialLeaseFactory(), new RecordingCallbackOpener(), pools, secrets);
        var profile = ServicePrincipalSecretProfile(secretFile: "client-secret");

        using (await factory.OpenAsync(profile, CancellationToken.None))
        {
        }

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => factory.InvalidateEntraProfileAsync(profile));

        Assert.DoesNotContain("super-secret-value", ex.Message, StringComparison.Ordinal);

        // Let the pool controller succeed so this factory's own shutdown --
        // performed unconditionally by every other test via `using` -- does
        // not itself throw and mask the assertion above.
        pools.FailNextClear = false;
        await factory.DisposeAsync();
    }

    [Fact]
    public async Task CallbackDerivesScopeFromResourceAndAppendsDefaultOnlyWhenMissing()
    {
        var scopes = new List<string>();
        var lease = new EntraCredentialLease(new RecordingTokenCredential(scopes), ownedCertificate: null);

        var withoutSuffix = new SqlAuthenticationParameters(
            SqlAuthenticationMethod.ActiveDirectoryManagedIdentity,
            serverName: "sql01.internal.example.com",
            databaseName: "sqlsimcity",
            resource: "https://database.usgovcloudapi.net",
            authority: "https://login.microsoftonline.us/common",
            userId: null!,
            password: null!,
            connectionId: Guid.NewGuid(),
            connectionTimeout: 15);
        await lease.Callback(withoutSuffix, CancellationToken.None);

        var withSuffix = new SqlAuthenticationParameters(
            SqlAuthenticationMethod.ActiveDirectoryManagedIdentity,
            serverName: "sql01.internal.example.com",
            databaseName: "sqlsimcity",
            resource: "https://database.usgovcloudapi.net/.default",
            authority: "https://login.microsoftonline.us/common",
            userId: null!,
            password: null!,
            connectionId: Guid.NewGuid(),
            connectionTimeout: 15);
        await lease.Callback(withSuffix, CancellationToken.None);

        Assert.Equal(
            ["https://database.usgovcloudapi.net/.default", "https://database.usgovcloudapi.net/.default"],
            scopes);
    }

    private static ConnectionProfile ManagedIdentityProfile(string id = "entra-profile") =>
        TestProfiles.Build(
            id: new ConnectionProfileId(id),
            authentication: new ManagedIdentityAuthenticationStrategy());

    private static ConnectionProfile ServicePrincipalSecretProfile(
        string id = "entra-profile",
        string secretFile = "client-secret") =>
        TestProfiles.Build(
            id: new ConnectionProfileId(id),
            authentication: new ServicePrincipalSecretAuthenticationStrategy(
                Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SecretFileReference(secretFile)));

    private static ConnectionProfile ServicePrincipalCertificateProfile(string id = "entra-profile") =>
        TestProfiles.Build(
            id: new ConnectionProfileId(id),
            authentication: new ServicePrincipalCertificateAuthenticationStrategy(
                Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SecretFileReference("client.pfx")));

    private static X509Certificate2 CreateSelfSignedCertificate()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=sqlsimcity-test-client", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddMinutes(5));
    }

    private sealed class UnusedSqlLoginCredentialLeaseFactory : ISqlLoginCredentialLeaseFactory
    {
        public Task<SqlLoginCredentialLease> CreateAsync(
            SqlLoginAuthenticationStrategy authentication,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException("SQL-login lease factory must not be used by Entra-only tests.");
    }

    private sealed class TrackingEntraLeaseFactory : IEntraCredentialLeaseFactory
    {
        private readonly TaskCompletionSource<EntraCredentialLease>? _firstCreate;
        private readonly bool _withCertificate;
        private bool _failFirstCreate;

        public TrackingEntraLeaseFactory(bool blockFirstCreate = false, bool failFirstCreate = false, bool withCertificate = false)
        {
            _failFirstCreate = failFirstCreate;
            _withCertificate = withCertificate;
            if (blockFirstCreate)
            {
                _firstCreate = new TaskCompletionSource<EntraCredentialLease>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }

        public int CreateCount { get; private set; }

        public List<EntraCredentialLease> Leases { get; } = [];

        public Task<EntraCredentialLease> CreateAsync(
            EntraAuthenticationStrategy authentication,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CreateCount++;
            if (_failFirstCreate)
            {
                _failFirstCreate = false;
                return Task.FromException<EntraCredentialLease>(
                    new SecretResolutionException("simulated secret failure"));
            }

            var certificate = _withCertificate ? CreateSelfSignedCertificate() : null;
            var lease = new EntraCredentialLease(new RecordingTokenCredential([]), certificate);
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
    }

    private sealed class TrackingEntraPoolController : ISqlConnectionPoolController
    {
        private readonly IReadOnlyList<EntraCredentialLease> _leases;

        public TrackingEntraPoolController(IReadOnlyList<EntraCredentialLease> leases)
        {
            _leases = leases;
        }

        public int ClearCount { get; private set; }

        public List<bool> CertificateWasDisposedWhenCleared { get; } = [];

        public void ClearPool(SqlConnection connection)
        {
            ClearCount++;
            var callback = connection.AccessTokenCallback;
            var lease = _leases.Single(lease => ReferenceEquals(lease.Callback, callback));
            CertificateWasDisposedWhenCleared.Add(lease.IsDisposed);
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

    private sealed class RecordingCallbackOpener : ISqlConnectionOpener
    {
        private readonly ConcurrentQueue<Func<SqlAuthenticationParameters, CancellationToken, Task<SqlAuthenticationToken>>?> _callbacks = [];

        public ConcurrentQueue<Func<SqlAuthenticationParameters, CancellationToken, Task<SqlAuthenticationToken>>?> Callbacks => _callbacks;

        public Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _callbacks.Enqueue(connection.AccessTokenCallback);
            return Task.CompletedTask;
        }
    }

    private sealed class FailOnceCallbackOpener : ISqlConnectionOpener
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

    private sealed class RecordingTokenCredential : TokenCredential
    {
        private readonly List<string> _scopes;

        public RecordingTokenCredential(List<string> scopes)
        {
            _scopes = scopes;
        }

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            _scopes.Add(requestContext.Scopes.Single());
            return new AccessToken("fake-token", DateTimeOffset.UtcNow.AddMinutes(5));
        }

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            _scopes.Add(requestContext.Scopes.Single());
            return new ValueTask<AccessToken>(new AccessToken("fake-token", DateTimeOffset.UtcNow.AddMinutes(5)));
        }
    }
}
