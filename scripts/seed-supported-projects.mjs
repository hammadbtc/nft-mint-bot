import postgres from "postgres";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to seed supported projects");
const projects = JSON.parse(await readFile(new URL("../config/supported-projects.json", import.meta.url), "utf8"));
const disabledProjects = JSON.parse(await readFile(new URL("../config/disabled-projects.json", import.meta.url), "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });

try {
  for (const project of disabledProjects) {
    await sql`update collections set active = false, verified = false where id = ${project.id}`;
    console.log(`Disabled supported mint: ${project.name}`);
  }
  for (const project of projects) {
    await sql`
      insert into collections (
        id, name, slug, contract_address, chain_id, mint_method, mint_abi, mint_price,
        max_per_wallet, max_supply, adapter_key, domains, site_url, image_url,
        adapter_config, verified, active
      ) values (
        ${project.id}, ${project.name}, ${project.slug}, ${project.contractAddress}, ${project.chainId},
        ${project.mintMethod}, ${JSON.stringify(project.mintAbi)}, ${project.mintPrice},
        ${project.maxPerWallet}, ${project.maxSupply}, ${project.adapterKey}, ${JSON.stringify(project.domains)},
        ${project.siteUrl ?? null}, ${project.imageUrl ?? null}, ${JSON.stringify(project.adapterConfig)}, true, true
      )
      on conflict (id) do update set
        name = excluded.name, slug = excluded.slug, contract_address = excluded.contract_address,
        chain_id = excluded.chain_id, mint_method = excluded.mint_method, mint_abi = excluded.mint_abi,
        mint_price = excluded.mint_price, max_per_wallet = excluded.max_per_wallet,
        max_supply = excluded.max_supply, adapter_key = excluded.adapter_key, domains = excluded.domains,
        site_url = excluded.site_url, image_url = excluded.image_url,
        adapter_config = excluded.adapter_config, verified = true, active = true
    `;
    console.log(`Seeded supported mint: ${project.name}`);
  }
} finally {
  await sql.end();
}
