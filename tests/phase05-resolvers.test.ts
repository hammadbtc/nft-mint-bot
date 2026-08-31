import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mintResolverDescriptors } from "../src/lib/resolvers";

test("Phase 5 registers every launchpad without overstating unsupported integrations", () => {
  const byKey = new Map(mintResolverDescriptors.map((item) => [item.key, item]));
  assert.equal(byKey.get("opensea-seadrop-v1")?.support, "qualified");
  assert.equal(byKey.get("opensea-seadrop-v2")?.mode, "provider-payload");
  assert.equal(byKey.get("scatter")?.mode, "provider-payload");
  assert.equal(byKey.get("launchmynft")?.support, "prefill-only");
  assert.equal(byKey.get("transient")?.support, "manual-review");
  assert.equal(byKey.get("blever-runite")?.support, "manual-review");
  assert.ok(mintResolverDescriptors.every((item) => item.version === "resolver-v1"));
});

test("resolver runs are durable, content addressed, and draft-only", async () => {
  const migration = await readFile(new URL("../drizzle/0010_phase05_resolvers.sql", import.meta.url), "utf8");
  assert.match(migration, /mint_resolver_runs_result_hash_unique/);
  const source = await readFile(new URL("../src/lib/resolvers/index.ts", import.meta.url), "utf8");
  assert.match(source, /certificationRequired: true/);
  assert.doesNotMatch(source, /status:\s*["']active["']/);
});

