import type { Interaction } from "oidc-provider";

export const AUTH_STYLES = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #f5f7fb; color: #172033; display: grid; place-items: center; padding: 24px; }
main { width: min(100%, 460px); background: white; border: 1px solid #dfe5ef; border-radius: 18px; padding: 32px; box-shadow: 0 16px 50px rgba(24, 39, 75, .10); }
.brand { display: flex; align-items: center; gap: 12px; font-weight: 700; margin-bottom: 24px; }
.mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; background: #4f46e5; color: white; }
h1 { font-size: 24px; line-height: 1.25; margin: 0 0 10px; }
p { color: #536078; line-height: 1.55; }
label { display: block; font-size: 14px; font-weight: 600; margin: 18px 0 7px; }
input { width: 100%; border: 1px solid #cbd3df; border-radius: 10px; padding: 12px 13px; font: inherit; }
input:focus { outline: 3px solid rgba(79, 70, 229, .18); border-color: #4f46e5; }
button, .button { width: 100%; border: 0; border-radius: 10px; padding: 12px 16px; margin-top: 20px; font: inherit; font-weight: 700; cursor: pointer; text-align: center; }
.primary { background: #4f46e5; color: white; }
.secondary { background: #edf0f5; color: #27334a; }
.error { background: #fff0f0; border: 1px solid #ffc7c7; color: #8b1f1f; padding: 11px 13px; border-radius: 10px; }
ul { padding-left: 22px; color: #344057; line-height: 1.55; }
.notice { font-size: 13px; color: #69758a; margin-top: 22px; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.actions button { margin-top: 20px; }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function layout(content: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Atlas Cloud</title>
  <link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
  <main>
    <div class="brand"><span class="mark" aria-hidden="true">A</span><span>Atlas Cloud</span></div>
    ${content}
  </main>
</body>
</html>`;
}

function hiddenFields(uid: string, csrfToken: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    <input type="hidden" name="interaction_uid" value="${escapeHtml(uid)}">`;
}

export function renderLogin(interaction: Interaction, csrfToken: string, error?: string): string {
  return layout(`
    <h1>Connect ChatGPT to Atlas Cloud</h1>
    <p>Sign in with the dedicated Atlas Cloud reviewer account to continue.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(interaction.uid)}/login">
      ${hiddenFields(interaction.uid, csrfToken)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" maxlength="254" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
      <button class="primary" type="submit">Continue</button>
    </form>
    <p class="notice">Credentials are verified by Atlas Cloud and are never shared with ChatGPT.</p>
  `, "Sign in");
}

export function renderCredentialLink(
  interaction: Interaction,
  csrfToken: string,
  ticket: string,
  email: string,
  error?: string
): string {
  return layout(`
    <h1>Link your Atlas Cloud API key</h1>
    <p>Your verified account <strong>${escapeHtml(email)}</strong> needs an Atlas Cloud API key before ChatGPT can use Atlas Cloud on your behalf.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(interaction.uid)}/link">
      ${hiddenFields(interaction.uid, csrfToken)}
      <input type="hidden" name="link_ticket" value="${escapeHtml(ticket)}">
      <label for="atlas_api_key">Atlas Cloud API key</label>
      <input id="atlas_api_key" name="atlas_api_key" type="password" autocomplete="off" minlength="16" maxlength="4096" required autofocus>
      <button class="primary" type="submit">Verify and link</button>
    </form>
    <p class="notice">The key is validated with a read-only balance request, encrypted before storage, and never sent to ChatGPT.</p>
  `, "Link API key");
}

function requestedScopes(interaction: Interaction): string[] {
  const details = interaction.prompt.details;
  const scopes = new Set<string>();
  const missingOidc = details.missingOIDCScope;
  if (Array.isArray(missingOidc)) {
    for (const scope of missingOidc) if (typeof scope === "string") scopes.add(scope);
  }
  const missingResources = details.missingResourceScopes;
  if (missingResources && typeof missingResources === "object" && !Array.isArray(missingResources)) {
    for (const resourceScopes of Object.values(missingResources)) {
      if (Array.isArray(resourceScopes)) {
        for (const scope of resourceScopes) if (typeof scope === "string") scopes.add(scope);
      }
    }
  }
  return [...scopes].sort();
}

const scopeLabels: Record<string, string> = {
  openid: "Confirm your Atlas Cloud identity",
  email: "Read your verified account email",
  offline_access: "Stay connected using refresh tokens",
  "atlas:models:read": "Browse the live Atlas Cloud model catalog",
  "atlas:predictions:read": "Read generation status and results",
  "atlas:billing:read": "Read balance and usage information",
  "atlas:generation:write": "Start billable AI media generation jobs",
};

export function renderConsent(interaction: Interaction, csrfToken: string): string {
  const scopes = requestedScopes(interaction);
  const items = scopes.length > 0
    ? scopes.map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`).join("")
    : "<li>Use the permissions you previously approved</li>";
  const billingNotice = scopes.includes("atlas:generation:write")
    ? '<p class="notice">Generation calls may consume Atlas Cloud credits. ChatGPT will show tool details before invoking write operations.</p>'
    : "";
  return layout(`
    <h1>Authorize ChatGPT</h1>
    <p>ChatGPT is requesting permission to use Atlas Cloud on your behalf:</p>
    <ul>${items}</ul>
    ${billingNotice}
    <form method="post" action="/interaction/${encodeURIComponent(interaction.uid)}/confirm">
      ${hiddenFields(interaction.uid, csrfToken)}
      <div class="actions">
        <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
        <button class="primary" type="submit" name="decision" value="allow">Allow</button>
      </div>
    </form>
  `, "Authorize");
}

export function renderUnsupportedPrompt(): string {
  return layout(`
    <h1>Authorization cannot continue</h1>
    <p class="error" role="alert">The authorization server received an unsupported interaction.</p>
  `, "Authorization error");
}

export function renderAuthorizationRecovery(): string {
  return layout(`
    <h1>This authorization link is no longer valid</h1>
    <p class="error" role="alert">The request expired, was already completed, or belongs to a different browser session.</p>
    <p>Return to ChatGPT or Codex, reconnect Atlas Cloud, open the newly generated authorization link, and select <strong>Allow</strong> once.</p>
    <p class="notice">Refreshing or resubmitting this page cannot restore an expired OAuth request.</p>
  `, "Reconnect Atlas Cloud");
}
