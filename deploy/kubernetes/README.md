# Atlas Cloud OpenAI Plugin deployment

> ## Current architecture — read this before anything below
>
> Identity moved to the **Atlas Cloud website's own OIDC provider**
> (`auth.atlascloud.ai`, and `auth.dev.atlascloud.ai` on dev). The self-hosted
> authorization server in this repo (`atlascloud-openai-auth`) is **no longer
> used** and is not deployed to production.
>
> Credentials use `MCP_CREDENTIAL_MODE=oauth-exchange`: every request trades the
> caller's own OAuth token for an API-facing token (RFC 8693), so generation is
> billed to the caller's own Atlas account and **the server stores no user
> credential at all**.
>
> What that changes versus the sections further down:
>
> | | Old (`redis-subject-map` + self-hosted auth) | Current (`oauth-exchange`) |
> |---|---|---|
> | Deployments | 2 (`-mcp`, `-auth`) | 1 (`-mcp`) |
> | Public hosts | 2 | 1 |
> | Secret keys needed | 7+ | 3 (`redis-url`, `generation-confirmation-secret`, `openai-challenge-token`) plus `client-secret` in a separate Secret |
> | What Redis holds | encrypted user API keys | **idempotency keys only** — exchanged tokens live in process memory (`src/services/token-exchange.ts`), never on disk |
> | `credential-encryption-keys-json` | required, >=2 keys | **unused**; the production overlay deletes it |
>
> Because Redis no longer holds anything derived from user credentials, it does
> not need to be a dedicated instance and a managed Redis is fine.
>
> **Production deploy: use `production.example/`.** Everything from
> "Public production identity and credential profile" onward that mentions
> `mcp-auth.atlascloud.ai`, `AUTH_*`, `OIDC_*`, `redis-subject-map`, or the
> reviewer password table describes the retired architecture and is kept only
> for history.

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
| Refresh token | 7,776,000 seconds (90 days) | Independent from the 8-hour browser session and rotated on refresh; the consumed token allows at most 2 retries inside a fixed 30-second window, then strict replay detection resumes |
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

### Pointing a non-production deployment at a non-production Atlas

Every Atlas call the plugin makes derives from one origin, overridable with:

```text
ATLASCLOUD_API_BASE_URL=https://<non-production atlas api origin>
```

Unset, it is `https://api.atlascloud.ai`. The value must be a bare origin —
the three API paths are appended to it, so a path here silently produces
`/api/v1/api/v1/...` — and must be HTTPS unless the host is loopback.

A `PLUGIN_RELEASE_TIER=production` release refuses any override and fails to
start. A production plugin quietly talking to a different Atlas would validate
credentials against the wrong account universe, and that only surfaces once a
customer sees someone else's data.

Without this override a staging deployment authenticates users against staging
but calls the production API, so only production API keys work there and a test
run bills real accounts.

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

## Public production configuration (current)

Rendered by `production.example/`. Everything below is what the overlay sets;
only the four `REPLACE_WITH_*` placeholders need filling in.

```text
NODE_ENV=production
PLUGIN_RELEASE_TIER=production

MCP_PUBLIC_URL=https://mcp.atlascloud.ai/mcp
MCP_OAUTH_AUDIENCE=https://mcp.atlascloud.ai/mcp
MCP_ALLOWED_HOSTS=mcp.atlascloud.ai

MCP_OAUTH_ISSUER=https://auth.atlascloud.ai
MCP_OAUTH_JWKS_URI=https://auth.atlascloud.ai/jwks
MCP_OAUTH_ENDPOINT_HOSTS=auth.atlascloud.ai
MCP_OAUTH_ALGORITHMS=RS256

MCP_CREDENTIAL_MODE=oauth-exchange
MCP_TOKEN_EXCHANGE_URL=https://auth.atlascloud.ai/token
MCP_TOKEN_EXCHANGE_RESOURCE=https://api.atlascloud.ai
MCP_TOKEN_EXCHANGE_CLIENT_ID=<registered production token-exchange client>

ATLASCLOUD_API_BASE_URL=<production backend internal origin, or https://api.atlascloud.ai>
ATLASCLOUD_GENERATION_API_BASE_URL=<production aiproxy internal origin, or https://api.atlascloud.ai>

MCP_IDEMPOTENCY_BACKEND=redis
MCP_ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com,https://platform.openai.com
MCP_TRUST_PROXY=1
```

The three OAuth endpoint values were verified against the live document at
`https://auth.atlascloud.ai/.well-known/oauth-authorization-server`: the
endpoints sit at the **root** path, not under `/api/v1/oidc/`. Startup
reconciles `MCP_OAUTH_JWKS_URI` against that document, so a wrong path leaves
the Pod permanently unready instead of serving bad tokens.

`MCP_OAUTH_AUDIENCE` must match the resource identifier registered in the
production authorization server character for character.

### Secrets for the current architecture

`mcp-servers/atlascloud-openai-plugin`:

- `redis-url`: `redis://:<password>@<host>:6379`. A production release rejects a
  password-less URL. Holds idempotency keys only.
- `generation-confirmation-secret`: at least 32 random bytes, shared by every
  replica so a quote issued by one can be confirmed through another.
- `openai-challenge-token`: the portal verification token.

`mcp-servers/atlas-mcp-token-exchange`:

- `client-secret`: the plaintext secret of the registered token-exchange client.
  The authorization server stores only a bcrypt hash, so it cannot be recovered
  later — capture it at registration time.

`redis-password` is still read by the Redis StatefulSet in `base/staging.yaml`
when you use the bundled Redis rather than a managed one.

### Retired: self-hosted authorization server

Everything from here to the end of this file describes the retired
`atlascloud-openai-auth` application — the local reviewer password table, DCR
callback policy, upstream-OIDC wiring, and `credential-encryption-keys-json`.
`production.example/drop-auth-app.yaml` removes that Deployment and Service, so
none of it applies to a production deploy. It is kept for history and for the
dev environment while that copy is still running.

### Optional: link the Atlas key without asking the user

By default a first-time user pastes an Atlas API key once, and it is encrypted
and reused for 90 days. Setting both of these makes the first sign-in link the
key automatically, falling back to the manual form whenever the exchange cannot
answer:

```text
AUTH_CREDENTIAL_EXCHANGE_URL=https://<atlas api host>/api/v1/federated/credential
AUTH_CREDENTIAL_EXCHANGE_TOKEN=<dedicated shared secret, at least 32 characters>
```

Setting only one of them is a startup error rather than a silent no-op, because
a half-configured exchange looks exactly like a working one: every user simply
keeps pasting keys. The token must be the backend's dedicated federated
credential secret, never a service token that can impersonate accounts.

The exchange names the identity in the upstream provider's own terms — the
issuer plus the subject the provider asserted — so the backend can find the
matching Atlas account. The subject stored against a linked credential is a
one-way hash of issuer and subject and cannot be mapped back. An exchanged key
is still verified with the same read-only balance request as a pasted one, and
the `federated_credential_exchange` audit event records only the outcome
(`linked`, `no_account`, `error`), never the identity or the key.

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
