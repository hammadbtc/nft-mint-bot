import test from "node:test";
import assert from "node:assert/strict";
import { executionRole, runsExecutionWorker, servesWeb } from "../src/lib/execution-role";

test("execution roles separate web and transaction execution", () => {
  assert.equal(executionRole(undefined), "combined");
  assert.equal(executionRole(" web "), "web");
  assert.equal(runsExecutionWorker("web"), false);
  assert.equal(runsExecutionWorker("worker"), true);
  assert.equal(servesWeb("worker"), false);
  assert.equal(servesWeb("combined"), true);
  assert.throws(() => executionRole("invalid"), /web, worker, or combined/);
});
