import assert from "node:assert/strict";
import test from "node:test";
import { formatContractTime } from "../src/lib/format-contract-time";

test("formats a valid contract timestamp without crashing the mint page", () => {
  const result = formatContractTime("2026-08-12T20:30:52.000Z");

  assert.match(result, /2026/);
  assert.notEqual(result, "Contract schedule unavailable");
});

test("handles missing and malformed contract timestamps safely", () => {
  assert.equal(formatContractTime(null), "Runs immediately (mint is live)");
  assert.equal(formatContractTime("not-a-date"), "Contract schedule unavailable");
});
