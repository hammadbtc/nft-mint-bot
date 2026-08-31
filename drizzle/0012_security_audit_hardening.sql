-- Security audit release gate. Activation, parity cutover and broadcast release
-- are database invariants as well as API invariants so another code path cannot
-- silently bypass them.

CREATE OR REPLACE FUNCTION mint_definition_activation_has_certificate() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'mint definition must be inserted before certification and activation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM mint_certifications c
      WHERE c.definition_version_id = NEW.id
        AND c.definition_hash = NEW.definition_hash
        AND c.status = 'passed'
        AND c.runner_version = 'mint-certifier-v1'
        AND c.expires_at::timestamptz > now()
    ) THEN
      RAISE EXCEPTION 'active mint definition requires a fresh machine certification';
    END IF;

    IF EXISTS (
      SELECT 1 FROM mint_definition_versions previous
      WHERE previous.collection_id = NEW.collection_id
        AND previous.id <> NEW.id
        AND previous.activated_at IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM mint_cutover_states s
      WHERE s.collection_id = NEW.collection_id
        AND s.candidate_definition_version_id = NEW.id
        AND s.status = 'ready'
        AND s.matched_count >= s.required_samples
        AND s.mismatched_count = 0
        AND s.error_count = 0
    ) THEN
      RAISE EXCEPTION 'replacement mint definition requires a ready exact-parity cutover';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mint_cutover_status_transition_valid() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'shadow' AND NEW.status IN ('ready', 'rollback'))
    OR (OLD.status = 'ready' AND NEW.status IN ('shadow', 'cutover', 'rollback'))
    OR (OLD.status = 'cutover' AND NEW.status = 'rollback')
    OR (OLD.status = 'rollback' AND NEW.status = 'shadow')
  ) THEN
    RAISE EXCEPTION 'invalid mint cutover status transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'ready' AND (
    NEW.matched_count < NEW.required_samples OR NEW.mismatched_count <> 0 OR NEW.error_count <> 0
  ) THEN
    RAISE EXCEPTION 'ready mint cutover requires exact clean parity';
  END IF;
  IF NEW.status = 'cutover' AND NOT EXISTS (
    SELECT 1 FROM mint_definition_versions v
    WHERE v.id = NEW.candidate_definition_version_id
      AND v.collection_id = NEW.collection_id
      AND v.status = 'active'
  ) THEN
    RAISE EXCEPTION 'cutover candidate must already be the active definition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_cutover_status_transition_valid_trigger ON "mint_cutover_states";
CREATE TRIGGER mint_cutover_status_transition_valid_trigger
  BEFORE UPDATE ON "mint_cutover_states"
  FOR EACH ROW EXECUTE FUNCTION mint_cutover_status_transition_valid();

CREATE OR REPLACE FUNCTION mint_broadcast_release_valid() RETURNS trigger AS $$
DECLARE
  active_version mint_definition_versions%ROWTYPE;
BEGIN
  IF OLD.broadcast_paused = true AND NEW.broadcast_paused = false THEN
    SELECT * INTO active_version FROM mint_definition_versions
      WHERE collection_id = NEW.id AND status = 'active' LIMIT 1;
    IF active_version.id IS NULL THEN
      RAISE EXCEPTION 'broadcast release requires an active mint definition';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mint_certifications c
      WHERE c.definition_version_id = active_version.id
        AND c.definition_hash = active_version.definition_hash
        AND c.status = 'passed'
        AND c.runner_version = 'mint-certifier-v1'
        AND c.expires_at::timestamptz > now()
    ) THEN
      RAISE EXCEPTION 'broadcast release requires a valid active certification';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mint_definition_activations a
      WHERE a.to_definition_version_id = active_version.id
        AND a.from_definition_version_id IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM mint_cutover_states s
      WHERE s.collection_id = NEW.id
        AND s.candidate_definition_version_id = active_version.id
        AND s.status = 'cutover'
    ) THEN
      RAISE EXCEPTION 'broadcast release requires completed exact-parity cutover';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_broadcast_release_valid_trigger ON "collections";
CREATE TRIGGER mint_broadcast_release_valid_trigger
  BEFORE UPDATE ON "collections"
  FOR EACH ROW EXECUTE FUNCTION mint_broadcast_release_valid();

-- Grandfathered seed certificates are intake evidence, never runtime authority.
-- Pause them without changing the active snapshot so an operator can produce a
-- fresh fork certificate for the same bytes after the hardened code deploys.
UPDATE collections c
SET broadcast_paused = true,
    broadcast_pause_reason = 'Machine certification required after security hardening',
    broadcast_pause_updated_at = now()
WHERE c.broadcast_paused = false
  AND EXISTS (
    SELECT 1 FROM mint_definition_versions v
    WHERE v.collection_id = c.id AND v.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM mint_certifications cert
        WHERE cert.definition_version_id = v.id
          AND cert.definition_hash = v.definition_hash
          AND cert.status = 'passed'
          AND cert.runner_version = 'mint-certifier-v1'
          AND cert.expires_at::timestamptz > now()
      )
  );
