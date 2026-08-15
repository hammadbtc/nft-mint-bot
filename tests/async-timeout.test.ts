import test from "node:test";
import assert from "node:assert/strict";
import { OperationTimeoutError, withTimeout } from "../src/lib/async-timeout";

test("withTimeout returns a completed operation", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "late"), "ok");
});

test("withTimeout rejects a stuck operation without waiting forever", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 5, "eligibility timed out"),
    (error) => error instanceof OperationTimeoutError && error.message === "eligibility timed out",
  );
});
