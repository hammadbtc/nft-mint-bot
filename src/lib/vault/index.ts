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
}

/**
 * Import a wallet: derive address, encrypt the key, store in DB.
 * Returns the created wallet record.
 */
export async function importWallet(input: WalletImport) {
  let wallet: ethers.Wallet | ethers.HDNodeWallet;

  if (input.keyType === "mnemonic") {
    wallet = ethers.Wallet.fromPhrase(input.key) as unknown as ethers.Wallet;
  } else {
    wallet = new ethers.Wallet(input.key);
  }

  const encrypted = encryptPrivateKey(input.key);
  const id = uuidv4();

  await db.insert(schema.wallets).values({
    id,
    label: input.label,
    address: wallet.address,
    chainId: input.chainId,
    encryptedKey: encrypted,
    keyFormat: input.keyType,
  });

  // Return without the encrypted key
  return {
    id,
    label: input.label,
    address: wallet.address,
    chainId: input.chainId,
    keyFormat: input.keyType,
  };
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
 * Get raw decrypted key (use sparingly — only when ethers.Wallet won't work).
 */
export function getRawKey(walletId: string): string {
  const rows = db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.id, walletId))
    .limit(1)
    .all();

  if (!rows.length) throw new Error(`Wallet ${walletId} not found`);
  return decryptPrivateKey(rows[0].encryptedKey);
}

/**
 * List all wallets (without keys).
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
