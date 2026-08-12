import test from "node:test";
import assert from "node:assert/strict";
import { decryptPrivateKey, encryptPrivateKey } from "../src/lib/vault/crypto";

test("wallet secret encryption round-trips and uses randomized ciphertext", () => {
  process.env.VAULT_PASSPHRASE = "unit-test-vault-passphrase-at-least-32-characters";
  const secret = "0x0123456789abcdef";
  const first = encryptPrivateKey(secret);
  const second = encryptPrivateKey(secret);
  assert.notEqual(first, second);
  assert.equal(decryptPrivateKey(first), secret);
  assert.equal(decryptPrivateKey(second), secret);
});

test("wallet encryption fails closed without a passphrase", () => {
  const previous = process.env.VAULT_PASSPHRASE;
  delete process.env.VAULT_PASSPHRASE;
  assert.throws(() => encryptPrivateKey("secret"), /VAULT_PASSPHRASE is required/);
  if (previous) process.env.VAULT_PASSPHRASE = previous;
});
