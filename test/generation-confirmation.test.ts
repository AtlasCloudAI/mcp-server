import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  GenerationConfirmationError,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../src/services/generation-confirmation.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";

const idempotencyKey = "3a95b8e8-19f5-4e91-9e37-7ac34320c659";
const request = {
  resolved_model: "provider/model-v1",
  request_body: { model: "provider/model-v1", prompt: "a blue cloud" },
};
const pricing = {
  discount: "80",
  actual: { base_price: "0.004" },
  origin: { base_price: "0.005" },
};

function withSubject<T>(subject: string, operation: () => T): T {
  return runWithRequestContext(
    {
      authInfo: {
        token: "test-access-token",
        clientId: "test-client",
        scopes: ["atlas:generation:write"],
      } as AuthInfo,
      subject,
      atlasApiKey: "not-used-by-this-test",
      idempotencyStore: new InMemoryIdempotencyStore(),
      idempotencyTtlSeconds: 60,
      generationConfirmationSecret:
        "test-confirmation-secret-that-is-long-enough",
      generationConfirmationTtlSeconds: 600,
    },
    operation
  );
}

test("generation confirmation accepts only the same user, tool, key, request, and price", () => {
  const quote = withSubject("reviewer-one", () =>
    issueGenerationConfirmation(
      "atlas_generate_image",
      idempotencyKey,
      request,
      pricing
    )
  );

  withSubject("reviewer-one", () =>
    verifyGenerationConfirmation(
      quote.confirmationToken,
      "atlas_generate_image",
      idempotencyKey,
      request,
      pricing
    )
  );

  const mismatches: Array<() => void> = [
    () =>
      withSubject("reviewer-two", () =>
        verifyGenerationConfirmation(
          quote.confirmationToken,
          "atlas_generate_image",
          idempotencyKey,
          request,
          pricing
        )
      ),
    () =>
      withSubject("reviewer-one", () =>
        verifyGenerationConfirmation(
          quote.confirmationToken,
          "atlas_generate_video",
          idempotencyKey,
          request,
          pricing
        )
      ),
    () =>
      withSubject("reviewer-one", () =>
        verifyGenerationConfirmation(
          quote.confirmationToken,
          "atlas_generate_image",
          "5be658f1-2394-4f84-9fc1-80e91a32d616",
          request,
          pricing
        )
      ),
    () =>
      withSubject("reviewer-one", () =>
        verifyGenerationConfirmation(
          quote.confirmationToken,
          "atlas_generate_image",
          idempotencyKey,
          { ...request, request_body: { ...request.request_body, prompt: "changed" } },
          pricing
        )
      ),
    () =>
      withSubject("reviewer-one", () =>
        verifyGenerationConfirmation(
          quote.confirmationToken,
          "atlas_generate_image",
          idempotencyKey,
          request,
          { ...pricing, actual: { base_price: "0.006" } }
        )
      ),
  ];
  for (const mismatch of mismatches) {
    assert.throws(mismatch, GenerationConfirmationError);
  }
});

test("generation confirmation rejects tampering, expiry, and missing live pricing", () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const quote = withSubject("reviewer-one", () =>
      issueGenerationConfirmation(
        "atlas_generate_image",
        idempotencyKey,
        request,
        pricing
      )
    );
    const tampered = `${quote.confirmationToken.slice(0, -1)}x`;
    assert.throws(
      () =>
        withSubject("reviewer-one", () =>
          verifyGenerationConfirmation(
            tampered,
            "atlas_generate_image",
            idempotencyKey,
            request,
            pricing
          )
        ),
      GenerationConfirmationError
    );

    now += 601_000;
    assert.throws(
      () =>
        withSubject("reviewer-one", () =>
          verifyGenerationConfirmation(
            quote.confirmationToken,
            "atlas_generate_image",
            idempotencyKey,
            request,
            pricing
          )
        ),
      /expired/
    );
  } finally {
    Date.now = originalNow;
  }

  assert.throws(
    () =>
      withSubject("reviewer-one", () =>
        issueGenerationConfirmation(
          "atlas_generate_image",
          idempotencyKey,
          request,
          undefined
        )
      ),
    /pricing metadata is unavailable/
  );
});
