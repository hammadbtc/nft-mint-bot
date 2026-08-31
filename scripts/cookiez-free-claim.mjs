import { ethers } from "ethers";

const CHAIN_ID = 4663n;
const CONTRACT = "0x4ba87e60e52c19c1da7dab74414deac4e237c23a";
const TOO_SOON = ethers.id("TooSoon()").slice(0, 10).toLowerCase();
const THROTTLE_POLL_MS = 1_000;
const ABI = [
  "function claimFree()",
  "function balanceOf(address) view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function mintOpen() view returns (bool)",
  "function mintEndedAt() view returns (uint256)",
];

const rpcUrl = process.env.COOKIEZ_RPC_URL?.trim();
const privateKey = process.env.COOKIEZ_PRIVATE_KEY?.trim();
const target = Number(process.env.COOKIEZ_TARGET || "5");
const maxRevertedRaces = Number(process.env.COOKIEZ_MAX_REVERTED_RACES || "20");

if (!rpcUrl) throw new Error("COOKIEZ_RPC_URL is required");
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("COOKIEZ_PRIVATE_KEY must be a 0x-prefixed private key");
if (process.env.COOKIEZ_LIVE !== "I_UNDERSTAND") throw new Error("Set COOKIEZ_LIVE=I_UNDERSTAND to permit live claims");
if (!Number.isSafeInteger(target) || target < 1 || target > 5) throw new Error("COOKIEZ_TARGET must be between 1 and 5");
if (!Number.isSafeInteger(maxRevertedRaces) || maxRevertedRaces < 0 || maxRevertedRaces > 100) throw new Error("COOKIEZ_MAX_REVERTED_RACES must be between 0 and 100");

const provider = new ethers.JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
const wallet = new ethers.Wallet(privateKey, provider);
const contract = new ethers.Contract(CONTRACT, ABI, wallet);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorData(error) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null || seen.has(value)) return null;
    seen.add(value);
    if (typeof value === "string") {
      const match = value.match(/0x[0-9a-fA-F]{8,}/);
      return match?.[0]?.toLowerCase() || null;
    }
    if (typeof value !== "object") return null;
    for (const key of ["data", "cause", "error", "info", "revert", "message", "shortMessage"]) {
      const found = visit(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(error);
}

function safeMessage(error) {
  const message = error instanceof Error ? error.shortMessage || error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[RPC REDACTED]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[SECRET REDACTED]")
    .slice(0, 400);
}

async function waitForClaimWindow() {
  for (;;) {
    try {
      await contract.claimFree.staticCall();
      return;
    } catch (error) {
      if (errorData(error) !== TOO_SOON) throw error;
      process.stdout.write(".");
      await sleep(THROTTLE_POLL_MS);
    }
  }
}

async function main() {
  const [network, code, balance, mintOpen, mintEndedAt, totalMinted, startingOwned] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(CONTRACT),
    provider.getBalance(wallet.address),
    contract.mintOpen(),
    contract.mintEndedAt(),
    contract.totalMinted(),
    contract.balanceOf(wallet.address),
  ]);

  if (network.chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, received ${network.chainId}`);
  if (code === "0x") throw new Error("COOKIEZ contract has no deployed bytecode");
  if (!mintOpen || mintEndedAt !== 0n) throw new Error("COOKIEZ free mint is not open");
  if (startingOwned > BigInt(target)) throw new Error(`Safety stop: wallet already owns ${startingOwned} BAKER(s), above target ${target}`);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log(`Collection minted: ${totalMinted}/10000`);
  console.log(`Starting BAKER balance: ${startingOwned}`);
  console.log(`Target wallet balance: ${target} confirmed BAKERs`);

  let confirmed = Number(startingOwned);
  let revertedRaces = 0;
  while (confirmed < target) {
    process.stdout.write(`\n[${confirmed + 1}/${target}] waiting for claim window`);
    await waitForClaimWindow();
    console.log(" ready");

    try {
      const estimated = await contract.claimFree.estimateGas();
      const tx = await contract.claimFree({ gasLimit: estimated * 120n / 100n });
      console.log(`Submitted: ${tx.hash}`);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw Object.assign(new Error(`Claim transaction reverted: ${tx.hash}`), { receipt });

      const owned = await contract.balanceOf(wallet.address);
      if (owned <= BigInt(confirmed)) throw new Error("Claim receipt succeeded but BAKER balance did not increase");
      confirmed = Number(owned);
      console.log(`Confirmed in block ${receipt.blockNumber}; progress ${confirmed}/${target}`);
    } catch (error) {
      const receipt = error && typeof error === "object" ? error.receipt : null;
      const throttleBeforeBroadcast = errorData(error) === TOO_SOON && !receipt;
      const minedRevert = receipt && Number(receipt.status) === 0;
      if (!throttleBeforeBroadcast && !minedRevert) throw error;
      if (minedRevert) {
        revertedRaces += 1;
        if (revertedRaces > maxRevertedRaces) throw new Error(`Stopped after ${maxRevertedRaces} reverted claim races to protect gas balance`);
        console.log(`Another bot likely won the slot; reverted races ${revertedRaces}/${maxRevertedRaces}`);
      }
      await sleep(THROTTLE_POLL_MS);
    }
  }

  console.log(`\nDone. ${target}/${target} BAKERs confirmed for ${wallet.address}`);
}

main().catch((error) => {
  console.error(`\nStopped safely: ${safeMessage(error)}`);
  process.exitCode = 1;
});
