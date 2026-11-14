ALTER TABLE website_jobs
  ADD COLUMN progress jsonb CHECK (progress IS NULL OR
    (jsonb_typeof(progress)='object' AND octet_length(progress::text)<=65536)),
  ADD COLUMN agent_draft jsonb CHECK (agent_draft IS NULL OR
    (jsonb_typeof(agent_draft)='object' AND agent_draft ?& ARRAY['html_body','css','summary']
      AND octet_length(agent_draft::text)<=1048576
      AND jsonb_typeof(agent_draft->'html_body')='string' AND octet_length(agent_draft->>'html_body')<=102400
      AND jsonb_typeof(agent_draft->'css')='string' AND octet_length(agent_draft->>'css')<=40960
      AND jsonb_typeof(agent_draft->'summary')='string' AND length(agent_draft->>'summary')<=800)),
  ADD COLUMN trace jsonb NOT NULL DEFAULT '[]' CHECK
    (jsonb_typeof(trace)='array' AND jsonb_array_length(trace)<=40 AND octet_length(trace::text)<=1048576),
  ADD COLUMN usage jsonb CHECK (usage IS NULL OR
    (jsonb_typeof(usage)='object' AND octet_length(usage::text)<=1024));

CREATE OR REPLACE FUNCTION guard_website_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.status IN ('succeeded','failed') OR NEW.status='queued' OR
    (OLD.status='queued' AND NEW.status NOT IN ('running','failed')) OR
    (OLD.status='running' AND NEW.status NOT IN ('running','succeeded','failed')) THEN
    RAISE EXCEPTION '网页任务不可重新计费或撤回终态' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.restaurant_id,NEW.requesting_user_id,NEW.kind,NEW.idempotency_key,
      NEW.request_fingerprint,NEW.input,NEW.snapshot,NEW.agent_revision,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.restaurant_id,OLD.requesting_user_id,OLD.kind,OLD.idempotency_key,
      OLD.request_fingerprint,OLD.input,OLD.snapshot,OLD.agent_revision,OLD.created_at) THEN
    RAISE EXCEPTION '网页任务原始输入及创建时间不可修改' USING ERRCODE='23514';
  END IF;
  IF OLD.status='running' AND NEW.status='running' AND
    (to_jsonb(NEW)-ARRAY['progress','agent_draft','trace','usage','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['progress','agent_draft','trace','usage','updated_at']) THEN
    RAISE EXCEPTION '运行中的网页任务仅可更新进度，不可续租或修改输入' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION guard_website_job() FROM PUBLIC;

DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT UPDATE(progress,agent_draft,trace,usage) ON website_jobs TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
