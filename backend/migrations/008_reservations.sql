-- 订位业务：申请、人工处理、取消、顾客单笔管理令牌与通知排队。
-- 不代表自动容量或实时有位；提交只创建 pending，必须由商家确认。
CREATE TABLE reservations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  public_reference varchar(16) NOT NULL CHECK (public_reference ~ '^[A-Z0-9]{6,16}$'),
  customer_user_id text REFERENCES users(id),
  source text NOT NULL CHECK (source IN ('website','merchant_manual')),
  website_version_id text,
  guest_name varchar(100) NOT NULL CHECK (length(btrim(guest_name)) BETWEEN 1 AND 100),
  guest_email varchar(254),
  guest_email_normalized varchar(254),
  guest_phone varchar(32),
  guest_email_verified_at timestamptz,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  requested_local_date date NOT NULL,
  requested_local_time time(0) NOT NULL CHECK (extract(second FROM requested_local_time)=0),
  timezone_snapshot varchar(64) NOT NULL CHECK (timezone_snapshot ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
  requested_start_at timestamptz NOT NULL,
  guest_note varchar(1000),
  internal_note varchar(1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','cancelled')),
  decided_at timestamptz,
  decided_by_user_id text REFERENCES users(id),
  decision_reason varchar(500),
  cancelled_at timestamptz,
  cancelled_by_type text CHECK (cancelled_by_type IN ('guest','merchant','system')),
  privacy_notice_version varchar(64) NOT NULL CHECK (length(btrim(privacy_notice_version))>0),
  privacy_notice_shown_at timestamptz NOT NULL,
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  initial_request_fingerprint text NOT NULL CHECK (initial_request_fingerprint ~ '^[a-f0-9]{64}$'),
  anonymized_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (restaurant_id,id),
  UNIQUE (restaurant_id,public_reference),
  UNIQUE (restaurant_id,idempotency_key),
  FOREIGN KEY (restaurant_id,website_version_id) REFERENCES website_versions(restaurant_id,id),
  FOREIGN KEY (restaurant_id,decided_by_user_id) REFERENCES restaurant_members(restaurant_id,user_id),
  CHECK ((guest_email IS NULL) = (guest_email_normalized IS NULL)),
  CHECK (anonymized_at IS NOT NULL OR guest_email IS NOT NULL OR guest_phone IS NOT NULL),
  CHECK (
    (status='pending' AND decided_at IS NULL AND decided_by_user_id IS NULL AND cancelled_at IS NULL AND cancelled_by_type IS NULL)
    OR (status='confirmed' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND cancelled_at IS NULL AND cancelled_by_type IS NULL)
    OR (status='declined' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND cancelled_at IS NULL AND cancelled_by_type IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_type IS NOT NULL)
  )
);
CREATE INDEX reservations_restaurant_start ON reservations(restaurant_id,requested_start_at,id);
CREATE INDEX reservations_restaurant_status_created ON reservations(restaurant_id,status,created_at DESC,id DESC);
CREATE INDEX reservations_restaurant_created ON reservations(restaurant_id,created_at DESC,id DESC);
CREATE INDEX reservations_restaurant_email ON reservations(restaurant_id,guest_email_normalized)
  WHERE guest_email_normalized IS NOT NULL;
CREATE INDEX reservations_pending_age ON reservations(created_at,id) WHERE status='pending';

CREATE TABLE reservation_events (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  restaurant_id text NOT NULL,
  reservation_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','confirmed','declined','cancelled','details_updated')),
  actor_type text NOT NULL CHECK (actor_type IN ('guest','merchant','system')),
  actor_user_id text REFERENCES users(id),
  from_status text CHECK (from_status IN ('pending','confirmed','declined','cancelled')),
  to_status text NOT NULL CHECK (to_status IN ('pending','confirmed','declined','cancelled')),
  reservation_revision integer NOT NULL CHECK (reservation_revision>0),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes)='object'),
  request_id varchar(128) NOT NULL CHECK (length(btrim(request_id))>0),
  action_fingerprint text NOT NULL CHECK (action_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,reservation_id) REFERENCES reservations(restaurant_id,id),
  UNIQUE (reservation_id,reservation_revision),
  UNIQUE (reservation_id,request_id),
  CHECK ((actor_type='merchant') = (actor_user_id IS NOT NULL)),
  CHECK (
    (event_type='created' AND from_status IS NULL AND to_status='pending')
    OR (event_type='confirmed' AND from_status='pending' AND to_status='confirmed')
    OR (event_type='declined' AND from_status='pending' AND to_status='declined')
    OR (event_type='cancelled' AND from_status IN ('pending','confirmed') AND to_status='cancelled')
    OR (event_type='details_updated' AND from_status IS NOT NULL AND from_status=to_status)
  )
);
CREATE INDEX reservation_events_restaurant_time ON reservation_events(restaurant_id,created_at DESC,id DESC);
CREATE INDEX reservation_events_reservation ON reservation_events(reservation_id,reservation_revision);

CREATE TABLE reservation_access_tokens (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  restaurant_id text NOT NULL,
  reservation_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,reservation_id) REFERENCES reservations(restaurant_id,id)
);
CREATE UNIQUE INDEX reservation_access_tokens_active ON reservation_access_tokens(reservation_id) WHERE revoked_at IS NULL;
CREATE INDEX reservation_access_tokens_expiry ON reservation_access_tokens(expires_at) WHERE revoked_at IS NULL;

