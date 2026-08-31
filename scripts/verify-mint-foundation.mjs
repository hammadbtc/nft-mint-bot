import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to verify the mint foundation");
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });

try {
  const requiredTables = [
    "mint_definition_versions",
    "mint_certifications",
    "mint_definition_activations",
    "mint_phase_controls",
    "mint_control_events",
    "mint_payload_artifacts",
    "mint_eligibility_artifacts",
    "mint_resolver_runs",
    "mint_cutover_states",
    "mint_shadow_comparisons",
    "mint_incident_bundles",
  ];
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_name = any(${requiredTables})
  `;
  const presentTables = new Set(tables.map((row) => row.table_name));
  const missingTables = requiredTables.filter((table) => !presentTables.has(table));
  if (missingTables.length) throw new Error(`Missing Phase 0-2 tables: ${missingTables.join(", ")}`);

  const requiredTriggers = [
    "mint_definition_identity_immutable_trigger",
    "mint_definition_status_transition_valid_trigger",
    "mint_definition_activation_has_certificate_trigger",
    "mint_certification_evidence_immutable_trigger",
    "mint_job_definition_pin_immutable_trigger",
    "mint_eligibility_artifact_identity_immutable_trigger",
    "mint_job_eligibility_pin_immutable_trigger",
    "mint_job_eligibility_pin_valid_trigger",
    "mint_cutover_candidate_immutable_trigger",
    "mint_cutover_status_transition_valid_trigger",
    "mint_broadcast_release_valid_trigger",
  ];
  const triggers = await sql`
    select tgname from pg_trigger where not tgisinternal and tgname = any(${requiredTriggers})
  `;
  const presentTriggers = new Set(triggers.map((row) => row.tgname));
  const missingTriggers = requiredTriggers.filter((trigger) => !presentTriggers.has(trigger));
  if (missingTriggers.length) throw new Error(`Missing Phase 2 safety triggers: ${missingTriggers.join(", ")}`);

  const [invariants] = await sql`
    select
      (select count(*)::int from mint_jobs
        where status in ('pending','armed','running','confirming')
          and (definition_version_id is null or definition_hash is null or definition_snapshot is null)) as unpinned_jobs,
      (select count(*)::int from collections c
        where c.active and c.verified and c.broadcast_paused = false and not exists (
          select 1 from mint_definition_versions v where v.collection_id = c.id and v.status = 'active'
        )) as released_collections_without_active_definition,
      (select count(*)::int from mint_definition_versions v
        join collections c0 on c0.id = v.collection_id
        where v.status = 'active' and c0.broadcast_paused = false and not exists (
          select 1 from mint_certifications c
          where c.definition_version_id = v.id and c.definition_hash = v.definition_hash
            and c.status = 'passed' and c.runner_version = 'mint-certifier-v1'
            and c.expires_at::timestamptz > now()
        )) as active_definitions_without_certificate,
      (select count(*)::int from mint_jobs j
        where j.status in ('pending','armed','running','confirming')
          and (j.eligibility_artifact_id is null) <> (j.eligibility_artifact_hash is null)) as incomplete_eligibility_pins,
      (select count(*)::int from mint_jobs j
        join mint_eligibility_artifacts a on a.id = j.eligibility_artifact_id
        where j.status in ('pending','armed','running','confirming')
          and (a.artifact_hash <> j.eligibility_artifact_hash
            or a.collection_id <> j.collection_id
            or a.definition_version_id <> j.definition_version_id
            or a.definition_hash <> j.definition_hash
            or a.phase_id <> j.phase_id)) as mismatched_eligibility_pins,
      (select count(*)::int from mint_cutover_states s
        join mint_definition_versions v on v.id = s.candidate_definition_version_id
        where v.collection_id <> s.collection_id
          or (s.status in ('shadow','ready') and v.status <> 'certified')
          or (s.status = 'cutover' and v.status <> 'active')) as invalid_cutover_candidates,
      (select count(*)::int from mint_cutover_states
        where status = 'ready' and (matched_count < required_samples or mismatched_count > 0 or error_count > 0)) as invalid_ready_cutovers
  `;
  const failures = Object.entries(invariants).filter(([, count]) => Number(count) !== 0);
  if (failures.length) throw new Error(`Mint foundation invariants failed: ${failures.map(([name, count]) => `${name}=${count}`).join(", ")}`);
  console.log("Mint definition and certification foundation verified");
} finally {
  await sql.end();
}
