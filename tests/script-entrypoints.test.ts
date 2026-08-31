import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runWithoutProductionSecrets(scriptPath: string): string {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.VAULT_PASSPHRASE;
  delete environment.CERTIFICATION_RPC_URL;
  delete environment.CERTIFICATION_ATTESTATION_KEY;
  const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(result.status, null, result.error?.message);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /Top-level await is currently not supported|Transform failed/);
  return output;
}

test("operational TypeScript scripts load in the production CommonJS package", () => {
  assert.match(runWithoutProductionSecrets("scripts/encrypt-signed-transactions.ts"), /DATABASE_URL is required/);
  assert.match(runWithoutProductionSecrets("scripts/run-definition-certification.ts"), /Usage: npm run support:certify-definition/);
});
