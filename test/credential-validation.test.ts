import assert from "node:assert/strict";
import test from "node:test";
import type { fetch as undiciFetch } from "undici";
import { validateAtlasCredential } from "../src/services/credential-validation.js";

test("Atlas credential validation performs one authenticated read-only balance request", async () => {
  let calls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), "https://api.atlascloud.ai/public/v1/balance");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer atlas-test-key-1234567890");
    return new Response(JSON.stringify({
      object: "balance",
      scope: "self",
      available: { value: "1.00", currency: "USD" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof undiciFetch;

  await validateAtlasCredential("atlas-test-key-1234567890", fetcher);
  assert.equal(calls, 1);
});

test("Atlas credential validation rejects control characters and never retries 401", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "invalid key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof undiciFetch;

  await assert.rejects(
    () => validateAtlasCredential("atlas-test-key-1234567890\nInjected: yes", fetcher),
    /invalid format/
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => validateAtlasCredential("atlas-invalid-key-1234567890", fetcher),
    /invalid key|API request failed/
  );
  assert.equal(calls, 1);
});
