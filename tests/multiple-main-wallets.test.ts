import test from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { walletNonceState, wallets } from "../src/lib/db/schema";

test("wallet schema stores each EVM address once while allowing multiple main wallets", () => {
  const config = getTableConfig(wallets);
  const indexNames = config.indexes.map((index) => index.config.name);
  assert.equal(indexNames.includes("wallets_one_main_per_chain"), false);
  assert.equal(indexNames.includes("wallets_address_unique"), true);
  assert.equal(config.indexes.find((index) => index.config.name === "wallets_address_unique")?.config.unique, true);
});

test("wallet nonces are isolated per EVM chain", () => {
  const config = getTableConfig(walletNonceState);
  assert.equal(config.primaryKeys.length, 1);
  assert.deepEqual(config.primaryKeys[0]?.columns.map((column) => column.name), ["wallet_id", "chain_id"]);
});
