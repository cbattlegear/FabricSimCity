# Security policy

## Foundation threat model

This repository currently serves deterministic fixtures. It has no SQL Server connector, credentials, login, user account, analytics, telemetry, or persistent application data. The intended future collector is read-only, but that intent is not yet a security control.

The application exposes operational-shaped evidence to every client that can reach it. **There is no authentication or authorization.** Run the default Compose configuration on loopback or another explicitly trusted network only. Do not publish port 8080 on all interfaces or place the service on the public internet.

Security headers enforce a same-origin baseline: no permissive CORS, no remote scripts, no `unsafe-eval`, and locked-down object, base, and frame-ancestor policies. SignalR uses same-origin `connect-src 'self'`. Health probes return only generic status and no target identity.

## Data and storage

The `/data` mount is reserved for a future storage seam and is unused in this fixture release. A standard Docker named volume is not application-level encryption and must not be described as production-safe for operational evidence or credentials.

Future collection must:

- use a least-privilege, read-only SQL Server principal and document every required permission;
- keep target secrets out of images, source, logs, URLs, and atlas responses;
- introduce authentication and authorization before non-loopback deployment;
- encrypt retained operational evidence and credentials with externally managed keys;
- fail closed when authentication, key retrieval, integrity validation, or encrypted storage is unavailable;
- distinguish permission denial, unsupported capability, disconnection, staleness, and unknown data rather than substituting zero;
- avoid logging query text or other potentially sensitive workload content by default.

Supported host targets are Linux containers on x86-64 and ARM64 using official .NET 10 images. Browser targets are current Chromium, Firefox, and Safari. Real SQL Server versions are not yet supported because this release performs no collection; future support claims require versioned fixtures and integration verification.

## Reporting

Report suspected vulnerabilities privately through the repository owner's GitHub security advisory channel. Do not include real credentials, query text, customer names, or production snapshots in a report. Include the affected version, reproduction steps using synthetic data, and expected impact.
