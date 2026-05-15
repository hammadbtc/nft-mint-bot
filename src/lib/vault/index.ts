import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "@/lib/db";
import { encryptPrivateKey, decryptPrivateKey } from "./crypto";
import { eq, and } from "drizzle-orm";

export interface WalletImport {
  label: string;
  chainId: number;
  keyType: "private-key" | "mnemonic";
  key: string; // raw private key or mnemonic
  hdPath?: string; // BIP44 derivation path, e.g. "m/44'/60'/0'/0/0" (default for first ETH account)
}

/**
 * Import a wallet: derive address from key/mnemonic, encrypt the raw key, store in DB.
 * For mnemonics, uses HD derivation with configurable path.
 */
export async function importWallet(input: WalletImport) {
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  let address: string;

  if (input.keyType === "mnemonic") {
    // Use HD derivation
    const hdPath = input.hdPath || "m/44'/60'/0'/0/0"; // default: first ETH account (MetaMask standard)
    const hdWallet = ethers.HDNodeWallet.fromPhrase(input.key, undefined, hdPath);
    address = hdWallet.address;
    wallet = hdWallet;
  } else {
    wallet = new ethers.Wallet(input.key);
    address = wallet.address;
  }

  const encrypted = encryptPrivateKey(input.key);
  const id = uuidv4();

  await db.insert(schema.wallets).values({
    id,
    label: input.label,
    address,
    chainId: input.chainId,
    encryptedKey: encrypted,
    keyFormat: input.keyType,
  });

  return {
    id,
    label: input.label,
    address,
    chainId: input.chainId,
    keyFormat: input.keyType,
  };
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
    wallet = ethers.Wallet.fromPhrase(rawKey);
  } else {
    wallet = new ethers.Wallet(rawKey);
  }

  return wallet.connect(provider) as ethers.Wallet;
}

/**
 * List wallets (without keys).
 */
export async function listWallets(chainId?: number) {
  const conditions = [];
  if (chainId !== undefined) {
    conditions.push(eq(schema.wallets.chainId, chainId));
  }

  const rows = await db
    .select({
      id: schema.wallets.id,
      label: schema.wallets.label,
      address: schema.wallets.address,
      chainId: schema.wallets.chainId,
      keyFormat: schema.wallets.keyFormat,
      active: schema.wallets.active,
      createdAt: schema.wallets.createdAt,
    })
    .from(schema.wallets)
    .where(conditions.length ? and(...conditions) : undefined);

  return rows;
}

/**
 * Delete a wallet and its encrypted key.
 */
export async function deleteWallet(walletId: string) {
  await db.delete(schema.wallets).where(eq(schema.wallets.id, walletId));
}
