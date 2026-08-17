#!/usr/bin/env node

import http from "node:http";
import readline from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli mock-0.1.0\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("mock only supports --version and app-server\n");
  process.exit(2);
}

const resultMode = process.env.MOCK_OAUTH_RESULT ?? "success";
const originMode = process.env.MOCK_AUTH_ORIGIN ?? "staging";
const listenerMode = process.env.MOCK_LISTENER ?? "present";
let listener;

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function complete(success, error = null) {
  if (listener) listener.close();
  emit({
    method: "mcpServer/oauthLogin/completed",
    params: {
      name: "atlascloud-staging",
      threadId: null,
      success,
      error,
    },
    emittedAtMs: Date.now(),
  });
}

async function login(id) {
  let port = 65500;
  if (listenerMode === "present") {
    listener = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    port = listener.address().port;
  }

  const authBase = originMode === "staging"
    ? "https://atlascloud-auth.dev.atlascloud.ai/auth"
    : "https://example.invalid/auth";
  const authorizationUrl = new URL(authBase);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", "mock-client");
  authorizationUrl.searchParams.set("state", "mock-state");
  authorizationUrl.searchParams.set("code_challenge", "A".repeat(43));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set(
    "redirect_uri",
    `http://127.0.0.1:${port}/callback/ABCDEFGHIJKL`
  );
  authorizationUrl.searchParams.set(
    "scope",
    "openid email profile offline_access atlas:models:read atlas:predictions:read atlas:billing:read"
  );
  authorizationUrl.searchParams.set(
    "resource",
    "https://atlascloud-mcp.dev.atlascloud.ai/mcp"
  );

  emit({ id, result: { authorizationUrl: authorizationUrl.toString() } });
  if (resultMode === "success") {
    setTimeout(() => complete(true), 1_500);
  } else {
    setTimeout(() => complete(false, "mock authorization rejected"), 1_500);
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    return;
  }

  if (message.method === "initialize") {
    emit({
      id: message.id,
      result: {
        userAgent: "mock-codex-app-server",
        codexHome: "/tmp/mock-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
  } else if (message.method === "mcpServer/oauth/login") {
    void login(message.id).catch((error) => {
      emit({ id: message.id, error: { code: -32000, message: error.message } });
    });
  }
});

input.on("close", () => {
  if (listener) listener.close();
  process.exit();
});
