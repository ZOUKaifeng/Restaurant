-- 只追加来源，不改历史版本、任务或 010 的真实 AI 账。
ALTER TABLE website_versions DROP CONSTRAINT website_versions_version_number_check;
ALTER TABLE website_versions ADD CONSTRAINT website_versions_version_number_check CHECK (version_number>0);
ALTER TABLE website_versions ALTER COLUMN model DROP NOT NULL;
ALTER TABLE website_jobs ADD CONSTRAINT website_jobs_source_identity UNIQUE (restaurant_id,id);

CREATE TABLE website_version_sources (
  version_id text PRIMARY KEY CHECK (version_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  base_version_id text CHECK (base_version_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  origin text NOT NULL CHECK (origin IN ('generation','content_refresh')),
  html_body text NOT NULL CHECK (octet_length(html_body)<=102400),
  css text NOT NULL CHECK (octet_length(css)<=40960),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  renderer_version text NOT NULL DEFAULT 'website-v1' CHECK (renderer_version='website-v1'),
  source_schema_version integer NOT NULL DEFAULT 1 CHECK (source_schema_version=1),
  public_content_hash text NOT NULL CHECK (public_content_hash ~ '^[a-f0-9]{64}$'),
  restaurant_revision integer NOT NULL CHECK (restaurant_revision>=0),
  menu_revision integer CHECK (menu_revision>=0),
  source_job_id text CHECK (source_job_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id,version_id),
  FOREIGN KEY (restaurant_id,version_id) REFERENCES website_versions(restaurant_id,id),
  FOREIGN KEY (restaurant_id,base_version_id) REFERENCES website_version_sources(restaurant_id,version_id),
  FOREIGN KEY (restaurant_id,source_job_id) REFERENCES website_jobs(restaurant_id,id),
  CHECK (base_version_id IS NULL OR base_version_id<>version_id),
  CHECK ((origin='generation' AND base_version_id IS NULL AND source_job_id IS NOT NULL) OR
    (origin='content_refresh' AND base_version_id IS NOT NULL AND source_job_id IS NULL))
);
COMMENT ON COLUMN website_version_sources.public_content_hash IS
  '公众投影由 TS publicWebsiteContent 按固定字段顺序 JSON.stringify 后计算 UTF-8 SHA-256，并由 websiteSourceStatus/发布流程检验。SQL 仅约束哈希格式，不保证该哈希与 snapshot 一致；jsonb::text 不兼容此契约。';
CREATE TABLE website_content_actions (
  id text PRIMARY KEY CHECK (id ~ '^wca_[A-Za-z0-9_-]{24}$'),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  requesting_user_id text NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  base_version_id text NOT NULL,
  result_version_id text NOT NULL,
  base_publication_revision integer NOT NULL CHECK (base_publication_revision>=0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,base_version_id) REFERENCES website_versions(restaurant_id,id),
  FOREIGN KEY (restaurant_id,result_version_id) REFERENCES website_versions(restaurant_id,id),
  UNIQUE (restaurant_id,requesting_user_id,idempotency_key)
);
CREATE INDEX website_content_actions_latest ON website_content_actions(restaurant_id,created_at DESC,id DESC);
CREATE TRIGGER website_source_immutable BEFORE UPDATE OR DELETE ON website_version_sources
  FOR EACH ROW EXECUTE FUNCTION guard_website_immutable();
CREATE TRIGGER website_content_action_immutable BEFORE UPDATE OR DELETE ON website_content_actions
  FOR EACH ROW EXECUTE FUNCTION guard_website_immutable();

-- 两个引用守卫均先锁餐厅再锁素材；任何角色都不能伪造或移除永久版本引用。
CREATE OR REPLACE FUNCTION guard_website_asset_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION '素材引用不可覆写' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.purpose='website_version' THEN RAISE EXCEPTION '网页版本素材引用永久保留' USING ERRCODE='23514'; END IF;
    IF current_user IN ('restaurant_app','restaurant_test_app') AND NOT (
      (OLD.purpose='website_job' AND EXISTS (SELECT 1 FROM public.website_jobs j
        WHERE j.id=OLD.resource_id AND j.restaurant_id=OLD.restaurant_id AND j.status='failed')) OR
      (OLD.purpose='menu_job' AND EXISTS (SELECT 1 FROM public.menu_jobs j
        WHERE j.id=OLD.resource_id AND j.restaurant_id=OLD.restaurant_id AND j.status='failed'))
    ) THEN RAISE EXCEPTION '仅允许释放失败任务自己的引用' USING ERRCODE='42501'; END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM public.restaurants WHERE id=NEW.restaurant_id FOR UPDATE;
  PERFORM 1 FROM public.assets WHERE restaurant_id=NEW.restaurant_id AND id=NEW.asset_id AND status='ready' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '素材不可引用' USING ERRCODE='23514'; END IF;
  IF NEW.purpose='website_version' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.website_versions v JOIN public.assets a
        ON a.restaurant_id=v.restaurant_id AND a.id=NEW.asset_id AND a.status='ready' AND a.safety_status='approved'
      WHERE v.id=NEW.resource_id AND v.restaurant_id=NEW.restaurant_id AND NEW.asset_id=ANY(v.asset_ids)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.snapshot->'assets') saved WHERE
          saved=jsonb_build_object('id',a.id,'kind',a.kind,'mime_type',a.mime_type,'checksum',a.checksum,
            'width_px',a.width_px,'height_px',a.height_px))
    ) THEN RAISE EXCEPTION '版本引用须精确匹配同店已确认素材清单' USING ERRCODE='23514'; END IF;
  ELSIF current_user IN ('restaurant_app','restaurant_test_app') AND NOT (
    (NEW.purpose='website_job' AND EXISTS (SELECT 1 FROM public.website_jobs j
      WHERE j.id=NEW.resource_id AND j.restaurant_id=NEW.restaurant_id AND j.kind='generate' AND j.status='queued'
        AND j.snapshot->'assets' @> jsonb_build_array(jsonb_build_object('id',NEW.asset_id)))) OR
    (NEW.purpose='menu_job' AND EXISTS (SELECT 1 FROM public.menu_jobs j
      WHERE j.id=NEW.resource_id AND j.restaurant_id=NEW.restaurant_id AND j.status='queued'
        AND j.sources @> jsonb_build_array(jsonb_build_object('id',NEW.asset_id))))
  ) THEN RAISE EXCEPTION '仅允许已入队任务引用其快照来源' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER website_asset_reference_guard ON asset_references;
