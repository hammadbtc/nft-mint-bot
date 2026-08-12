import test from "node:test";
import assert from "node:assert/strict";
import { searchCollectionsByName } from "../src/lib/adapters";

const collections = [
  { name:"Cash Rabbits", slug:"cash-rabbits" },
  { name:"CHIMPS HOOD", slug:"chimps-hood" },
  { name:"WEASELS IN STOCK", slug:"weaselsinstock" },
];

test("project search accepts partial names and compact slugs", () => {
  assert.equal(searchCollectionsByName(collections, "weasels")[0]?.name, "WEASELS IN STOCK");
  assert.equal(searchCollectionsByName(collections, "in stock")[0]?.name, "WEASELS IN STOCK");
  assert.equal(searchCollectionsByName(collections, "cashrabbits")[0]?.name, "Cash Rabbits");
  assert.equal(searchCollectionsByName(collections, "chimps")[0]?.name, "CHIMPS HOOD");
});

test("short or unrelated project searches do not guess", () => {
  assert.deepEqual(searchCollectionsByName(collections, "c").map((item) => item.name), []);
  assert.deepEqual(searchCollectionsByName(collections, "not reviewed").map((item) => item.name), []);
});

test("exact names rank ahead of broader partial matches", () => {
  const overlapping = [...collections, { name:"Cash Rabbits Reloaded", slug:"cash-rabbits-reloaded" }];
  assert.equal(searchCollectionsByName(overlapping, "cash rabbits")[0]?.name, "Cash Rabbits");
});
