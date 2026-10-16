import assert from "node:assert/strict";
import { test } from "node:test";
import { shortSessionId } from "./session-display.js";

test("strips hyphens and keeps only the leading characters of a session id", () => {
  assert.equal(shortSessionId("01a09fea-be1e-719b-8948-de94693a4a7a"), "01a09feabe");
});

test("leaves an id shorter than the cutoff untouched", () => {
  assert.equal(shortSessionId("abc"), "abc");
});

test("leaves an id untouched when it is exactly the cutoff after stripping hyphens", () => {
  assert.equal(shortSessionId("01-23-45-6789"), "0123456789");
});

test("returns the empty string for the empty string", () => {
  assert.equal(shortSessionId(""), "");
});
