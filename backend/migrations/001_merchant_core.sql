REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE users (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  email varchar(254) NOT NULL, email_normalized varchar(254) NOT NULL UNIQUE,
  email_verified_at timestamptz, display_name varchar(100), locale varchar(35) NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','active','suspended','deleted')),
  platform_role text NOT NULL DEFAULT 'none' CHECK(platform_role IN ('none','support','admin')),
  last_login_at timestamptz, terms_version varchar(64) NOT NULL, terms_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status <> 'active' OR email_verified_at IS NOT NULL)
);
CREATE TABLE auth_identities (
  id text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES users(id),
  provider text NOT NULL CHECK(provider IN ('password','managed')), provider_subject text,
  password_hash text, credential_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_subject),
  CHECK((provider='password' AND password_hash IS NOT NULL AND provider_subject IS NULL) OR
        (provider='managed' AND password_hash IS NULL AND provider_subject IS NOT NULL))
);
CREATE TABLE auth_sessions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), session_secret_hash text UNIQUE,
  provider_session_id text, expires_at timestamptz NOT NULL, revoked_at timestamptz, last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((session_secret_hash IS NOT NULL) <> (provider_session_id IS NOT NULL))
);
CREATE INDEX auth_sessions_user_valid ON auth_sessions(user_id,revoked_at,expires_at);
CREATE TABLE restaurants (
  id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{16,64}$'),
  created_by_user_id text NOT NULL REFERENCES users(id),
  create_idempotency_key varchar(128) NOT NULL CHECK(create_idempotency_key ~ '^[A-Za-z0-9_.:-]{16,128}$'),
  create_request_fingerprint text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  slug varchar(100) NOT NULL UNIQUE, name varchar(150) NOT NULL CHECK(length(btrim(name))>0),
  description varchar(2000), cuisine_label varchar(100), country_code varchar(2) CHECK(country_code ~ '^[A-Z]{2}$'),
  region varchar(100), city varchar(100), address_line1 varchar(200), address_line2 varchar(200), postal_code varchar(32),
  contact_email varchar(254), phone varchar(16), timezone varchar(64), currency_code varchar(3) CHECK(currency_code ~ '^[A-Z]{3}$'),
  primary_locale varchar(35) NOT NULL, reservation_enabled boolean NOT NULL DEFAULT false,
  reservation_notice varchar(2000), privacy_notice_version varchar(64),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','suspended','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by_user_id,create_idempotency_key)
);
CREATE TABLE restaurant_members (
  id text PRIMARY KEY, restaurant_id text NOT NULL REFERENCES restaurants(id), user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role='owner'), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(restaurant_id,user_id)
);
CREATE UNIQUE INDEX restaurant_single_owner ON restaurant_members(restaurant_id) WHERE status='active' AND role='owner';
CREATE INDEX restaurant_members_user ON restaurant_members(user_id,status);
CREATE INDEX restaurants_order ON restaurants(created_at DESC,id DESC);
CREATE TABLE auth_tokens (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  user_id text NOT NULL REFERENCES users(id), restaurant_id text REFERENCES restaurants(id),
  target_email_normalized varchar(254) NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(restaurant_id IS NULL)
);
CREATE INDEX auth_tokens_user_purpose ON auth_tokens(user_id,purpose,expires_at);
CREATE TABLE opening_hours (
  id text PRIMARY KEY, restaurant_id text NOT NULL REFERENCES restaurants(id),
  weekday integer NOT NULL CHECK(weekday BETWEEN 1 AND 7),
  opens_at_local time(0) NOT NULL CHECK(extract(second FROM opens_at_local)=0),
  closes_at_local time(0) NOT NULL CHECK(extract(second FROM closes_at_local)=0),
  closes_day_offset integer NOT NULL CHECK(closes_day_offset IN (0,1)), accepts_requests boolean NOT NULL,
  sort_order integer NOT NULL CHECK(sort_order BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(closes_at_local-opens_at_local+closes_day_offset*interval '1 day'>interval '0'),
  CHECK(closes_at_local-opens_at_local+closes_day_offset*interval '1 day'<=interval '1 day')
);
CREATE INDEX opening_hours_restaurant ON opening_hours(restaurant_id,weekday,sort_order);
CREATE TABLE email_outbox (
  id text PRIMARY KEY, restaurant_id text REFERENCES restaurants(id), category text NOT NULL CHECK(category='transactional'),
  template_key text NOT NULL CHECK(template_key IN ('verify_email','reset_password')), template_version text NOT NULL,
  recipient_email varchar(254) NOT NULL, recipient_email_normalized varchar(254) NOT NULL,
  recipient_email_key text NOT NULL, email_key_version integer NOT NULL DEFAULT 1,
  user_id text NOT NULL REFERENCES users(id), auth_token_id text NOT NULL REFERENCES auth_tokens(id),
  payload jsonb NOT NULL DEFAULT '{"version":1}'::jsonb CHECK(payload='{"version":1}'::jsonb),
  sensitive_payload_ciphertext text, sensitive_payload_expires_at timestamptz NOT NULL,
  dedupe_key text NOT NULL UNIQUE, scheduled_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','accepted','failed','cancelled','suppressed')),
  attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now(), lease_expires_at timestamptz, lease_token text,
  provider_message_id text, accepted_at timestamptz, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(restaurant_id IS NULL), CHECK(attempt_count>=0 AND max_attempts=1)
);
CREATE INDEX email_outbox_queue ON email_outbox(status,available_at);
CREATE TABLE audit_logs (
  id text PRIMARY KEY, restaurant_id text REFERENCES restaurants(id),
  actor_type text NOT NULL CHECK(actor_type IN ('merchant','platform_admin','system')), actor_user_id text REFERENCES users(id),
  action text NOT NULL CHECK(action IN ('register','verify_email','login','logout','logout_all','request_verification','request_reset','reset_password','create_restaurant','update_restaurant','replace_opening_hours')),
  entity_type text NOT NULL CHECK(entity_type IN ('user','restaurant')), entity_id text NOT NULL,
  request_id varchar(128) NOT NULL, outcome text NOT NULL CHECK(outcome IN ('success','denied','failed')),
  changed_fields text[] NOT NULL DEFAULT '{}', reason_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_restaurant_time ON audit_logs(restaurant_id,created_at);
CREATE INDEX audit_logs_request ON audit_logs(request_id);
-- 迁移只授权已由运维创建的应用角色，不创建角色或给予 DDL。
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I',role_name);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',role_name);
      EXECUTE format('GRANT SELECT ON users,auth_identities,auth_sessions,auth_tokens,restaurant_members,email_outbox,restaurants TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,email,email_normalized,display_name,locale,terms_version,terms_accepted_at) ON users TO %I',role_name);
      EXECUTE format('GRANT UPDATE(email_verified_at,status,last_login_at,updated_at) ON users TO %I',role_name);
      EXECUTE format('GRANT INSERT ON auth_identities,auth_sessions,auth_tokens,restaurant_members,email_outbox,restaurants,audit_logs TO %I',role_name);
      EXECUTE format('GRANT UPDATE(password_hash,credential_changed_at,updated_at) ON auth_identities TO %I',role_name);
      EXECUTE format('GRANT UPDATE(revoked_at,updated_at) ON auth_sessions TO %I',role_name);
      EXECUTE format('GRANT UPDATE(used_at,revoked_at) ON auth_tokens TO %I',role_name);
      EXECUTE format('GRANT UPDATE(status,sensitive_payload_ciphertext,updated_at,attempt_count,lease_token,lease_expires_at,provider_message_id,accepted_at,last_error_code) ON email_outbox TO %I',role_name);
      -- FOR UPDATE 的成员锁需要至少一个可更新列；不存在商家成员管理接口。
      EXECUTE format('GRANT UPDATE(updated_at) ON restaurant_members TO %I',role_name);
      EXECUTE format('GRANT UPDATE(name,description,cuisine_label,country_code,region,city,address_line1,address_line2,postal_code,contact_email,phone,timezone,currency_code,primary_locale,revision,updated_at) ON restaurants TO %I',role_name);
      EXECUTE format('GRANT SELECT, INSERT, DELETE ON opening_hours TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
