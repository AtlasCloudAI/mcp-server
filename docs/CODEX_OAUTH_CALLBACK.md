# Codex OAuth callback recovery for AtlasCloud staging

This repository includes a macOS helper for the AtlasCloud staging OAuth flow:

```bash
./scripts/codex-oauth-app-server-login.sh
```

## Why this helper exists

The ordinary `codex mcp login atlascloud-staging` path uses Codex's default
callback wait. If the user spends too long signing in or granting consent, the
local loopback listener exits before the browser redirects back. The browser
then shows an expired or already-completed authorization request even though
the user clicked **Allow** only once.

The helper uses the Codex App Server `mcpServer/oauth/login` request and sets
`timeoutSecs` to 540 seconds. AtlasCloud staging interactions expire after 600
seconds, so this leaves one minute for the authorization-code exchange instead
of extending the browser interaction indefinitely.

## Safety boundaries

The script fails closed unless every check passes:

- MCP name is exactly `atlascloud-staging`.
- MCP resource is exactly `https://atlascloud-mcp.dev.atlascloud.ai/mcp`.
- Authorization origin is exactly `https://atlascloud-auth.dev.atlascloud.ai/auth`.
- Requested scopes are only `openid`, `email`, `profile`, `offline_access`,
  `atlas:models:read`, `atlas:predictions:read`, and `atlas:billing:read`.
- `atlas:generation:write` is rejected before the browser can open.
- The loopback callback is `127.0.0.1` and its listening socket belongs to the
  newly started Codex App Server process.
- Temporary protocol logs are private and removed on exit.
- A concurrent ordinary `codex mcp login atlascloud-staging` process is rejected
  so the user cannot accidentally mix two authorization pages.

This helper performs OAuth login only. It does not call any Atlas model,
generation, transcription, upload, or billing API.

## User flow

1. Make sure the `atlascloud-staging` MCP entry already points to the staging
   URL shown above.
2. Run the helper and keep the terminal open.
3. Wait for `本机回调监听器已就绪`.
4. In the newly opened browser tab, sign in if required and click **Allow** once.
5. Return to the terminal and confirm it prints `OAuth 成功`.

If the browser page says that the link is no longer valid, close it and rerun
the helper. Never reuse, refresh, or resubmit an old consent page.

## Regression test

The local test uses a mock Codex App Server and never connects to AtlasCloud:

```bash
./scripts/test-codex-oauth-app-server-login.sh
```

It covers successful completion, rejected consent, a wrong authorization
origin, and a missing callback listener. The last two cases must be blocked
before a browser is opened.

## Compatibility

The helper requires macOS Bash, `/usr/bin/open`, `/usr/sbin/lsof`, and a Codex
build that supports `mcpServer/oauth/login` with `timeoutSecs`. It has been
validated with `codex-cli 0.148.0-alpha.9`.
