// 11-18 ChatGPT regression: G06 (one card per reply), O04 (chat cut off at max_tokens),
// "Actual charge: Not reported" on get_prediction, S10 (picture added under the history list).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHARGE_NOT_IN_RECORD, CHAT_TRUNCATED_NEXT_STEP, chargeLine } from "../src/tools/llm.js";
import { LIST_CARD_NOTE } from "../src/tools/predictions.js";

test("O04: a chat answer cut off at max_tokens tells the model so and how to get the rest", () => {
  assert.match(CHAT_TRUNCATED_NEXT_STEP, /finish_reason: length/);
  assert.match(CHAT_TRUNCATED_NEXT_STEP, /at least 1024/);
  const source = readFileSync(new URL("../src/tools/llm.ts", import.meta.url), "utf8");
  assert.match(source, /truncated \? \{ truncated: true, next_step: CHAT_TRUNCATED_NEXT_STEP \}/);
  assert.match(source, /do not set it below about 1024/);
});

test("get_prediction without a charge points the model at charged_usd instead of 'not reported'", () => {
  assert.equal(chargeLine(undefined, undefined), null);
  assert.match(CHARGE_NOT_IN_RECORD, /atlas_list_predictions/);
  assert.match(CHARGE_NOT_IN_RECORD, /charged_usd/);
});

test("S10: the history list asks the model not to add pictures", () => {
  assert.match(LIST_CARD_NOTE, /Do not show any picture/);
});

test("G06: the ChatGPT quote note says one card per reply and one quote per confirmation", () => {
  const source = readFileSync(new URL("../src/apps/generation-quote.ts", import.meta.url), "utf8");
  assert.match(source, /ChatGPT shows only one Atlas card per reply/);
  assert.match(source, /never confirm one quote with another quote's values/);
});
