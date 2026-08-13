import test from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { wallets } from "../src/lib/db/schema";

test("wallet schema allows multiple main wallets per chain while addresses stay unique", () => {
  const config = getTableConfig(wallets);
  const indexNames = config.indexes.map((index) => index.config.name);
  assert.equal(indexNames.includes("wallets_one_main_per_chain"), false);
  assert.equal(indexNames.includes("wallets_chain_address_unique"), true);
  assert.equal(config.indexes.find((index) => index.config.name === "wallets_chain_address_unique")?.config.unique, true);
});
