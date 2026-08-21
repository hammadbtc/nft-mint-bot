import postgres from "postgres";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is required to migrate wallet nonce state");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

try {
  await sql.begin(async (tx) => {
    await tx.unsafe('lock table "wallet_nonce_state" in access exclusive mode');

    const duplicates = await tx.unsafe(`
      select wallet_id, chain_id, count(*)::int as count
      from wallet_nonce_state
      group by wallet_id, chain_id
      having count(*) > 1
      limit 1
    `);
    if (duplicates.length > 0) {
      throw new Error("wallet_nonce_state contains duplicate wallet/chain rows; refusing automatic migration");
    }

    const primaryKeyColumns = await tx.unsafe(`
      select array_agg(a.attname order by k.ordinality)::text[] as columns
      from pg_constraint c
      join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conrelid = 'wallet_nonce_state'::regclass and c.contype = 'p'
      group by c.oid
    `);

    const columns = primaryKeyColumns[0]?.columns || [];
    if (columns.join(",") !== "wallet_id,chain_id") {
      await tx.unsafe('alter table "wallet_nonce_state" drop constraint if exists "wallet_nonce_state_pkey"');
      await tx.unsafe('alter table "wallet_nonce_state" add constraint "wallet_nonce_state_pkey" primary key ("wallet_id", "chain_id")');
    }

    await tx.unsafe('drop index if exists "wallets_chain_address_unique"');
    await tx.unsafe('create unique index if not exists "wallets_address_unique" on "wallets" (lower("address"))');
  });

  console.log("Multichain wallet nonce schema is ready");
} finally {
  await sql.end();
}
