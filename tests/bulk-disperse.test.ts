import assert from "node:assert/strict";
import test from "node:test";
import { reviewedBulkDisperseFor, validateReviewedBulkDisperse } from "../src/lib/bulk-disperse";

test("bulk Disperse approvals require exact code hash, audit, and verified source metadata", () => {
  assert.doesNotThrow(() => validateReviewedBulkDisperse({
    chainId: 4663,
    address: "0x1111111111111111111111111111111111111111",
    runtimeCodeHash: `0x${"11".repeat(32)}`,
    auditUrl: "https://auditor.example/report.pdf",
    verifiedSourceUrl: "https://explorer.example/address/0x1111111111111111111111111111111111111111",
  }));
  assert.throws(() => validateReviewedBulkDisperse({
    chainId: 4663,
    address: "0x1111111111111111111111111111111111111111",
    runtimeCodeHash: "0x1234",
    auditUrl: "https://auditor.example/report.pdf",
    verifiedSourceUrl: "https://explorer.example/source",
  }), /code hash/);
  assert.equal(reviewedBulkDisperseFor(4663), null);
});
