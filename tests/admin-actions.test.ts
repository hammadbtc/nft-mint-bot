import test from "node:test";
import assert from "node:assert/strict";
import { adminPasswordAccepted } from "../src/lib/admin-auth";
import { prepareWalletKeyReplacement } from "../src/lib/vault";
import { mintTaskMutationError } from "../src/lib/task-management";

test("destructive actions require the configured admin password with access-password fallback", () => {
  const previousAdmin = process.env.ADMIN_ACTION_PASSWORD;
  const previousAccess = process.env.APP_ACCESS_PASSWORD;
  const previousSupport = process.env.SUPPORT_ADMIN_TOKEN;
  try {
    process.env.ADMIN_ACTION_PASSWORD = "separate-admin-password";
    process.env.APP_ACCESS_PASSWORD = "browser-access-password";
    process.env.SUPPORT_ADMIN_TOKEN = "support-token";
    assert.equal(adminPasswordAccepted("separate-admin-password"), true);
    assert.equal(adminPasswordAccepted("browser-access-password"), false);
    delete process.env.ADMIN_ACTION_PASSWORD;
    assert.equal(adminPasswordAccepted("browser-access-password"), true);
    assert.equal(adminPasswordAccepted("wrong"), false);
  } finally {
    if (previousAdmin === undefined) delete process.env.ADMIN_ACTION_PASSWORD; else process.env.ADMIN_ACTION_PASSWORD = previousAdmin;
    if (previousAccess === undefined) delete process.env.APP_ACCESS_PASSWORD; else process.env.APP_ACCESS_PASSWORD = previousAccess;
    if (previousSupport === undefined) delete process.env.SUPPORT_ADMIN_TOKEN; else process.env.SUPPORT_ADMIN_TOKEN = previousSupport;
  }
});

test("wallet address replacement derives the address from the encrypted signing key input", () => {
  const previousVault = process.env.VAULT_PASSPHRASE;
  process.env.VAULT_PASSPHRASE = "test-only-vault-passphrase-that-is-long-enough";
  try {
    const privateKey = "0x" + "11".repeat(32);
    const replacement = prepareWalletKeyReplacement({ keyType: "private-key", key: privateKey });
    assert.equal(replacement.address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
    assert.notEqual(replacement.encryptedKey, privateKey);
  } finally {
    if (previousVault === undefined) delete process.env.VAULT_PASSPHRASE; else process.env.VAULT_PASSPHRASE = previousVault;
  }
});

test("only genuinely unsigned pending mint tasks may be edited or deleted", () => {
  assert.equal(mintTaskMutationError("pending", false), null);
  assert.match(mintTaskMutationError("pending", true) || "", /transaction history/i);
  for (const status of ["armed", "running", "confirming", "completed", "failed"]) {
    assert.match(mintTaskMutationError(status, false) || "", /only pending/i);
  }
});
