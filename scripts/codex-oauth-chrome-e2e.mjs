#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const AUTH_ORIGIN = "https://atlascloud-auth.dev.atlascloud.ai";
const MCP_URL = "https://atlascloud-mcp.dev.atlascloud.ai/mcp";
const SERVER_NAME = "atlascloud-staging";
const REVIEWER_EMAIL = "openai-plugin-reviewer@atlascloud.ai";
const READ_ONLY_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "atlas:models:read",
  "atlas:predictions:read",
  "atlas:billing:read",
];
const CHROME_BIN = process.env.CHROME_BIN
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CODEX_BIN = process.env.CODEX_BIN
  ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const PROFILE_PREFIX = "atlascloud-chrome-oauth-e2e-";

assert.ok(existsSync(CHROME_BIN), `Chrome is unavailable: ${CHROME_BIN}`);
assert.ok(existsSync(CODEX_BIN), `Codex is unavailable: ${CODEX_BIN}`);

const reviewerPassword = readFileSync(0, "utf8").trim();
assert.ok(reviewerPassword.length >= 16, "reviewer password must be supplied on stdin");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function redact(raw) {
  return raw
    .replace(/https?:\/\/\S+/g, "[URL redacted]")
    .replace(/(client_id|state|code|code_challenge)=([^&\s]+)/g, "$1=[redacted]")
    .slice(0, 2_000)
    .trim();
}

function findAuthorizationUrl(raw) {
  for (const candidate of raw.match(/https:\/\/[^\s]+/g) ?? []) {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === AUTH_ORIGIN && parsed.pathname === "/auth") return parsed;
    } catch {
      // Ignore terminal fragments that only resemble URLs.
    }
  }
  return undefined;
}

function classifyUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.origin === AUTH_ORIGIN) {
      if (/^\/interaction\/[^/]+\/login$/.test(url.pathname)) return "reviewer-login";
      if (/^\/interaction\/[^/]+\/confirm$/.test(url.pathname)) return "consent-confirm";
      if (/^\/interaction\/[^/]+$/.test(url.pathname)) return "interaction-page";
      if (/^\/auth\/[^/]+$/.test(url.pathname)) return "auth-resume";
      if (url.pathname === "/auth") return "auth-start";
      if (url.pathname === "/token") return "token";
      return undefined;
    }
    if (
      url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && /^\/callback\/[A-Za-z0-9_-]{12}$/.test(url.pathname)
    ) {
      return "loopback-callback";
    }
  } catch {
    // Ignore non-URL protocol events.
  }
  return undefined;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== "string") return;
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
  }

  send(method, params = {}) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, "CDP socket is not open");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitForAuthorizationUrl(child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const authorizationUrl = findAuthorizationUrl(getOutput());
    if (authorizationUrl) return authorizationUrl;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(100);
  }
  throw new Error(`Codex did not provide an authorization URL: ${redact(getOutput())}`);
}

async function waitForDevToolsPort(profileDir, chrome, getDiagnostics) {
  const activePortFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const [rawPort] = readFileSync(activePortFile, "utf8").split(/\r?\n/);
      const port = Number.parseInt(rawPort, 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) break;
    await delay(100);
  }
  throw new Error(`Chrome DevTools did not start: ${redact(getDiagnostics())}`);
}

