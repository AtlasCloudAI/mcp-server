# Upstream OIDC provider requirements

`AUTH_IDENTITY_MODE=upstream-oidc` federates sign-in to an external OpenID
Connect provider. The Auth service validates the provider strictly and
fail-closed at startup and on every sign-in, so a provider that misses one of
the requirements below cannot be used by relaxing configuration. Hand this
document to whoever operates the identity service, then verify their answer
with the preflight check.

## Preflight check

Run this before any deployment change. It needs no build step, no client
secret, and no cluster access:

```bash
node scripts/check-upstream-oidc.mjs https://issuer.example.com
```

The check reports one `PASS`/`FAIL` line per rule, prints the exact
`AUTH_UPSTREAM_ENDPOINT_HOSTS` value implied by the discovery document, and
exits non-zero on the first failure. Endpoints frequently live on hosts other
than the issuer, and every such host must be listed explicitly.

## Discovery document

The provider must serve `<issuer>/.well-known/openid-configuration` over HTTPS.

| Requirement | Why it is enforced |
|---|---|
| Reachable with **no HTTP redirect** | The fetch uses `redirect: "error"`; an `http`→`https` or trailing-slash redirect fails the request |
| `content-type` includes `application/json` | A non-JSON content type is rejected before parsing |
| Body under 64 KB | Bounded read against hostile or oversized responses |
| `issuer` equals the configured issuer after trailing-slash normalization | Prevents issuer substitution |
| `response_types_supported` includes `code` | Only the authorization code flow is used |
| `code_challenge_methods_supported` includes `S256` | PKCE S256 is mandatory |
| `scopes_supported` includes every requested scope | Default `openid`, `email`, `profile` |
| `token_endpoint_auth_methods_supported` includes `client_secret_basic` | A confidential client is required in production |
| `id_token_signing_alg_values_supported` includes `RS256`, `ES256`, or `PS256` | Symmetric ID-token signatures are refused |
| `authorization_endpoint`, `token_endpoint`, `jwks_uri` present | All three are validated as endpoints |

Every endpoint must be HTTPS on port 443, carry no userinfo or fragment, and
resolve to a host listed in `AUTH_UPSTREAM_ENDPOINT_HOSTS`.

## Issuer URL

- A bare origin: no path, query, or fragment. `https://id.example.com` is
  valid, `https://example.com/oauth` is not.
- No `dev`, `development`, `stage`, `staging`, or `test` label in the hostname
  for a `PLUGIN_RELEASE_TIER=production` release. A staging tier may use one.
- Public DNS only. IP literals, `localhost`, `*.localhost`, `*.local`, and
  single-label hosts are refused in production.

## Client registration

- Confidential client with a secret of at least 32 characters in production.
- Register this exact redirect URI, matching the Auth issuer host of the
  environment being deployed:

```text
https://mcp-auth.atlascloud.ai/upstream/callback
```

  A staging validation of the same flow additionally needs the staging Auth
  host's callback registered, for example
  `https://atlascloud-auth.dev.atlascloud.ai/upstream/callback`.
- The authorization request always sends `response_type=code`, `state`,
  `nonce`, `code_challenge`, and `code_challenge_method=S256`.

## ID token claims

The ID token from the code exchange is verified against the provider JWKS with
a 30-second clock tolerance. These claims are required and cannot be waived:

| Claim | Requirement |
|---|---|
| `iss` | Equals the configured issuer |
| `aud` | Equals `AUTH_UPSTREAM_CLIENT_ID` |
| `sub` | Stable per user, 1–512 characters |
| `nonce` | Echoes the value from the authorization request |
| `email` | A valid address, at most 254 characters |
| `email_verified` | The **boolean** `true`; the string `"true"` is rejected |
| `iat`, `exp` | Present |

`name` is optional; the local part of the email is used when it is absent.

A provider that cannot assert `email_verified: true` will fail every sign-in
even when discovery passes the preflight check. Confirm this claim explicitly
before scheduling a rollout.

## Identity mapping

The plugin never stores the upstream subject directly. It derives
`oidc-<base64url(sha256(issuer, upstream_sub))>` so a subject cannot be
replayed across issuers. Changing the issuer origin therefore re-keys every
linked account: existing users must link their Atlas API key again.
