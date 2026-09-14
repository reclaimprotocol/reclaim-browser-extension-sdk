import assert from "node:assert/strict";
import { test } from "node:test";
import { shortSessionId } from "./session-display.js";

test("keeps only the leading characters of a session id", () => {
  assert.equal(shortSessionId("01a09fea-be1e-719b-8948-de94693a4a7a"), "01a09fea-b…");
});

test("leaves a short id untouched", () => {
  assert.equal(shortSessionId("abc"), "abc");
  assert.equal(shortSessionId("0123456789"), "0123456789");
});

test("returns an empty string when there is no session id", () => {
  assert.equal(shortSessionId(undefined), "");
  assert.equal(shortSessionId(null), "");
});