async function waitForDom(client, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `Boolean(${expression})`,
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopOwnedProcess(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  try {
    await withTimeout(waitForExit(child), 5_000, `${label} did not stop after SIGTERM`);
    return true;
  } catch (error) {
    process.stderr.write(`WARN ${error.message}; no stronger termination was attempted\n`);
    return false;
  }
}

function safelyRemoveOwnedProfile(profileDir, profileBase) {
  if (!profileDir || !existsSync(profileDir)) return;
  const stat = lstatSync(profileDir);
  assert.equal(stat.isSymbolicLink(), false, `refusing to remove symlink: ${profileDir}`);
  assert.equal(dirname(profileDir), profileBase, `profile escaped temp boundary: ${profileDir}`);
  assert.ok(basename(profileDir).startsWith(PROFILE_PREFIX), `unexpected profile name: ${profileDir}`);
  rmSync(profileDir, { recursive: true, force: false });
}

let codex;
let chrome;
let cdp;
let profileDir;
let profileBase;
let chromeStopped = false;
const trace = [];
const requestCategories = new Map();

function recordTrace(entry) {
  if (!entry || trace.at(-1) === entry || trace.length >= 80) return;
  trace.push(entry);
}

try {
  let codexOutput = "";
  codex = spawn(CODEX_BIN, [
    "mcp",
    "login",
    SERVER_NAME,
    "--scopes",
    READ_ONLY_SCOPES.join(","),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const codexExit = waitForExit(codex);
  codex.stdout.setEncoding("utf8");
  codex.stderr.setEncoding("utf8");
  codex.stdout.on("data", (chunk) => { codexOutput += chunk; });
  codex.stderr.on("data", (chunk) => { codexOutput += chunk; });

  const authorizationUrl = await waitForAuthorizationUrl(codex, () => codexOutput);
  assert.equal(authorizationUrl.searchParams.get("resource"), MCP_URL);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(
    new Set((authorizationUrl.searchParams.get("scope") ?? "").split(/\s+/)),
    new Set(READ_ONLY_SCOPES)
  );

  profileBase = realpathSync(tmpdir());
  profileDir = mkdtempSync(join(profileBase, PROFILE_PREFIX));
  assert.equal(dirname(profileDir), profileBase);
  assert.equal(lstatSync(profileDir).isSymbolicLink(), false);

  let chromeDiagnostics = "";
  chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => { chromeDiagnostics += chunk; });

  const port = await waitForDevToolsPort(profileDir, chrome, () => chromeDiagnostics);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const pageTarget = targets.find((target) => target.type === "page");
  assert.ok(pageTarget?.webSocketDebuggerUrl, "Chrome did not expose a page target");

  cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
  ]);

  cdp.on("Network.requestWillBeSent", (event) => {
    const next = classifyUrl(event.request?.url);
    const previous = classifyUrl(event.redirectResponse?.url);
    if (next && typeof event.requestId === "string") {
      requestCategories.set(event.requestId, next);
    }
    if (event.redirectResponse && previous && next) {
      recordTrace(`${previous} --${Math.trunc(event.redirectResponse.status)}--> ${next}`);
    }
  });
  cdp.on("Network.responseReceived", (event) => {
    const category = classifyUrl(event.response?.url);
    if (category && Number.isFinite(event.response?.status)) {
      recordTrace(`${category} <=${Math.trunc(event.response.status)}`);
    }
  });
  cdp.on("Network.loadingFailed", (event) => {
    const category = requestCategories.get(event.requestId);
    if (category) recordTrace(`${category} failed ${event.errorText ?? "unknown"}`);
  });
  cdp.on("Page.frameNavigated", (event) => {
    const category = classifyUrl(event.frame?.url);
    if (category) recordTrace(`main-frame ${category}`);
  });

  await cdp.send("Page.navigate", { url: authorizationUrl.toString() });
  await waitForDom(
    cdp,
    'document.querySelector("input[name=email]") && document.querySelector("input[name=password]")',
    "reviewer login form"
  );
  const loginResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const email = document.querySelector("input[name=email]");
      const password = document.querySelector("input[name=password]");
      const form = email?.form;
      if (!email || !password || !form) return false;
      email.value = ${JSON.stringify(REVIEWER_EMAIL)};
      password.value = ${JSON.stringify(reviewerPassword)};
      form.requestSubmit();
      return true;
    })()`,
    returnByValue: true,
  });
  assert.equal(loginResult.result?.value, true, "reviewer login form could not be submitted");

  await waitForDom(
    cdp,
    'document.querySelector("button[name=decision][value=allow]")',
    "consent Allow button"
  );
  const buttonBox = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const button = document.querySelector("button[name=decision][value=allow]");
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
    returnByValue: true,
  });
  const point = buttonBox.result?.value;
  assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), "Allow button has no click point");

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });

  const exit = await withTimeout(
    codexExit,
    30_000,
    "Chrome clicked Allow once but Codex did not complete OAuth"
  );
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, `Codex OAuth failed: ${redact(codexOutput) || "no diagnostic output"}`);
  assert.ok(
    trace.some((entry) => entry.includes("consent-confirm --303--> auth-resume")),
    `Chrome trace missed consent redirect: ${trace.join(" | ")}`
  );
  assert.ok(
    trace.some((entry) => entry.includes("auth-resume --303--> loopback-callback")),
    `Chrome trace missed loopback redirect: ${trace.join(" | ")}`
  );

  process.stdout.write("PASS isolated Chrome clicked Allow exactly once\n");
  process.stdout.write(`PASS ${trace.join(" | ")}\n`);
  process.stdout.write("PASS Codex exchanged the code and stored read-only OAuth tokens\n");
} catch (error) {
  process.stderr.write(`TRACE ${trace.join(" | ") || "no relevant browser events"}\n`);
  throw error;
} finally {
  cdp?.close();
  await stopOwnedProcess(codex, "Codex OAuth process");
  chromeStopped = await stopOwnedProcess(chrome, "isolated Chrome");
  if (chromeStopped && profileDir && profileBase) safelyRemoveOwnedProfile(profileDir, profileBase);
}
