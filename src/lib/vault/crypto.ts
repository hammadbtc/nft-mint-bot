import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

function getPassphrase(): string {
  const passphrase = process.env.VAULT_PASSPHRASE;
  if (!passphrase) {
    throw new Error("VAULT_PASSPHRASE is required; refusing to access wallet secrets");
  }
  if (passphrase.length < 32) {
    throw new Error("VAULT_PASSPHRASE must be at least 32 characters");
  }
  return passphrase;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
}

/**
 * Encrypt a private key (or mnemonic) string.
 * Returns a hex-encoded payload: salt + iv + authTag + ciphertext
 */
export function encryptPrivateKey(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(getPassphrase(), salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, authTag, encrypted]);
  return payload.toString("hex");
}

/**
 * Decrypt the payload produced by encryptPrivateKey.
 */
export function decryptPrivateKey(hexPayload: string): string {
  const payload = Buffer.from(hexPayload, "hex");

  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(getPassphrase(), salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
