CREATE FUNCTION valid_menu_data(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
DECLARE category jsonb; item jsonb; warning jsonb; field text; total integer:=0; content jsonb; max_length integer;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value ?& ARRAY['categories','warnings'] OR
    value-ARRAY['categories','warnings']<>'{}'::jsonb OR jsonb_typeof(value->'categories') IS DISTINCT FROM 'array' OR
    jsonb_typeof(value->'warnings') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'categories')>20 OR jsonb_array_length(value->'warnings')>20 THEN RETURN false; END IF;
  FOR category IN SELECT * FROM jsonb_array_elements(value->'categories') LOOP
    IF jsonb_typeof(category) IS DISTINCT FROM 'object' OR NOT category ?& ARRAY['name','items'] OR category-ARRAY['name','items']<>'{}'::jsonb OR
      jsonb_typeof(category->'name') IS DISTINCT FROM 'string' OR length(btrim(category->>'name'))=0 OR length(category->>'name')>150 OR
      jsonb_typeof(category->'items') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(category->'items') NOT BETWEEN 1 AND 80 THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(category->'items') LOOP
      total:=total+1;
      IF total>80 OR jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& ARRAY['name','description','price_text','review_note'] OR
        item-ARRAY['name','description','price_text','review_note']<>'{}'::jsonb THEN RETURN false; END IF;
      FOREACH field IN ARRAY ARRAY['name','description','price_text','review_note'] LOOP
        content:=item->field;
        IF field<>'name' AND content='null'::jsonb THEN CONTINUE; END IF;
        max_length:=CASE field WHEN 'name' THEN 200 WHEN 'description' THEN 1000 WHEN 'price_text' THEN 80 ELSE 500 END;
        IF jsonb_typeof(content) IS DISTINCT FROM 'string' OR length(btrim(item->>field))=0 OR length(item->>field)>max_length THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  FOR warning IN SELECT * FROM jsonb_array_elements(value->'warnings') LOOP
    IF jsonb_typeof(warning) IS DISTINCT FROM 'string' OR length(btrim(warning#>>'{}'))=0 OR length(warning#>>'{}')>500 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $fn$;

CREATE TABLE menu_drafts (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL UNIQUE REFERENCES restaurants(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 2147483646),
  status text NOT NULL DEFAULT 'empty' CHECK (status IN ('empty','draft','confirmed')),
  data jsonb NOT NULL DEFAULT '{"categories":[],"warnings":[]}' CHECK (valid_menu_data(data)),
  source_asset_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_asset_ids)<=4 AND array_position(source_asset_ids,NULL) IS NULL),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='confirmed')=(confirmed_at IS NOT NULL)),
  CHECK (status<>'empty' OR (revision=0 AND data='{"categories":[],"warnings":[]}'::jsonb AND source_asset_ids='{}'::text[])),
  CHECK (status<>'confirmed' OR jsonb_array_length(data->'categories')>0)
);
CREATE TABLE menu_jobs (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  requesting_user_id text NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND input ?& ARRAY['asset_ids','consent_to_ai_processing','expected_revision'] AND
    input-ARRAY['asset_ids','consent_to_ai_processing','expected_revision']='{}'::jsonb AND input->'consent_to_ai_processing'='true'::jsonb AND
    jsonb_typeof(input->'asset_ids')='array'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources)='array' AND jsonb_array_length(sources) BETWEEN 1 AND 4),
  expected_revision integer NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483645),
  lease_token uuid, lease_expires_at timestamptz,
  result_revision integer CHECK (result_revision BETWEEN 1 AND 2147483646),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (requesting_user_id,idempotency_key),
  CHECK (input->'expected_revision'=to_jsonb(expected_revision)),
  CHECK ((status='running')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='failed')=(error_code IS NOT NULL)),
  CHECK ((status='succeeded')=(result_revision IS NOT NULL)),
  CHECK (result_revision IS NULL OR result_revision=expected_revision+1)
);
CREATE UNIQUE INDEX menu_jobs_one_active_restaurant ON menu_jobs(restaurant_id) WHERE status IN ('queued','running');
CREATE INDEX menu_jobs_queue ON menu_jobs(created_at,id) WHERE status='queued';
CREATE INDEX menu_jobs_expired ON menu_jobs(lease_expires_at,id) WHERE status='running';
CREATE INDEX menu_jobs_user_quota ON menu_jobs(requesting_user_id,created_at DESC);
CREATE INDEX menu_jobs_restaurant_latest ON menu_jobs(restaurant_id,created_at DESC,id DESC);