-- 原始订位事实不可改写；状态只能按 pending→confirmed/declined/cancelled、confirmed→cancelled 迁移并递增 revision。
CREATE FUNCTION guard_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION '订位记录不可删除' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.restaurant_id,NEW.public_reference,NEW.customer_user_id,NEW.source,NEW.website_version_id,
      NEW.guest_name,NEW.guest_email,NEW.guest_email_normalized,NEW.guest_phone,NEW.guest_email_verified_at,
      NEW.party_size,NEW.requested_local_date,NEW.requested_local_time,NEW.timezone_snapshot,NEW.requested_start_at,
      NEW.guest_note,NEW.privacy_notice_version,NEW.privacy_notice_shown_at,NEW.idempotency_key,
      NEW.initial_request_fingerprint,NEW.created_at)
    IS DISTINCT FROM
      (OLD.id,OLD.restaurant_id,OLD.public_reference,OLD.customer_user_id,OLD.source,OLD.website_version_id,
      OLD.guest_name,OLD.guest_email,OLD.guest_email_normalized,OLD.guest_phone,OLD.guest_email_verified_at,
      OLD.party_size,OLD.requested_local_date,OLD.requested_local_time,OLD.timezone_snapshot,OLD.requested_start_at,
      OLD.guest_note,OLD.privacy_notice_version,OLD.privacy_notice_shown_at,OLD.idempotency_key,
      OLD.initial_request_fingerprint,OLD.created_at) THEN
    RAISE EXCEPTION '订位原始申请不可修改' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('declined','cancelled') OR
      (OLD.status='pending' AND NEW.status NOT IN ('confirmed','declined','cancelled')) OR
      (OLD.status='confirmed' AND NEW.status<>'cancelled') THEN
      RAISE EXCEPTION '不允许的订位状态迁移' USING ERRCODE='23514';
    END IF;
    IF NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION '订位状态变更必须递增revision' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.revision<>OLD.revision THEN
    RAISE EXCEPTION '未变更状态不能修改revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER reservation_guard BEFORE UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION guard_reservation();
REVOKE ALL ON FUNCTION guard_reservation() FROM PUBLIC;

CREATE FUNCTION guard_reservation_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  RAISE EXCEPTION '订位事件只追加不可修改' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER reservation_event_guard BEFORE UPDATE OR DELETE ON reservation_events
  FOR EACH ROW EXECUTE FUNCTION guard_reservation_event();
REVOKE ALL ON FUNCTION guard_reservation_event() FROM PUBLIC;

-- 复用邮箱队列：游客没有 users/auth_tokens，预订通知改用restaurant_id+reservation_id绑定。
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_restaurant_id_check;
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_template_key_check;
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_payload_check;
ALTER TABLE email_outbox ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE email_outbox ALTER COLUMN auth_token_id DROP NOT NULL;
ALTER TABLE email_outbox ADD COLUMN reservation_id text;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_template_key_check CHECK (template_key IN
  ('verify_email','reset_password','reservation_received','reservation_confirmed','reservation_declined','reservation_cancelled'));
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_scope_check CHECK (
  (restaurant_id IS NULL AND reservation_id IS NULL AND user_id IS NOT NULL AND auth_token_id IS NOT NULL)
  OR (restaurant_id IS NOT NULL AND reservation_id IS NOT NULL AND user_id IS NULL AND auth_token_id IS NULL)
);
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_reservation_fk
  FOREIGN KEY (restaurant_id,reservation_id) REFERENCES reservations(restaurant_id,id);
-- 只允许固定版本与非敏感摘要，不把顾客备注或联系方式复制进队列payload。
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_payload_check CHECK (
  jsonb_typeof(payload)='object' AND payload->>'version'='1'
  AND (payload - ARRAY['version','reference','local_date','local_time','party_size','restaurant_name']::text[])='{}'::jsonb
);

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN
  ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password',
   'create_restaurant','update_restaurant','replace_opening_hours','upload_asset','delete_asset','website_chat',
   'website_generate','website_publish','website_job_failed','menu_recognition_requested','menu_updated',
   'menu_confirmed','menu_job_failed','reservation_settings_updated','reservation_decided','reservation_cancelled'));
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN
  ('user','restaurant','asset','website','menu','reservation'));

DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON reservations,reservation_events,reservation_access_tokens FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON reservations,reservation_events,reservation_access_tokens TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,public_reference,customer_user_id,source,website_version_id,
        guest_name,guest_email,guest_email_normalized,guest_phone,party_size,requested_local_date,requested_local_time,
        timezone_snapshot,requested_start_at,guest_note,privacy_notice_version,privacy_notice_shown_at,
        idempotency_key,initial_request_fingerprint,status,revision) ON reservations TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,decided_at,decided_by_user_id,decision_reason,cancelled_at,cancelled_by_type,revision,updated_at) ON reservations TO %I',role_name);
      EXECUTE format('GRANT INSERT ON reservation_events TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,reservation_id,token_hash,expires_at) ON reservation_access_tokens TO %I',role_name);
      EXECUTE format('GRANT UPDATE(revoked_at) ON reservation_access_tokens TO %I',role_name);
      -- 001只授权了资料和营业时间，订位开关需要追加列权限。
      EXECUTE format('GRANT UPDATE(reservation_enabled,reservation_notice,privacy_notice_version) ON restaurants TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
