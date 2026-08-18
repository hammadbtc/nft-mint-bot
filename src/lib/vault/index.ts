import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "@/lib/db";
import { encryptPrivateKey, decryptPrivateKey } from "./crypto";
import { eq, sql } from "drizzle-orm";

export interface WalletImport {
  label: string;
  chainId: number;
  keyType: "private-key" | "mnemonic";
  key: string; // raw private key or mnemonic
  hdPath?: string; // BIP44 derivation path
  spendLimit?: string; // max spend in wei (null = unlimited)
  role?: "main" | "worker";
  parentWalletId?: string;
}

export function prepareWalletRecord(input: WalletImport) {
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  const hdPath = input.keyType === "mnemonic" ? input.hdPath || "m/44'/60'/0'/0/0" : null;
  if (input.keyType === "mnemonic") wallet = ethers.HDNodeWallet.fromPhrase(input.key, undefined, hdPath!);
  else wallet = new ethers.Wallet(input.key);

  const id = uuidv4();
  return {
    record: {
      id,
      label: input.label,
      address: wallet.address,
      chainId: input.chainId,
      encryptedKey: encryptPrivateKey(input.key),
      keyFormat: input.keyType,
      spendLimit: input.spendLimit || null,
      hdPath,
      role: input.role || "worker",
      parentWalletId: input.parentWalletId || null,
    },
    publicWallet: { id, label: input.label, address: wallet.address, chainId: input.chainId, keyFormat: input.keyType },
  };
}

export function prepareWalletKeyReplacement(input: Pick<WalletImport, "keyType" | "key" | "hdPath">) {
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  const hdPath = input.keyType === "mnemonic" ? input.hdPath || "m/44'/60'/0'/0/0" : null;
  if (input.keyType === "mnemonic") wallet = ethers.HDNodeWallet.fromPhrase(input.key, undefined, hdPath!);
  else wallet = new ethers.Wallet(input.key);
  return {
    address: wallet.address,
    encryptedKey: encryptPrivateKey(input.key),
    keyFormat: input.keyType,
    hdPath,
  };
}

/**
 * Import a wallet: derive address from key/mnemonic, encrypt the raw key, store in DB.
 * For mnemonics, uses HD derivation with configurable path.
 */
export async function importWallet(input: WalletImport) {
  const prepared = prepareWalletRecord(input);
  const [existing] = await db.select({ id: schema.wallets.id }).from(schema.wallets)
    .where(sql`lower(${schema.wallets.address}) = lower(${prepared.record.address})`).limit(1);
  if (existing) throw new Error("This EVM wallet is already imported and works on every supported network");
  await db.insert(schema.wallets).values(prepared.record);
  return prepared.publicWallet;
}

/**
 * Derive a list of addresses from a mnemonic (for preview before import).
 * Returns addresses 0-9 on the default ETH path.
 */
export function deriveMnemonicAddresses(
  mnemonic: string,
  count = 10,
  basePath = "m/44'/60'/0'/0"
): { index: number; path: string; address: string }[] {
  const results: { index: number; path: string; address: string }[] = [];
  for (let i = 0; i < count; i++) {
    const path = `${basePath}/${i}`;
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    results.push({ index: i, path, address: wallet.address });
  }
  return results;
}

/**
 * Get a decrypted ethers Wallet instance for signing.
 * Never logs or returns the raw key.
 */
export async function getSigner(walletId: string, provider: ethers.Provider): Promise<ethers.Wallet> {
  const rows = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.id, walletId))
    .limit(1);

  if (!rows.length) throw new Error(`Wallet ${walletId} not found`);

  const record = rows[0];
  const rawKey = decryptPrivateKey(record.encryptedKey);

  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  if (record.keyFormat === "mnemonic") {
    const hdPath = record.hdPath || "m/44'/60'/0'/0/0";
    wallet = ethers.HDNodeWallet.fromPhrase(rawKey, undefined, hdPath);
  } else {
    wallet = new ethers.Wallet(rawKey);
  }

  return wallet.connect(provider) as ethers.Wallet;
}

/** Return a wallet's raw imported secret after the caller has performed authorization. */
export async function getWalletSecret(walletId: string) {
  const [record] = await db.select({ encryptedKey: schema.wallets.encryptedKey, keyFormat: schema.wallets.keyFormat })
    .from(schema.wallets).where(eq(schema.wallets.id, walletId)).limit(1);
  if (!record) return null;
  return { secret: decryptPrivateKey(record.encryptedKey), keyFormat: record.keyFormat };
}

/**
 * List wallets (without keys).
 */
export async function listWallets(chainId?: number) {
  void chainId;

  const rows = await db
    .select({
      id: schema.wallets.id,
      label: schema.wallets.label,
      address: schema.wallets.address,
      chainId: schema.wallets.chainId,
      keyFormat: schema.wallets.keyFormat,
      active: schema.wallets.active,
      spendLimit: schema.wallets.spendLimit,
      hdPath: schema.wallets.hdPath,
      role: schema.wallets.role,
      parentWalletId: schema.wallets.parentWalletId,
      createdAt: schema.wallets.createdAt,
    })
    .from(schema.wallets);

  return rows;
}

/**
 * Delete a wallet and its encrypted key.
 */
export async function deleteWallet(walletId: string) {
  await db.delete(schema.wallets).where(eq(schema.wallets.id, walletId));
}
