CREATE TABLE website_model_calls (
  job_id text NOT NULL REFERENCES website_jobs(id),
  call_index integer NOT NULL CHECK (call_index>0),
  runner_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed','failed')),
  prompt_tokens bigint CHECK (prompt_tokens BETWEEN 0 AND 9007199254740991),
  completion_tokens bigint CHECK (completion_tokens BETWEEN 0 AND 9007199254740991),
  total_tokens bigint CHECK (total_tokens BETWEEN 0 AND 9007199254740991),
  elapsed_ms bigint CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id,call_index),
  CHECK ((prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL) OR
    (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens IS NOT NULL
      AND prompt_tokens::numeric+completion_tokens::numeric=total_tokens::numeric)),
  CHECK (status<>'completed' OR total_tokens IS NOT NULL),
  CHECK (status<>'started' OR (total_tokens IS NULL AND error_code IS NULL)),
  CHECK (status='failed' OR error_code IS NULL)
);

CREATE FUNCTION guard_website_model_call() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE job public.website_jobs;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION '模型调用历史不可删除' USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM public.website_jobs WHERE id=NEW.job_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'started' OR job.kind<>'generate' OR job.status<>'running' OR
      job.lease_token IS DISTINCT FROM NEW.runner_token OR job.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION '仅允许有效生成租约记录新模型调用' USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.status<>'started' OR NEW.status NOT IN ('completed','failed') OR
      (NEW.job_id,NEW.call_index,NEW.runner_token,NEW.created_at) IS DISTINCT FROM
      (OLD.job_id,OLD.call_index,OLD.runner_token,OLD.created_at) OR
      NOT (job.status='failed' OR (job.status='running' AND job.lease_token=OLD.runner_token)) THEN
      RAISE EXCEPTION '仅允许原始调用从开始进入一次终态' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER website_model_call_guard BEFORE INSERT OR UPDATE OR DELETE ON website_model_calls
  FOR EACH ROW EXECUTE FUNCTION guard_website_model_call();
REVOKE ALL ON FUNCTION guard_website_model_call() FROM PUBLIC;

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
  IF OLD.status='running' AND NEW.status='running' THEN
    IF (to_jsonb(NEW)-ARRAY['progress','agent_draft','trace','usage','updated_at','lease_expires_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['progress','agent_draft','trace','usage','updated_at','lease_expires_at']) THEN
      RAISE EXCEPTION '运行中的网页任务仅可更新进度与生成租约心跳' USING ERRCODE='23514';
    END IF;
    IF NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at AND
      (NEW.kind<>'generate' OR OLD.lease_expires_at<=clock_timestamp() OR
        NEW.lease_expires_at<OLD.lease_expires_at OR NEW.lease_expires_at>clock_timestamp()+interval '190 seconds' OR
        NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
      RAISE EXCEPTION '生成租约仅可在有效期内保留原令牌短期续租' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION guard_website_job() FROM PUBLIC;

DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON website_model_calls FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON website_model_calls TO %I',role_name);
      EXECUTE format('GRANT INSERT(job_id,call_index,runner_token,status,prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code) ON website_model_calls TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code,updated_at) ON website_model_calls TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
