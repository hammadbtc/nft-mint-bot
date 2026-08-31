import { ethers } from "ethers";
import { decryptSecret, encryptSecret } from "@/lib/vault/crypto";

const PREFIX = "vault:v1:";

export function signedTransactionIsSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function sealSignedTransaction(rawTx: string): string {
  if (!ethers.isHexString(rawTx) || rawTx === "0x") throw new Error("Signed transaction payload is invalid");
  return `${PREFIX}${encryptSecret(rawTx)}`;
}

export function openSignedTransaction(value: string): string {
  if (!signedTransactionIsSealed(value)) throw new Error("Signed transaction payload is not encrypted at rest");
  const rawTx = decryptSecret(value.slice(PREFIX.length));
  if (!ethers.isHexString(rawTx) || rawTx === "0x") throw new Error("Decrypted signed transaction payload is invalid");
  return rawTx;
}
