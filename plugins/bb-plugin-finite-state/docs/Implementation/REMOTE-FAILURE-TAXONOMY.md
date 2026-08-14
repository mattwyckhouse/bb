# Remote failure taxonomy

`lib/remote/errors.ts` is the exported diagnostic vocabulary for Platform and
Assurance Studio failures. Callers should preserve its `RemoteError` message
instead of replacing every failure with an unreachable-service message.

Connection failures are classified as:

- `network-unreachable`: DNS, connection-refused, proxy, or other transport
  failure. Safe reads retain the bounded transport retry policy.
- `authentication`: HTTP 401 or 403. These failures are definitive,
  non-retryable, and name the remote, credential header, and setting to refresh.
- `settings`: a required remote is missing or its URL is syntactically
  malformed. Remote-specific base-path convention validation belongs to the
  settings diagnostics surface.
- `timeout`: the request exceeded its explicit budget. The message and details
  include elapsed milliseconds and the request phase. Platform uses 30 seconds;
  Assurance Studio uses 45 seconds to accommodate observed cold starts around
  21 seconds.

Other HTTP rejections use the `http` kind. Every rejected-response diagnostic
includes the request method, credential-free full URL, and HTTP status. This is
important because the remotes have opposite base-URL conventions: Platform
routes omit `/api`, while Assurance Studio routes include `/api`. The HTTP
diagnostic makes a duplicated `/api/api/` path visible without trying to enforce
that settings policy in the transport layer.

The exported entry points are `REMOTE_FAILURE_KINDS`,
`REMOTE_REQUEST_TIMEOUT_MS`, `RemoteFailureKind`, `RemoteFailureDiagnostic`,
and `diagnoseRemoteFailure`.
