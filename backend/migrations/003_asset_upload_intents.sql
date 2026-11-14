-- 候选记录先于存储 PUT 提交；不关联客户数据外键，保留崩溃后的补偿线索。
CREATE TABLE asset_upload_intents (
  id text PRIMARY KEY CHECK (id ~ '^ast_[A-Za-z0-9_-]{24}$'),
  restaurant_id text NOT NULL CHECK (restaurant_id ~ '^rst_[A-Za-z0-9_-]{24}$'),
  user_id text NOT NULL CHECK (user_id ~ '^usr_[A-Za-z0-9_-]{24}$'),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local','s3')),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^rst_[A-Za-z0-9_-]{24}/ast_[A-Za-z0-9_-]{24}\.(pdf|jpg|png)$'),
  expected_checksum text NOT NULL CHECK (expected_checksum ~ '^[a-f0-9]{64}$'),
  expected_size_bytes integer NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 20971520),
  attempt_marker text NOT NULL UNIQUE CHECK (attempt_marker ~ '^[a-f0-9]{48}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','committed','abandoned','blocked','cleaned')),
  last_error_code text CHECK (last_error_code IN ('UPLOAD_RESULT_UNKNOWN','UPLOAD_NOT_COMMITTED','STORAGE_CLEANUP_FAILED','UPLOAD_OBJECT_MISMATCH','ASSET_RECORD_PRESENT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  CHECK (expires_at>=created_at+interval '15 minutes'),
  CHECK (split_part(storage_key,'/',1)=restaurant_id AND split_part(split_part(storage_key,'/',2),'.',1)=id),
  CHECK (state NOT IN ('committed','cleaned') OR last_error_code IS NULL)
);
CREATE INDEX asset_upload_intents_pending ON asset_upload_intents(restaurant_id,state);
CREATE INDEX asset_upload_intents_cleanup ON asset_upload_intents(id,expires_at) WHERE state IN ('pending','abandoned');

-- 所有状态转换先锁餐厅，再锁 intent；网络补偿在锁外执行，abandoned 将阻止迟到的最终提交。
CREATE FUNCTION guard_asset_upload_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.state IN ('committed','cleaned','blocked') AND NEW.state<>OLD.state THEN
    RAISE EXCEPTION '上传意图终态不可自动撤回' USING ERRCODE='23514';
  END IF;
  IF NEW.state='pending' AND OLD.state<>'pending' THEN
    RAISE EXCEPTION '不可重新启用上传意图' USING ERRCODE='23514';
  END IF;
  IF NEW.state='committed' AND OLD.state<>'committed' THEN
    IF OLD.state<>'pending' OR OLD.expires_at<=clock_timestamp() OR NOT EXISTS(
      SELECT 1 FROM public.assets a WHERE a.id=NEW.id AND a.restaurant_id=NEW.restaurant_id AND a.status='ready'
        AND a.storage_key=NEW.storage_key AND a.storage_backend=NEW.storage_backend
        AND a.checksum=NEW.expected_checksum AND a.size_bytes=NEW.expected_size_bytes
    ) THEN RAISE EXCEPTION '上传意图没有对应的已就绪素材' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.state IN ('abandoned','cleaned') AND EXISTS(SELECT 1 FROM public.assets a WHERE a.storage_key=NEW.storage_key) THEN
    RAISE EXCEPTION '已有素材记录不可补偿删除' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER asset_upload_intent_guard BEFORE UPDATE ON asset_upload_intents FOR EACH ROW EXECUTE FUNCTION guard_asset_upload_intent();
REVOKE ALL ON FUNCTION guard_asset_upload_intent() FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON asset_upload_intents FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON asset_upload_intents TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,user_id,storage_backend,storage_key,expected_checksum,expected_size_bytes,attempt_marker) ON asset_upload_intents TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,updated_at,last_error_code) ON asset_upload_intents TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
