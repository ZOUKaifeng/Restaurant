-- 只保存站点服务端确认的匿名事件；去重摘要永久跨类型、版本生效。
CREATE TABLE analytics_events (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  version_id text NOT NULL,
  publication_revision integer NOT NULL CHECK (publication_revision>0),
  namespace text NOT NULL CHECK (namespace IN ('local_test','production')),
  metric_version text NOT NULL DEFAULT 'v1' CHECK (metric_version='v1'),
  event_type text NOT NULL CHECK (event_type IN ('page_view','reservation_click','reservation_form_view')),
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
  local_date date NOT NULL CHECK (isfinite(local_date)),
  timezone_snapshot varchar(64) NOT NULL,
  timezone_fallback boolean NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (restaurant_id,version_id) REFERENCES website_versions(restaurant_id,id),
  UNIQUE (restaurant_id,namespace,dedupe_key),
  CHECK (NOT timezone_fallback OR timezone_snapshot='UTC'),
  CHECK (local_date=(occurred_at AT TIME ZONE timezone_snapshot)::date)
);
CREATE INDEX analytics_events_days ON analytics_events(restaurant_id,namespace,local_date);

-- 同一日曾使用不同时区或 UTC 回退时分别保存，不按餐厅当前时区重解释历史。
CREATE TABLE analytics_daily (
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  namespace text NOT NULL CHECK (namespace IN ('local_test','production')),
  metric_version text NOT NULL DEFAULT 'v1' CHECK (metric_version='v1'),
  local_date date NOT NULL CHECK (isfinite(local_date)),
  timezone_snapshot varchar(64) NOT NULL,
  timezone_fallback boolean NOT NULL,
  page_views bigint NOT NULL DEFAULT 0 CHECK (page_views BETWEEN 0 AND 9007199254740991),
  reservation_clicks bigint NOT NULL DEFAULT 0 CHECK (reservation_clicks BETWEEN 0 AND 9007199254740991),
  reservation_form_views bigint NOT NULL DEFAULT 0 CHECK (reservation_form_views BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (restaurant_id,namespace,metric_version,local_date,timezone_snapshot,timezone_fallback),
  CHECK (NOT timezone_fallback OR timezone_snapshot='UTC')
);

-- 使用调用者权限查 PG 自带时区表；不接受任意 POSIX 偏移表达式，不提升权限。
CREATE FUNCTION guard_analytics_timezone() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.timezone_snapshot !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.timezone_snapshot) THEN
    RAISE EXCEPTION '分析时区不合法' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER analytics_event_timezone BEFORE INSERT ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION guard_analytics_timezone();
CREATE TRIGGER analytics_daily_timezone BEFORE INSERT OR UPDATE ON analytics_daily
  FOR EACH ROW EXECUTE FUNCTION guard_analytics_timezone();
REVOKE ALL ON FUNCTION guard_analytics_timezone() FROM PUBLIC;

CREATE FUNCTION guard_analytics_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  RAISE EXCEPTION '分析事件只追加不可修改或删除' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER analytics_event_guard BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION guard_analytics_event();
REVOKE ALL ON FUNCTION guard_analytics_event() FROM PUBLIC;

REVOKE ALL ON analytics_events,analytics_daily FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON analytics_events,analytics_daily FROM %I',role_name);
      EXECUTE format('GRANT SELECT(id,restaurant_id,version_id,publication_revision,namespace,metric_version,
        event_type,occurred_at,local_date,timezone_snapshot,timezone_fallback,dedupe_key,created_at)
        ON analytics_events TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,restaurant_id,version_id,publication_revision,namespace,metric_version,
        event_type,occurred_at,local_date,timezone_snapshot,timezone_fallback,dedupe_key)
        ON analytics_events TO %I',role_name);
      EXECUTE format('GRANT SELECT,INSERT,DELETE ON analytics_daily TO %I',role_name);
      EXECUTE format('GRANT UPDATE(page_views,reservation_clicks,reservation_form_views,updated_at)
        ON analytics_daily TO %I',role_name);
    END IF;
  END LOOP;
END $grant$;
