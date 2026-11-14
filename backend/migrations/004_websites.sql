CREATE TABLE website_agents (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL UNIQUE REFERENCES restaurants(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  messages jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(messages)='array' AND jsonb_array_length(messages)<=24),
  design_brief text NOT NULL DEFAULT '' CHECK (length(design_brief)<=3000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE website_versions (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  version_number integer NOT NULL CHECK (version_number BETWEEN 1 AND 20),
  summary text NOT NULL CHECK (length(summary)<=2000),
  html text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 204800),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND jsonb_typeof(snapshot->'restaurant')='object'
    AND jsonb_typeof(snapshot->'opening_hours')='array' AND jsonb_typeof(snapshot->'assets')='array' AND jsonb_array_length(snapshot->'assets')<=8),
  asset_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(asset_ids)<=8),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id,id), UNIQUE (restaurant_id,version_number)
);
CREATE TABLE website_jobs (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  requesting_user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('chat','generate')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  agent_revision integer CHECK (agent_revision>=1),
  lease_token uuid, lease_expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  result_version_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,result_version_id) REFERENCES website_versions(restaurant_id,id),
  UNIQUE (restaurant_id,kind,requesting_user_id,idempotency_key),
  CHECK ((kind='chat' AND agent_revision IS NOT NULL) OR (kind='generate' AND agent_revision IS NULL)),
  CHECK ((status='running')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='failed')=(error_code IS NOT NULL)),
  CHECK (result_version_id IS NULL OR (kind='generate' AND status='succeeded'))
);
CREATE UNIQUE INDEX website_jobs_one_active_restaurant ON website_jobs(restaurant_id) WHERE status IN ('queued','running');
CREATE INDEX website_jobs_queue ON website_jobs(created_at,id) WHERE status='queued';
CREATE INDEX website_jobs_expired ON website_jobs(lease_expires_at,id) WHERE status='running';
CREATE INDEX website_jobs_user_quota ON website_jobs(requesting_user_id,created_at DESC);
CREATE INDEX website_jobs_restaurant_latest ON website_jobs(restaurant_id,created_at DESC,id DESC);
CREATE TABLE website_publications (
  restaurant_id text PRIMARY KEY REFERENCES restaurants(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  published_version_id text,
  slug varchar(50) UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' AND slug NOT IN ('admin','api','auth','www')),
  deployment_mode text NOT NULL DEFAULT 'unconfigured' CHECK (deployment_mode IN ('local','unconfigured')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,published_version_id) REFERENCES website_versions(restaurant_id,id),
  CHECK ((published_version_id IS NULL AND revision=0 AND slug IS NULL) OR (published_version_id IS NOT NULL AND revision>0 AND slug IS NOT NULL))
);
CREATE TABLE website_publish_actions (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  requesting_user_id text NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,version_id) REFERENCES website_versions(restaurant_id,id),
  UNIQUE (restaurant_id,requesting_user_id,idempotency_key)
);
CREATE INDEX website_publish_actions_latest ON website_publish_actions(restaurant_id,created_at DESC,id DESC);

CREATE FUNCTION guard_website_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  RAISE EXCEPTION '网页版本及发布历史不可修改或删除' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER website_version_immutable BEFORE UPDATE OR DELETE ON website_versions FOR EACH ROW EXECUTE FUNCTION guard_website_immutable();
CREATE TRIGGER website_publish_action_immutable BEFORE UPDATE OR DELETE ON website_publish_actions FOR EACH ROW EXECUTE FUNCTION guard_website_immutable();
CREATE FUNCTION guard_website_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION '网页路径不可更改' USING ERRCODE='23514';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION '发布版本必须递增' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER website_publication_guard BEFORE UPDATE ON website_publications FOR EACH ROW EXECUTE FUNCTION guard_website_publication();
CREATE FUNCTION guard_website_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.status IN ('succeeded','failed') OR NEW.status='queued' OR
    (OLD.status='queued' AND NEW.status NOT IN ('running','failed')) OR
    (OLD.status='running' AND NEW.status NOT IN ('succeeded','failed')) THEN
    RAISE EXCEPTION '网页任务不可重新计费或撤回终态' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER website_job_guard BEFORE UPDATE ON website_jobs FOR EACH ROW EXECUTE FUNCTION guard_website_job();
CREATE FUNCTION guard_website_asset_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user IN ('restaurant_app','restaurant_test_app') THEN
    IF TG_OP='INSERT' THEN
      IF NEW.purpose<>'website_job' OR NOT EXISTS (
        SELECT 1 FROM public.website_jobs j WHERE j.id=NEW.resource_id AND j.restaurant_id=NEW.restaurant_id
        AND j.kind='generate' AND j.status='queued' AND j.snapshot->'assets' @> jsonb_build_array(jsonb_build_object('id',NEW.asset_id))
      ) THEN RAISE EXCEPTION '仅允许已入队网页任务引用' USING ERRCODE='42501'; END IF;
    ELSE
      IF OLD.purpose<>'website_job' OR NOT EXISTS (
        SELECT 1 FROM public.website_jobs j WHERE j.id=OLD.resource_id AND j.restaurant_id=OLD.restaurant_id AND j.status='failed'
      ) THEN RAISE EXCEPTION '仅允许释放失败网页任务引用' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER website_asset_reference_guard BEFORE INSERT OR DELETE ON asset_references FOR EACH ROW EXECUTE FUNCTION guard_website_asset_reference();
REVOKE ALL ON FUNCTION guard_website_immutable(),guard_website_publication(),guard_website_job(),guard_website_asset_reference() FROM PUBLIC;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN
  ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password',
   'create_restaurant','update_restaurant','replace_opening_hours','upload_asset','delete_asset',
   'website_chat','website_generate','website_publish','website_job_failed'));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN ('user','restaurant','asset','website'));
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON website_agents,website_versions,website_jobs,website_publications,website_publish_actions FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON website_agents,website_versions,website_jobs,website_publications,website_publish_actions TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id) ON website_agents TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage) ON website_versions TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot,agent_revision) ON website_jobs TO %I',role_name);
      EXECUTE format('GRANT INSERT(restaurant_id) ON website_publications TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,version_id,result) ON website_publish_actions TO %I',role_name);
      EXECUTE format('GRANT UPDATE(revision,messages,design_brief,updated_at) ON website_agents TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,lease_token,lease_expires_at,error_code,result_version_id,updated_at) ON website_jobs TO %I',role_name);
      EXECUTE format('GRANT UPDATE(revision,published_version_id,slug,deployment_mode,updated_at) ON website_publications TO %I',role_name);
      EXECUTE format('GRANT INSERT,DELETE ON asset_references TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
