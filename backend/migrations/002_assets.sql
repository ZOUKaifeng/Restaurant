CREATE TABLE assets (
  id text PRIMARY KEY CHECK (id ~ '^ast_[A-Za-z0-9_-]{24}$'),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  kind text NOT NULL CHECK (kind IN ('menu_source','logo','restaurant_photo','dish_photo')),
  origin text NOT NULL DEFAULT 'upload' CHECK (origin='upload'),
  original_filename varchar(200) NOT NULL CHECK (length(original_filename)>0 AND original_filename !~ '[[:cntrl:]/]' AND position(chr(92) in original_filename)=0),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  width_px integer, height_px integer, alt_text varchar(500),
  rights_confirmed_at timestamptz NOT NULL,
  safety_status text NOT NULL DEFAULT 'approved' CHECK (safety_status='approved'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','deleted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local','s3')),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^rst_[A-Za-z0-9_-]{24}/ast_[A-Za-z0-9_-]{24}\.(pdf|jpg|png)$'),
  upload_idempotency_key varchar(128) NOT NULL CHECK (upload_idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  initial_request_fingerprint text NOT NULL CHECK (initial_request_fingerprint ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz, last_error_code text CHECK (last_error_code IN ('STORAGE_DELETE_FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id,id), UNIQUE (restaurant_id,upload_idempotency_key),
  CHECK (split_part(storage_key,'/',1)=restaurant_id AND split_part(split_part(storage_key,'/',2),'.',1)=id),
  CHECK ((status='deleted')=(deleted_at IS NOT NULL)),
  CHECK (last_error_code IS NULL OR status='deleted'),
  CHECK ((mime_type='application/pdf' AND kind='menu_source' AND width_px IS NULL AND height_px IS NULL AND storage_key LIKE '%.pdf') OR
    (mime_type IN ('image/jpeg','image/png') AND size_bytes<=10485760 AND width_px IS NOT NULL AND height_px IS NOT NULL AND width_px>0 AND height_px>0 AND width_px::bigint*height_px<=20000000 AND
      ((mime_type='image/jpeg' AND storage_key LIKE '%.jpg') OR (mime_type='image/png' AND storage_key LIKE '%.png'))))
);
CREATE INDEX assets_restaurant_order ON assets(restaurant_id,created_at DESC,id DESC) WHERE status='ready';
CREATE INDEX assets_cleanup ON assets(deleted_at,id) WHERE status='deleted' AND last_error_code IS NOT NULL;

CREATE TABLE asset_references (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  asset_id text NOT NULL,
  purpose varchar(64) NOT NULL CHECK (length(btrim(purpose))>0),
  resource_id varchar(128) NOT NULL CHECK (length(btrim(resource_id))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id,asset_id) REFERENCES assets(restaurant_id,id),
  UNIQUE (asset_id,purpose,resource_id)
);
-- 后续菜单/站点写引用也必须先锁用户/会话，再锁餐厅，最后锁素材；触发器提供额外的状态保护。
CREATE FUNCTION guard_asset_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  PERFORM id FROM public.restaurants WHERE id=NEW.restaurant_id FOR UPDATE;
  PERFORM id FROM public.assets WHERE restaurant_id=NEW.restaurant_id AND id=NEW.asset_id AND status='ready' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '素材不可引用' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER asset_reference_guard BEFORE INSERT OR UPDATE ON asset_references FOR EACH ROW EXECUTE FUNCTION guard_asset_reference();
CREATE FUNCTION guard_asset_deletion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.status='deleted' AND NEW.status<>'deleted' THEN RAISE EXCEPTION '不可撤回逻辑删除' USING ERRCODE='23514'; END IF;
  IF OLD.status='ready' AND NEW.status='deleted' THEN
    IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION '删除版本不合法' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.asset_references WHERE asset_id=OLD.id) THEN RAISE EXCEPTION '素材正在引用' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER asset_deletion_guard BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION guard_asset_deletion();
REVOKE ALL ON FUNCTION guard_asset_reference(),guard_asset_deletion() FROM PUBLIC;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK(action IN
  ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password','create_restaurant','update_restaurant','replace_opening_hours','upload_asset','delete_asset'));
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK(entity_type IN ('user','restaurant','asset'));
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON assets,asset_references FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON assets TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,kind,original_filename,mime_type,size_bytes,checksum,source_checksum,width_px,height_px,rights_confirmed_at,storage_backend,storage_key,upload_idempotency_key,initial_request_fingerprint) ON assets TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,revision,deleted_at,updated_at,last_error_code) ON assets TO %I',role_name);
      EXECUTE format('GRANT SELECT ON asset_references TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
