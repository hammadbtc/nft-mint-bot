import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getProvider } from "@/lib/chains";
import { batchMint } from "@/lib/engine/mint";
import { sendAlert } from "@/lib/alerting";
import { eq, and } from "drizzle-orm";

// Track which collections we're already watching
const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Start watching a collection for its mint-open event.
 * When the event fires, auto-creates mint jobs for all active wallets on that chain.
 */
export async function startFcfsWatcher(collectionId: string) {
  if (activeWatchers.has(collectionId)) return; // already watching

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);

  if (!collection || !collection.fcfsEnabled) return;
  if (!collection.fcfsMintOpenSignature) {
    console.warn(`FCFS enabled but no event signature for collection ${collection.name}`);
    return;
  }

  const provider = getProvider(collection.chainId);

  // Parse the event signature to get the topic
  const topic = ethers.id(collection.fcfsMintOpenSignature);

  console.log(`👁️ FCFS watcher started for ${collection.name} (topic: ${topic})`);

  // Poll every 500ms — for competitive mints, block polling is not fast enough
  // but it works for most public mints
  let lastCheckedBlock = await provider.getBlockNumber();

  const interval = setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;

      // Check logs between last block and current
      const logs = await provider.getLogs({
        address: collection.contractAddress,
        topics: [topic],
        fromBlock: lastCheckedBlock + 1,
        toBlock: currentBlock,
      });

      lastCheckedBlock = currentBlock;

      if (logs.length > 0) {
        console.log(`🔥 FCFS triggered! ${collection.name} — ${logs.length} events`);

        await sendAlert(
          "fcfs_triggered",
          `FCFS triggered for ${collection.name}! Auto-minting with all active wallets.`,
          undefined
        );

        // Find all active wallets on this chain
        const wallets = await db
          .select({ id: schema.wallets.id })
          .from(schema.wallets)
          .where(
            and(
              eq(schema.wallets.chainId, collection.chainId),
              eq(schema.wallets.active, true)
            )
          );

        if (wallets.length === 0) {
          console.warn(`FCFS triggered but no active wallets for chain ${collection.chainId}`);
          return;
        }

        // Auto-batch mint with all wallets
        const walletIds = wallets.map((w) => w.id);
        const useFlashbots = collection.defaultUseFlashbots ?? false;

        await batchMint(collectionId, walletIds, 1, useFlashbots, false);

        console.log(`✅ FCFS batch mint dispatched: ${walletIds.length} wallets → ${collection.name}`);
      }
    } catch (err) {
      console.error(`FCFS watcher error for ${collection.name}:`, err);
    }
  }, 500);

  activeWatchers.set(collectionId, interval);
}

export function stopFcfsWatcher(collectionId: string) {
  const interval = activeWatchers.get(collectionId);
  if (interval) {
    clearInterval(interval);
    activeWatchers.delete(collectionId);
  }
}

export function stopAllFcfsWatchers() {
  for (const [id, interval] of activeWatchers) {
    clearInterval(interval);
  }
  activeWatchers.clear();
}

/**
 * Restart FCFS watchers for all enabled collections (called on server start).
 */
export async function restartAllFcfsWatchers() {
  stopAllFcfsWatchers();

  const fcfsCollections = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.fcfsEnabled, true));

  for (const col of fcfsCollections) {
    await startFcfsWatcher(col.id);
  }

  console.log(`👁️ Restarted ${fcfsCollections.length} FCFS watchers`);
}

/**
 * Get FCFS watcher status.
 */
export function getFcfsWatcherStatus(): { collectionId: string; watching: boolean }[] {
  return Array.from(activeWatchers.keys()).map((id) => ({
    collectionId: id,
    watching: true,
  }));
}