CREATE TRIGGER website_asset_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON asset_references
  FOR EACH ROW EXECUTE FUNCTION guard_website_asset_reference();

CREATE FUNCTION guard_website_source_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE base public.website_version_sources;
BEGIN
  PERFORM 1 FROM public.restaurants WHERE id=NEW.restaurant_id FOR UPDATE;
  IF NEW.source_checksum<>encode(sha256(convert_to('{"html_body":'||to_json(NEW.html_body)::text||',"css":'||to_json(NEW.css)::text||'}','UTF8')),'hex') THEN
    RAISE EXCEPTION '原稿哈希不匹配精确 HTML/CSS' USING ERRCODE='23514';
  END IF;
  IF NEW.origin='content_refresh' THEN
    SELECT * INTO base FROM public.website_version_sources
      WHERE restaurant_id=NEW.restaurant_id AND version_id=NEW.base_version_id;
    IF NOT FOUND OR (NEW.html_body,NEW.css,NEW.source_checksum,NEW.renderer_version,NEW.source_schema_version)
      IS DISTINCT FROM (base.html_body,base.css,base.source_checksum,base.renderer_version,base.source_schema_version) THEN
      RAISE EXCEPTION '无 AI 内容更新必须保留同店基础版本的精确原稿' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER website_source_insert_guard BEFORE INSERT ON website_version_sources
  FOR EACH ROW EXECUTE FUNCTION guard_website_source_insert();

