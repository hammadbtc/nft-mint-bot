import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to stage supported projects");
const projects = JSON.parse(await readFile(new URL("../config/supported-projects.json", import.meta.url), "utf8"));
const disabledProjects = JSON.parse(await readFile(new URL("../config/disabled-projects.json", import.meta.url), "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });

function stableJson(value) {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function snapshot(row) {
  return {
    schemaVersion: 1,
    collectionId: row.id,
    name: row.name,
    contractAddress: row.contract_address,
    chainId: row.chain_id,
    mintMethod: row.mint_method,
    mintAbi: row.mint_abi,
    mintPrice: row.mint_price,
    maxPerWallet: row.max_per_wallet,
    maxSupply: row.max_supply,
    defaultGasLimit: row.default_gas_limit,
    defaultMaxFeePerGas: row.default_max_fee_per_gas,
    defaultMaxPriorityFeePerGas: row.default_max_priority_fee_per_gas,
    defaultUseFlashbots: row.default_use_flashbots,
    fcfsEnabled: row.fcfs_enabled,
    fcfsMintOpenSignature: row.fcfs_mint_open_signature,
    paymentToken: row.payment_token,
    safetyCheck: row.safety_check,
    slug: row.slug,
    adapterKey: row.adapter_key,
    domains: row.domains,
    siteUrl: row.site_url,
    imageUrl: row.image_url,
    adapterConfig: row.adapter_config,
  };
}

function proposedRow(current, project) {
  return {
    ...current,
    id: project.id,
    name: project.name,
    slug: project.slug,
    contract_address: project.contractAddress,
    chain_id: project.chainId,
    mint_method: project.mintMethod,
    mint_abi: JSON.stringify(project.mintAbi),
    mint_price: project.mintPrice ?? null,
    max_per_wallet: project.maxPerWallet ?? null,
    max_supply: project.maxSupply ?? null,
    payment_token: project.paymentToken ?? null,
    adapter_key: project.adapterKey,
    domains: JSON.stringify(project.domains),
    site_url: project.siteUrl ?? null,
    image_url: project.imageUrl ?? null,
    adapter_config: JSON.stringify(project.adapterConfig),
  };
}

try {
  for (const project of disabledProjects) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`mint-definition:${project.id}`}))`;
      await tx`update collections set active = false, verified = false, broadcast_paused = true,
        broadcast_pause_reason = 'Project disabled by reviewed configuration', broadcast_pause_updated_at = now()
        where id = ${project.id}`;
      await tx`update mint_definition_versions set status = 'retired', updated_at = now()
        where collection_id = ${project.id} and status = 'active'`;
    });
    console.log(`Disabled supported mint: ${project.name}`);
  }

  for (const project of projects) {
    const result = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`mint-definition:${project.id}`}))`;
      let [collection] = await tx`select * from collections where id = ${project.id} limit 1`;
      if (!collection) {
        [collection] = await tx`
          insert into collections (
            id, name, slug, contract_address, chain_id, mint_method, mint_abi, mint_price,
            max_per_wallet, max_supply, payment_token, adapter_key, domains, site_url, image_url,
            adapter_config, verified, active, broadcast_paused, broadcast_pause_reason, broadcast_pause_updated_at
          ) values (
            ${project.id}, ${project.name}, ${project.slug}, ${project.contractAddress}, ${project.chainId},
            ${project.mintMethod}, ${JSON.stringify(project.mintAbi)}, ${project.mintPrice ?? null},
            ${project.maxPerWallet ?? null}, ${project.maxSupply ?? null}, ${project.paymentToken ?? null}, ${project.adapterKey},
            ${JSON.stringify(project.domains)}, ${project.siteUrl ?? null}, ${project.imageUrl ?? null}, ${JSON.stringify(project.adapterConfig)},
            false, false, true, 'Seeded definition requires certification and activation', now()
          ) returning *
        `;
      }

      // Configuration files are an intake source only. They may create an
      // immutable draft, but never mutate live execution fields, certify, or
      // activate a definition during deployment.
      const definition = snapshot(proposedRow(collection, project));
      const definitionJson = stableJson(definition);
      const definitionHash = stableHash(definition);
      const [existing] = await tx`select id, status from mint_definition_versions
        where collection_id = ${project.id} and definition_hash = ${definitionHash} limit 1`;
      if (existing) return { status: existing.status, created: false };

      const [{ version }] = await tx`select coalesce(max(version), 0) + 1 as version
        from mint_definition_versions where collection_id = ${project.id}`;
      await tx`insert into mint_definition_versions (
        id, collection_id, version, status, definition_json, definition_hash, engine_version, source
      ) values (
        ${randomUUID()}, ${project.id}, ${Number(version)}, 'draft', ${definitionJson}, ${definitionHash},
        'mint-definition-v1', 'seed'
      )`;
      return { status: "draft", created: true };
    });
    console.log(`${result.created ? "Staged" : "Preserved"} supported mint ${project.name} as ${result.status}; no deploy-time activation performed`);
  }
} finally {
  await sql.end();
}
