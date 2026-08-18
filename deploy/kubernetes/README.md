# Atlas Cloud OpenAI Plugin deployment

The staging base deploys the remote MCP resource server, OAuth 2.1 authorization server, a dedicated persistent Redis instance, and two HTTPS hosts in the existing `mcp-servers` namespace.

The manifest intentionally does not contain a Kubernetes Secret. Create `mcp-servers/atlascloud-openai-plugin` out of band with these keys before applying it:

- `redis-password`
- `redis-url`
- `openai-challenge-token`
- `oidc-jwks-json`
- `oidc-cookie-keys-json`
- `oidc-users-json`
- `mcp-atlas-subject-keys-json`

`oidc-users-json` stores only scrypt password hashes. Reviewer plaintext credentials must remain in an approved password manager. `mcp-atlas-subject-keys-json` maps the same OAuth subject to a dedicated Atlas Cloud API key.

### Staging reviewer credential and OAuth lifetime

The dedicated staging reviewer identity is
`openai-plugin-reviewer@atlascloud.ai`. Its plaintext password is not stored in
this repository or in Kubernetes. On the designated reviewer Mac it is stored
as a generic password in macOS Keychain with:

```text
service: atlascloud-openai-plugin-staging
account: openai-plugin-reviewer@atlascloud.ai
```

An authorized operator can retrieve it locally when an interactive OAuth login
is required:

```bash
security find-generic-password \
  -s atlascloud-openai-plugin-staging \
  -a openai-plugin-reviewer@atlascloud.ai \
  -w
```

Do not paste the result into chat, tickets, shell history, logs, or repository
files. Password rotation must update both the Keychain entry and only the
`oidc-users-json` key in the `mcp-servers/atlascloud-openai-plugin` Secret, then
roll out `deployment/atlascloud-openai-auth`. MCP and Redis do not need a
restart for a reviewer password-only rotation.

Staging uses the longest OAuth lifetimes accepted by the current auth config:

| Credential | Lifetime | Behavior |
|---|---:|---|
| Access token | 3,600 seconds (1 hour) | Short-lived bearer token |
| Refresh token | 604,800 seconds (7 days) | Rotated on refresh; the consumed token allows at most 2 retries inside a fixed 30-second window, then strict replay detection resumes |
| Authorization grant | 31,536,000 seconds (1 year) | Upper bound for an actively refreshed connection; must not be shorter than the refresh-token lifetime |
| Dynamic public client (ChatGPT or Codex) | 31,536,000 seconds (1 year) | Re-registration is normally unnecessary during this period |

The reviewer password itself has no automatic expiry. A connection unused for
about seven continuous days can require OAuth reconnection even though the
password is still valid. Active refreshes renew the refresh-token window, while
the authorization grant provides a separate one-year upper bound.

The retry window is controlled by
`AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS=30` and
`AUTH_REFRESH_TOKEN_REUSE_MAX_ATTEMPTS=2`. Both values must be zero to disable
the compatibility window or both must be positive. Redis records the first
consumption timestamp atomically, so repeated requests cannot extend the
window. Never increase the grace above the validated 30 seconds merely to hide
client errors; investigate the structured `oidc_grant_error` log category
instead.

The staging manifest explicitly uses `PLUGIN_RELEASE_TIER=staging`,
`AUTH_IDENTITY_MODE=local-reviewer`, and `MCP_CREDENTIAL_MODE=subject-map`.
Those settings are suitable for the dedicated reviewer E2E only and are rejected
by the public-production configuration gate.

Apply and wait:

```bash
kubectl apply --server-side --dry-run=server -k deploy/kubernetes
kubectl apply -k deploy/kubernetes
kubectl -n mcp-servers rollout status statefulset/atlascloud-plugin-redis
kubectl -n mcp-servers rollout status deployment/atlascloud-openai-auth
kubectl -n mcp-servers rollout status deployment/atlascloud-openai-mcp
```

Public staging endpoints:

- `https://atlascloud-mcp.dev.atlascloud.ai/mcp`
- `https://atlascloud-auth.dev.atlascloud.ai/.well-known/openid-configuration`

### ChatGPT and Codex DCR callback policy

Dynamic registration deliberately supports only two exact public-client
profiles:

- `application_type=web`: an HTTPS callback matching
  `https://chatgpt.com/connector/oauth/{callback_id}`;
- `application_type=native`: a Codex loopback callback matching
  `http://127.0.0.1:{dynamic_port}/callback/{12_character_callback_id}`.