-- 仅 INSERT 的新版本受此要求约束；迁移前无原稿版本仍可读取和按旧协议发布。
CREATE FUNCTION require_website_version_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE v public.website_versions; s public.website_version_sources; vid text; rid text;
BEGIN
  IF TG_TABLE_NAME='website_versions' THEN vid:=NEW.id; rid:=NEW.restaurant_id;
  ELSE vid:=NEW.version_id; rid:=NEW.restaurant_id; END IF;
  SELECT * INTO v FROM public.website_versions WHERE id=vid AND restaurant_id=rid;
  SELECT * INTO s FROM public.website_version_sources WHERE version_id=vid AND restaurant_id=rid;
  IF NOT FOUND THEN RAISE EXCEPTION '新网页版本必须同事务保存原稿来源' USING ERRCODE='23514'; END IF;
  IF v.checksum IS DISTINCT FROM encode(sha256(convert_to(v.html,'UTF8')),'hex') THEN
    RAISE EXCEPTION '网页版本哈希不匹配精确 UTF-8 HTML' USING ERRCODE='23514'; END IF;
  IF s.origin='content_refresh' THEN
    IF v.model IS NOT NULL OR v.usage IS NOT NULL THEN
      RAISE EXCEPTION '无 AI 内容更新不得写模型或用量' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.website_versions b WHERE b.restaurant_id=rid AND b.id=s.base_version_id
      AND b.version_number<v.version_number) THEN
      RAISE EXCEPTION '内容更新基础版本须为同店较早版本' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM public.website_versions b WHERE b.restaurant_id=rid AND b.id=s.base_version_id
      AND (v.asset_ids IS DISTINCT FROM b.asset_ids OR v.snapshot->'assets' IS DISTINCT FROM b.snapshot->'assets')) THEN
      RAISE EXCEPTION '无 AI 内容更新必须精确保留基础版本素材清单及快照' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.website_jobs j WHERE j.restaurant_id=rid AND j.id=s.source_job_id
      AND j.kind='generate' AND j.status='succeeded' AND j.result_version_id=vid AND j.snapshot=v.snapshot) THEN
      RAISE EXCEPTION '生成原稿必须对应同店成功任务及真实结果版本' USING ERRCODE='23514'; END IF;
  END IF;
  IF v.snapshot->'restaurant'->>'id' IS DISTINCT FROM rid OR
    cardinality(v.asset_ids)<>(SELECT count(DISTINCT a) FROM unnest(v.asset_ids) a) OR
    v.asset_ids IS DISTINCT FROM ARRAY(SELECT saved->>'id' FROM jsonb_array_elements(v.snapshot->'assets') WITH ORDINALITY entry(saved,ord) ORDER BY ord) OR
    EXISTS (SELECT 1 FROM unnest(v.asset_ids) aid WHERE NOT EXISTS (
      SELECT 1 FROM public.asset_references ref WHERE ref.restaurant_id=rid AND ref.asset_id=aid
        AND ref.purpose='website_version' AND ref.resource_id=vid)) THEN
    RAISE EXCEPTION '版本清单必须精确且逐项具有永久引用' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER website_version_source_required AFTER INSERT ON website_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_website_version_source();
CREATE CONSTRAINT TRIGGER website_source_commit_guard AFTER INSERT ON website_version_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_website_version_source();
REVOKE ALL ON FUNCTION guard_website_asset_reference(),guard_website_source_insert(),require_website_version_source() FROM PUBLIC;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN
  ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password',
   'create_restaurant','update_restaurant','replace_opening_hours','upload_asset','delete_asset','website_chat',
   'website_generate','website_publish','website_job_failed','menu_recognition_requested','menu_updated',
   'menu_confirmed','menu_job_failed','reservation_settings_updated','reservation_decided','reservation_cancelled',
   'website_content_refreshed'));
REVOKE ALL ON website_version_sources,website_content_actions FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON website_version_sources,website_content_actions FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON website_version_sources,website_content_actions TO %I',role_name);
      EXECUTE format('GRANT INSERT(version_id,restaurant_id,base_version_id,origin,html_body,css,source_checksum,renderer_version,source_schema_version,public_content_hash,restaurant_revision,menu_revision,source_job_id) ON website_version_sources TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,base_version_id,result_version_id,base_publication_revision,result) ON website_content_actions TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
