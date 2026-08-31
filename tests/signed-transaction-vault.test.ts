import assert from "node:assert/strict";
import test from "node:test";
import {
  openSignedTransaction,
  sealSignedTransaction,
  signedTransactionIsSealed,
} from "../src/lib/signed-transaction-vault";

test("signed transactions are randomized, authenticated, and never accepted as plaintext", () => {
  const previous = process.env.VAULT_PASSPHRASE;
  process.env.VAULT_PASSPHRASE = "test-only-vault-passphrase-with-more-than-32-characters";
  try {
    const rawTx = "0x02aabbcc";
    const left = sealSignedTransaction(rawTx);
    const right = sealSignedTransaction(rawTx);
    assert.equal(signedTransactionIsSealed(left), true);
    assert.notEqual(left, right);
    assert.equal(openSignedTransaction(left), rawTx);
    assert.throws(() => openSignedTransaction(rawTx), /not encrypted at rest/);
    assert.throws(() => openSignedTransaction(`${left.slice(0, -1)}0`));
  } finally {
    if (previous === undefined) delete process.env.VAULT_PASSPHRASE; else process.env.VAULT_PASSPHRASE = previous;
  }
});