Do not broaden the native allowlist to arbitrary `localhost`, IPv6, LAN
addresses, paths, query strings, fragments, or URL credentials. ChatGPT and
Codex callback types cannot be mixed in one registration. Both flows remain
public clients with `token_endpoint_auth_method=none` and require PKCE S256.

Authorization HTML must set `form-action` dynamically from the already
validated `redirect_uri`: allow only `'self'` plus that callback's exact
origin. This is required for Chrome to follow the consent form's redirect
chain to a Codex `http://127.0.0.1:{dynamic_port}` loopback callback. Do not
place the page CSP on `/auth/:uid` 303 responses, token responses, discovery,
or other non-HTML endpoints. Static recovery/error HTML uses
`form-action 'none'`. Never log the callback URL, dynamic port, authorization
code, or state.

Short-lived OIDC interaction, resume, state, and CSRF cookies are deliberately
scoped to the generated interaction path and use the `__Secure-` prefix on
HTTPS. Do not override their path to `/` or rename them with `__Host-`: doing so
collapses parallel browser authorization attempts into a single cookie and can
invalidate a fresh consent page when another tab starts OAuth. The upstream
OIDC callback returns to the scoped interaction through a separate Redis-backed
one-time completion ticket. That ticket is HttpOnly, expires after 10 minutes,
is stored only by SHA-256 digest, and is consumed before login completion.
The long-lived browser session cookie is versioned as
`__Host-atlascloud_op_v2`; `/auth` expires the legacy
`__Host-atlascloud_op` cookie so sessions created before the cookie-isolation
rollout cannot poison a fresh interaction. This migration requires one new
reviewer sign-in but does not invalidate already stored Codex refresh tokens.

After an Auth image change, verify the real Codex DCR, reviewer interaction,
loopback callback, authorization-code exchange, and Codex token storage without
calling any billable tool:

```bash
security find-generic-password \
  -s atlascloud-openai-plugin-staging \
  -a openai-plugin-reviewer@atlascloud.ai \
  -w | node scripts/codex-oauth-e2e.mjs
```

The HTTP client check above validates protocol semantics but does not enforce a
document's CSP. The release gate must also run an isolated real Chrome session
that clicks **Allow exactly once**:

```bash
security find-generic-password \
  -s atlascloud-openai-plugin-staging \
  -a openai-plugin-reviewer@atlascloud.ai \
  -w | npm run test:codex-oauth:chrome-live
```

The Chrome test is pinned to `atlascloud-staging`, requests only the read-only
OAuth scopes, redacts URLs and OAuth values from diagnostics, and does not call
an Atlas model or any billable tool.

The authorization script response is `no-store`, and the HTML references a
versioned query string. Increment that version whenever `AUTH_SCRIPT` changes;
the version prevents a previously cached CDN object from keeping old submit
behavior after a rollout.

The `*.dev.atlascloud.ai` DNS wildcard makes this a real public HTTPS staging deployment, not the final production hostname. Promote only after the domain owner provisions the non-`dev` DNS records and the same checks pass there.

## Public production identity and credential profile

Public production must use an established upstream OIDC provider for identity
and per-user encrypted Atlas credential linking. It must not reuse the static
reviewer password table, the plaintext subject-map JSON, or a shared service
account key.

Required non-secret settings for the proposed production hosts are:

```text
NODE_ENV=production
PLUGIN_RELEASE_TIER=production

MCP_PUBLIC_URL=https://mcp.atlascloud.ai/mcp
MCP_OAUTH_ISSUER=https://mcp-auth.atlascloud.ai
MCP_OAUTH_JWKS_URI=https://mcp-auth.atlascloud.ai/jwks
MCP_OAUTH_ENDPOINT_HOSTS=mcp-auth.atlascloud.ai
MCP_OAUTH_AUDIENCE=https://mcp.atlascloud.ai/mcp
MCP_ALLOWED_HOSTS=mcp.atlascloud.ai
MCP_CREDENTIAL_MODE=redis-subject-map
MCP_CREDENTIAL_REDIS_PREFIX=atlascloud:openai-plugin:credential
MCP_IDEMPOTENCY_BACKEND=redis
MCP_GENERATION_CONFIRMATION_TTL_SECONDS=600

OIDC_ISSUER_URL=https://mcp-auth.atlascloud.ai
OIDC_MCP_RESOURCE=https://mcp.atlascloud.ai/mcp
AUTH_ALLOWED_HOSTS=mcp-auth.atlascloud.ai
AUTH_IDENTITY_MODE=upstream-oidc
AUTH_UPSTREAM_ISSUER_URL=<approved Atlas identity issuer origin>
AUTH_UPSTREAM_CLIENT_ID=<registered confidential client ID>
AUTH_UPSTREAM_SCOPES=openid,email,profile
AUTH_UPSTREAM_ENDPOINT_HOSTS=<comma-separated exact hosts used by discovery, token, and JWKS endpoints>
AUTH_CREDENTIAL_REDIS_PREFIX=atlascloud:openai-plugin:credential
```