CREATE FUNCTION guard_menu_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE ids jsonb; count_sources integer; total_size bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '菜单任务来历不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT jsonb_agg(source->'id' ORDER BY ordinal),count(*),sum(a.size_bytes) INTO ids,count_sources,total_size
      FROM jsonb_array_elements(NEW.sources) WITH ORDINALITY entry(source,ordinal)
      JOIN public.assets a ON a.id=source->>'id' AND a.restaurant_id=NEW.restaurant_id AND a.kind='menu_source' AND a.status='ready'
      AND a.mime_type IN ('image/jpeg','image/png') AND a.size_bytes<=10485760
      AND source=jsonb_build_object('id',a.id,'mime_type',a.mime_type,'checksum',a.checksum,'size_bytes',a.size_bytes,
        'storage_key',a.storage_key,'storage_backend',a.storage_backend);
    IF count_sources<>jsonb_array_length(NEW.sources) OR ids IS DISTINCT FROM NEW.input->'asset_ids' OR total_size>20971520 OR
      (SELECT count(DISTINCT source->>'id') FROM jsonb_array_elements(NEW.sources) source)<>count_sources THEN
      RAISE EXCEPTION '菜单任务只接受已验证菜单图片快照' USING ERRCODE='23514';
    END IF;
    IF current_user IN ('restaurant_app','restaurant_test_app') AND NEW.status<>'queued' THEN
      RAISE EXCEPTION '菜单任务必须先入队' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.restaurant_id,NEW.requesting_user_id,NEW.idempotency_key,NEW.request_fingerprint,NEW.input,NEW.sources,NEW.expected_revision,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.restaurant_id,OLD.requesting_user_id,OLD.idempotency_key,OLD.request_fingerprint,OLD.input,OLD.sources,OLD.expected_revision,OLD.created_at) THEN
    RAISE EXCEPTION '菜单任务原始输入不可变更' USING ERRCODE='23514';
  END IF;
  IF OLD.status IN ('succeeded','failed') OR NEW.status='queued' OR
    (OLD.status='queued' AND NEW.status NOT IN ('running','failed')) OR
    (OLD.status='running' AND NEW.status NOT IN ('succeeded','failed')) THEN
    RAISE EXCEPTION '菜单任务不可重新计费或撤回终态' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER menu_job_guard BEFORE INSERT OR UPDATE OR DELETE ON menu_jobs FOR EACH ROW EXECUTE FUNCTION guard_menu_job();
CREATE FUNCTION guard_menu_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '菜单当前版本不可删除' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.restaurant_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.restaurant_id,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION '菜单版本必须递增且归属不可变' USING ERRCODE='23514';
  END IF;
  IF NEW.source_asset_ids IS DISTINCT FROM OLD.source_asset_ids AND NOT EXISTS (
    SELECT 1 FROM public.menu_jobs j WHERE j.restaurant_id=NEW.restaurant_id AND j.status='running' AND j.expected_revision=OLD.revision
    AND NEW.source_asset_ids=ARRAY(SELECT source->>'id' FROM jsonb_array_elements(j.sources) WITH ORDINALITY entry(source,ordinal) ORDER BY ordinal)
  ) THEN RAISE EXCEPTION '菜单来源只能由当前识别任务提交' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER menu_draft_guard BEFORE UPDATE OR DELETE ON menu_drafts FOR EACH ROW EXECUTE FUNCTION guard_menu_draft();

-- 保留 004 的网页引用协议；菜单成功任务永久保留来源，失败只释放自己的引用。
CREATE OR REPLACE FUNCTION guard_website_asset_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user IN ('restaurant_app','restaurant_test_app') THEN
    IF TG_OP='INSERT' THEN
      IF NOT ((NEW.purpose='website_job' AND EXISTS (
        SELECT 1 FROM public.website_jobs j WHERE j.id=NEW.resource_id AND j.restaurant_id=NEW.restaurant_id
        AND j.kind='generate' AND j.status='queued' AND j.snapshot->'assets' @> jsonb_build_array(jsonb_build_object('id',NEW.asset_id))
      )) OR (NEW.purpose='menu_job' AND EXISTS (
        SELECT 1 FROM public.menu_jobs j WHERE j.id=NEW.resource_id AND j.restaurant_id=NEW.restaurant_id
        AND j.status='queued' AND j.sources @> jsonb_build_array(jsonb_build_object('id',NEW.asset_id))
      ))) THEN RAISE EXCEPTION '仅允许已入队任务引用其快照来源' USING ERRCODE='42501'; END IF;
    ELSE
      IF NOT ((OLD.purpose='website_job' AND EXISTS (
        SELECT 1 FROM public.website_jobs j WHERE j.id=OLD.resource_id AND j.restaurant_id=OLD.restaurant_id AND j.status='failed'
      )) OR (OLD.purpose='menu_job' AND EXISTS (
        SELECT 1 FROM public.menu_jobs j WHERE j.id=OLD.resource_id AND j.restaurant_id=OLD.restaurant_id AND j.status='failed'
      ))) THEN RAISE EXCEPTION '仅允许释放失败任务自己的引用' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION guard_menu_job(),guard_menu_draft(),guard_website_asset_reference() FROM PUBLIC;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN
  ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password',
   'create_restaurant','update_restaurant','replace_opening_hours','upload_asset','delete_asset',
   'website_chat','website_generate','website_publish','website_job_failed',
   'menu_recognition_requested','menu_updated','menu_confirmed','menu_job_failed'));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN ('user','restaurant','asset','website','menu'));
-- audit_logs.id 本来就是 text，同时接受 aud_ 标识及网页审计的 UUID 文本，不更改已有主键。
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON menu_drafts,menu_jobs FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON menu_drafts,menu_jobs TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id) ON menu_drafts TO %I',role_name);
      EXECUTE format('GRANT UPDATE(revision,status,data,source_asset_ids,confirmed_at,updated_at) ON menu_drafts TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,expected_revision) ON menu_jobs TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,lease_token,lease_expires_at,error_code,result_revision,updated_at) ON menu_jobs TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
