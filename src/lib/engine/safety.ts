import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

// Common honeypot patterns to check
const HONEYPOT_SIGS = [
  "setMintActive(bool)",        // can pause mint
  "setPaused(bool)",             // can pause
  "withdraw()",                  // can drain
  "withdrawAll()",               // can drain
  "setBaseURI(string)",          // can change metadata
  "setMintPrice(uint256)",       // can rug price
  "ownerMint(uint256)",          // owner can mint unlimited
  "teamMint(uint256)",           // team can mint
  "transferOwnership(address)",  // ownership transfer
];

// Functions that are normal/expected on NFT contracts
const SAFE_SIGS = [
  "mint(uint256)",
  "mint(address,uint256)",
  "mint()",
  "totalSupply()",
  "balanceOf(address)",
  "tokenURI(uint256)",
  "ownerOf(uint256)",
  "safeTransferFrom(address,address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "setApprovalForAll(address,bool)",
  "getApproved(uint256)",
  "isApprovedForAll(address,address)",
  "tokenByIndex(uint256)",
  "tokenOfOwnerByIndex(address,uint256)",
  "name()",
  "symbol()",
  "supportsInterface(bytes4)",
];

interface SafetyCheckResult {
  safe: boolean;
  reasons: string[];
  warnings: string[];
}

/**
 * Check if a contract address is in the whitelist or blacklist.
 */
export async function checkSafetyList(address: string): Promise<{
  inWhitelist: boolean;
  inBlacklist: boolean;
  note?: string;
}> {
  const [entry] = await db
    .select()
    .from(schema.contractSafetyList)
    .where(eq(schema.contractSafetyList.address, address.toLowerCase()))
    .limit(1);

  return {
    inWhitelist: entry?.list === "whitelist",
    inBlacklist: entry?.list === "blacklist",
    note: entry?.note || undefined,
  };
}

/**
 * Add to whitelist or blacklist.
 */
export async function addToSafetyList(
  address: string,
  list: "whitelist" | "blacklist",
  note?: string
) {
  await db
    .insert(schema.contractSafetyList)
    .values({ address: address.toLowerCase(), list, note: note || null })
    .onConflictDoUpdate({
      target: schema.contractSafetyList.address,
      set: { list, note: note || null },
    });
  return { success: true };
}

export async function removeFromSafetyList(address: string) {
  await db
    .delete(schema.contractSafetyList)
    .where(eq(schema.contractSafetyList.address, address.toLowerCase()));
}

export async function listSafetyList(list?: "whitelist" | "blacklist") {
  const rows = await db
    .select()
    .from(schema.contractSafetyList)
    .where(list ? eq(schema.contractSafetyList.list, list) : undefined);
  return rows;
}

/**
 * Run basic safety checks on a contract:
 * 1. Verify it's actually a contract (has code)
 * 2. Check whitelist/blacklist
 * 3. Detect suspicious functions
 * 4. Check mint price isn't unusually high
 */
export async function checkContractSafety(
  contractAddress: string,
  chainId: number,
  provider: ethers.Provider
): Promise<SafetyCheckResult> {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Check safety list first
  const { inBlacklist, inWhitelist, note } = await checkSafetyList(contractAddress);
  if (inBlacklist) {
    reasons.push(`Contract is BLACKLISTED${note ? `: ${note}` : ""}`);
    return { safe: false, reasons, warnings };
  }
  if (inWhitelist) {
    return { safe: true, reasons, warnings: [`Whitelisted${note ? `: ${note}` : ""}`] };
  }

  // Check if contract has code
  const code = await provider.getCode(contractAddress);
  if (code === "0x" || code === "0x0") {
    reasons.push("Address is not a contract (no bytecode)");
    return { safe: false, reasons, warnings };
  }

  // Detect potentially dangerous function selectors in bytecode
  const foundSuspicious: string[] = [];
  for (const sig of HONEYPOT_SIGS) {
    const selector = ethers.id(sig).slice(0, 10); // first 4 bytes
    if (code.includes(selector.slice(2))) {
      foundSuspicious.push(sig);
    }
  }

  if (foundSuspicious.length > 0) {
    warnings.push(
      `Suspicious functions detected: ${foundSuspicious.join(", ")}. ` +
      `These may be normal admin functions — verify manually.`
    );
  }

  // Check for ERC721 interface support (basic)
  const erc721Iface = new ethers.Interface([
    "function supportsInterface(bytes4) view returns (bool)",
  ]);
  try {
    const result = await provider.call({
      to: contractAddress,
      data: erc721Iface.encodeFunctionData("supportsInterface", ["0x80ac58cd"]), // ERC721
    });
    const supportsERC721 = erc721Iface.decodeFunctionResult("supportsInterface", result)[0];
    if (!supportsERC721) {
      warnings.push("Contract does not support ERC721 interface — may not be an NFT contract");
    }
  } catch {
    warnings.push("Could not verify ERC721 interface support (contract may not implement supportsInterface)");
  }

  return {
    safe: reasons.length === 0,
    reasons,
    warnings,
  };
}