Register this exact upstream callback URL with the identity provider:

```text
https://mcp-auth.atlascloud.ai/upstream/callback
```

`docs/UPSTREAM_OIDC_REQUIREMENTS.md` states every rule the provider must
satisfy. Confirm a candidate issuer before requesting DNS, secrets, or a
deployment window; the check needs no build step, client secret, or cluster
access:

```bash
node scripts/check-upstream-oidc.mjs https://issuer.example.com
```

It prints one `PASS`/`FAIL` line per rule plus the exact
`AUTH_UPSTREAM_ENDPOINT_HOSTS` value implied by the discovery document, and
exits non-zero on failure. `email_verified: true` in the ID token is the one
mandatory behavior discovery cannot prove; confirm it with the provider
directly.

Create these additional Kubernetes Secret keys out of band:

- `generation-confirmation-secret`: at least 32 random bytes, shared by every
  MCP replica so a quote issued by one replica can be confirmed through another
- `auth-upstream-issuer-url`: approved OIDC issuer origin
- `auth-upstream-client-id`: registered confidential client ID
- `auth-upstream-client-secret`: at least 32 characters
- `auth-upstream-endpoint-hosts`: comma-separated exact public hosts used by
  the approved issuer's authorization, token, and JWKS endpoints; it must
  include the issuer host
- `credential-encryption-keys-json`: an ordered JSON keyring containing at
  least two distinct 32-byte base64url AES keys; inject the identical value as
  both `AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON` and
  `MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON`

The Auth and MCP processes must use the same password-protected Redis URL and
the same credential prefix. A linked Atlas API key is verified with one
read-only balance request, encrypted with AES-256-GCM using the OAuth subject as
associated data, and automatically expires from Redis after 90 days. The key is
never placed in an OAuth token, tool argument, URL, log, plugin package, or
ChatGPT response. The matching federated account profile (subject, email, and
display name) uses the same 90-day retention window and is refreshed only by a
successful upstream sign-in.

Before applying a production manifest, load all values from the approved secret
manager and run the cross-process fail-closed check:

```bash
npm run validate:production-config
```

Expected output contains only non-sensitive fields and starts with:

```text
PRODUCTION_CONFIG_VALID
```

Do not apply until production DNS resolves, the upstream OIDC client exists,
the portal challenge token is available, and this validation passes. After
deployment, rerun `scripts/live-e2e.mjs` against the production hosts before
creating the final plugin ZIP.

`production.example/` is a Kustomize overlay pinned to the recorded immutable
image. It removes `OIDC_USERS_JSON` and `MCP_ATLAS_SUBJECT_KEYS_JSON`, switches
both hosts and probes to production, and references the additional Secret keys
above. Render and inspect it with:

```bash
kubectl kustomize deploy/kubernetes/production.example
```

The directory is intentionally named `.example`; do not apply the rendered
output until every external production gate above is satisfied. Both staging
and production reuse the single reviewed manifest in `base/staging.yaml`, so
there is no duplicated deployment source to drift.

### Validating upstream OIDC on staging first

`staging-upstream-oidc.example/` applies the production identity and credential
profile to the staging hosts: `AUTH_IDENTITY_MODE=upstream-oidc`,
`MCP_CREDENTIAL_MODE=redis-subject-map`, the encrypted credential keyring, and
removal of `OIDC_USERS_JSON` and `MCP_ATLAS_SUBJECT_KEYS_JSON`. It keeps
`PLUGIN_RELEASE_TIER=staging`, so a staging-labeled upstream issuer is accepted
there and rejected by the production gate.

```bash
kubectl kustomize deploy/kubernetes/staging-upstream-oidc.example
```

It reads the same additional Secret keys as production, so populate
`auth-upstream-*` and `credential-encryption-keys-json` in
`mcp-servers/atlascloud-openai-plugin` before applying, and register the
staging Auth callback with the provider. This overlay retires the reviewer
password path on staging: `scripts/codex-oauth-e2e.mjs` and
`npm run test:codex-oauth:chrome-live` both read a reviewer password from stdin
and cannot drive an upstream sign-in, so validate the browser flow manually
while it is active.
