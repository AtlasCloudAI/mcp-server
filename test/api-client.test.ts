import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ApiRequestError,
  fetchExternal,
  request,
} from "../src/services/api-client.js";

function fetcherFrom(handler: () => Response | Promise<Response>): typeof fetch {
  return (async () => handler()) as typeof fetch;
}

test("billable POST never retries, including retryable 503 responses", async () => {
  let calls = 0;
  const fetcher = fetcherFrom(() => {
    calls += 1;
    return new Response(JSON.stringify({ message: "temporary failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    request("https://api.example.test", "/billable", {
      method: "POST",
      requireAuth: false,
      maxRetries: 5,
      fetcher,
    }),
    ApiRequestError
  );
  assert.equal(calls, 1);
});

test("malformed successful POST response fails closed without retry", async () => {
  let calls = 0;
  const fetcher = fetcherFrom(() => {
    calls += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    request("https://api.example.test", "/billable", {
      method: "POST",
      requireAuth: false,
      maxRetries: 5,
      responseSchema: z.object({ data: z.object({ id: z.string().min(1) }) }),
      fetcher,
    }),
    /malformed API response/
  );
  assert.equal(calls, 1);
});

test("upstream error messages redact bearer and token values", async () => {
  const fetcher = fetcherFrom(() =>
    new Response(
      JSON.stringify({
        message:
          "failed with Bearer secret-token-value and https://x.test/?access_token=secret123",
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    )
  );
  await assert.rejects(
    request("https://api.example.test", "/safe", {
      requireAuth: false,
      fetcher,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.doesNotMatch(error.message, /secret-token-value|secret123/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("external resource allowlist blocks SSRF-shaped URLs before fetch", async () => {
  let calls = 0;
  const fetcher = fetcherFrom(() => {
    calls += 1;
    return new Response("{}", { status: 200 });
  });
  const blocked = [
    "http://static.atlascloud.ai/schema.json",
    "https://evil.example/schema.json",
    "https://user:pass@static.atlascloud.ai/schema.json",
    "https://static.atlascloud.ai:8443/schema.json",
  ];
  for (const url of blocked) {
    await assert.rejects(fetchExternal(url, { fetcher }), /not allowed/);
  }
  assert.equal(calls, 0);
});

test("external resource redirects and responses over 2 MiB fail closed", async () => {
  const redirect = fetcherFrom(() =>
    new Response("", {
      status: 302,
      headers: { location: "https://evil.example/schema.json" },
    })
  );
  await assert.rejects(
    fetchExternal("https://static.atlascloud.ai/schema.json", { fetcher: redirect }),
    /Failed to fetch external resource/
  );

  let sizeCalls = 0;
  const tooLarge = fetcherFrom(() => {
    sizeCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
  });
  await assert.rejects(
    fetchExternal("https://static.atlascloud.ai/schema.json", { fetcher: tooLarge }),
    /2 MiB limit/
  );
  assert.equal(sizeCalls, 1);
});
