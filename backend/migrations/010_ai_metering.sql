-- 观察模式仅记录真实调用；不自动授予、预留或消费额度。
ALTER TABLE website_jobs ADD CONSTRAINT website_jobs_ai_identity UNIQUE(id,restaurant_id,requesting_user_id);
ALTER TABLE menu_jobs ADD CONSTRAINT menu_jobs_ai_identity UNIQUE(id,restaurant_id,requesting_user_id);

CREATE TABLE billing_accounts (
  id text PRIMARY KEY CHECK (id ~ '^bla_[A-Za-z0-9_-]{24}$'),
  owner_user_id text NOT NULL UNIQUE REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,owner_user_id)
);
INSERT INTO billing_accounts(id,owner_user_id)
SELECT 'bla_'||translate(encode(decode(substr(md5(random()::text||clock_timestamp()::text||id)||md5(random()::text),1,36),'hex'),'base64'),'+/','-_'),id
FROM users;

CREATE TABLE ai_model_calls (
  id text PRIMARY KEY CHECK (id ~ '^aic_[A-Za-z0-9_-]{24}$'),
  billing_account_id text NOT NULL,
  requesting_user_id text NOT NULL REFERENCES users(id),
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  website_job_id text,
  menu_job_id text,
  feature text NOT NULL CHECK (feature IN ('website_chat','website_generate','menu_recognition')),
  provider text NOT NULL DEFAULT 'deepseek' CHECK (provider='deepseek'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  call_index integer NOT NULL CHECK (call_index>0),
  runner_token uuid,
  request_key text NOT NULL UNIQUE,
  policy_version text NOT NULL DEFAULT 'observation-v1' CHECK (policy_version='observation-v1'),
  origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live','legacy_import')),
  chargeable boolean NOT NULL DEFAULT false CHECK (chargeable=false),
  legacy_source_key text UNIQUE,
  call_status text NOT NULL DEFAULT 'started' CHECK (call_status IN ('started','completed','failed')),
  usage_status text NOT NULL DEFAULT 'pending' CHECK (usage_status IN ('pending','known','unknown')),
  prompt_tokens bigint CHECK (prompt_tokens BETWEEN 0 AND 9007199254740991),
  completion_tokens bigint CHECK (completion_tokens BETWEEN 0 AND 9007199254740991),
  total_tokens bigint CHECK (total_tokens BETWEEN 0 AND 9007199254740991),
  elapsed_ms bigint CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  received_at timestamptz,
  UNIQUE(website_job_id,call_index), UNIQUE(menu_job_id,call_index),
  UNIQUE(id,billing_account_id),
  FOREIGN KEY(billing_account_id,requesting_user_id) REFERENCES billing_accounts(id,owner_user_id),
  FOREIGN KEY(website_job_id,restaurant_id,requesting_user_id) REFERENCES website_jobs(id,restaurant_id,requesting_user_id),
  FOREIGN KEY(menu_job_id,restaurant_id,requesting_user_id) REFERENCES menu_jobs(id,restaurant_id,requesting_user_id),
  CHECK ((website_job_id IS NOT NULL)<>(menu_job_id IS NOT NULL)),
  CHECK ((website_job_id IS NOT NULL AND feature IN ('website_chat','website_generate')) OR
    (menu_job_id IS NOT NULL AND feature='menu_recognition')),
  CHECK (request_key=coalesce(website_job_id,menu_job_id)||':'||call_index::text),
  CHECK (origin<>'live' OR runner_token IS NOT NULL),
  CHECK ((origin='live' AND legacy_source_key IS NULL) OR
    (origin='legacy_import' AND website_job_id IS NOT NULL AND feature='website_generate' AND
      legacy_source_key IS NOT NULL AND legacy_source_key='website_model_calls:'||website_job_id||':'||call_index::text)),
  CHECK ((usage_status='known' AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens IS NOT NULL
      AND prompt_tokens::numeric+completion_tokens::numeric=total_tokens::numeric AND received_at IS NOT NULL) OR
    (usage_status IN ('pending','unknown') AND prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL AND received_at IS NULL)),
  CHECK ((call_status='started' AND usage_status='pending' AND finished_at IS NULL AND elapsed_ms IS NULL AND error_code IS NULL) OR
    (call_status IN ('completed','failed') AND usage_status IN ('known','unknown') AND finished_at IS NOT NULL)),
  CHECK (call_status='failed' OR error_code IS NULL),
  CHECK (finished_at IS NULL OR finished_at>=created_at),
  CHECK (received_at IS NULL OR (finished_at IS NOT NULL AND received_at>=finished_at))
);
CREATE INDEX ai_model_calls_account_time ON ai_model_calls(billing_account_id,created_at DESC,id DESC);
CREATE INDEX ai_model_calls_account_filter ON ai_model_calls(billing_account_id,restaurant_id,feature,origin,created_at DESC,id DESC);

-- 007 只有 generate 的逐调用事实。没有逐调用事实的 usage 聚合不展开。
-- 旧表没有逐调用 model，使用任务结果版本的 model；缺失时显式标记 legacy-unknown。
INSERT INTO ai_model_calls(id,billing_account_id,requesting_user_id,restaurant_id,website_job_id,
  feature,model,call_index,runner_token,request_key,origin,legacy_source_key,call_status,usage_status,
  prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code,created_at,finished_at,received_at)
SELECT 'aic_'||translate(encode(decode(substr(md5('website_model_calls:'||c.job_id||':'||c.call_index::text),1,32)||'0000','hex'),'base64'),'+/','-_'),
  a.id,j.requesting_user_id,j.restaurant_id,j.id,'website_generate',coalesce(v.model,'legacy-unknown'),c.call_index,c.runner_token,
  c.job_id||':'||c.call_index::text,'legacy_import','website_model_calls:'||c.job_id||':'||c.call_index::text,c.status,
  CASE WHEN c.status='started' THEN 'pending' WHEN c.total_tokens IS NULL THEN 'unknown' ELSE 'known' END,
  c.prompt_tokens,c.completion_tokens,c.total_tokens,CASE WHEN c.status='started' THEN NULL ELSE c.elapsed_ms END,
  c.error_code,c.created_at,CASE WHEN c.status='started' THEN NULL ELSE greatest(c.updated_at,c.created_at) END,
  CASE WHEN c.total_tokens IS NOT NULL THEN greatest(c.updated_at,c.created_at) END
FROM website_model_calls c JOIN website_jobs j ON j.id=c.job_id AND j.kind='generate'
JOIN billing_accounts a ON a.owner_user_id=j.requesting_user_id
LEFT JOIN website_versions v ON v.id=j.result_version_id AND v.restaurant_id=j.restaurant_id;

CREATE FUNCTION guard_billing_account() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '计量账户历史不可删除' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.created_at) THEN
    RAISE EXCEPTION '计量账户归属不可转移' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER billing_account_guard BEFORE UPDATE OR DELETE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION guard_billing_account();

-- worker 先持有 user → restaurant → member → job 锁；这里不逆序追加旧实体锁。
-- 导入完成后才安装 INSERT guard，运行时任何角色都不能伪造 legacy 或终态。
CREATE FUNCTION guard_ai_model_call() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE actual_feature text; valid_lease boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI 调用历史不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.origin<>'live' OR NEW.call_status<>'started' OR NEW.usage_status<>'pending' THEN
      RAISE EXCEPTION '运行时只允许开始真实调用' USING ERRCODE='23514';
    END IF;
    IF NEW.website_job_id IS NOT NULL THEN
      SELECT CASE j.kind WHEN 'chat' THEN 'website_chat' WHEN 'generate' THEN 'website_generate' END,
        j.status='running' AND j.lease_token=NEW.runner_token AND j.lease_expires_at>clock_timestamp()
      INTO actual_feature,valid_lease FROM public.website_jobs j
      WHERE j.id=NEW.website_job_id AND j.restaurant_id=NEW.restaurant_id AND j.requesting_user_id=NEW.requesting_user_id;
    ELSE
      SELECT 'menu_recognition',j.status='running' AND j.lease_token=NEW.runner_token AND j.lease_expires_at>clock_timestamp()
      INTO actual_feature,valid_lease FROM public.menu_jobs j
      WHERE j.id=NEW.menu_job_id AND j.restaurant_id=NEW.restaurant_id AND j.requesting_user_id=NEW.requesting_user_id;
    END IF;
    IF valid_lease IS DISTINCT FROM true OR NEW.feature IS DISTINCT FROM actual_feature OR NOT EXISTS (
      SELECT 1 FROM public.users u JOIN public.restaurant_members m ON m.user_id=u.id
      JOIN public.restaurants r ON r.id=m.restaurant_id
      WHERE u.id=NEW.requesting_user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
        AND r.id=NEW.restaurant_id AND r.status IN ('draft','active') AND m.role='owner' AND m.status='active'
    ) THEN RAISE EXCEPTION '调用需要有效租约及真实已验证店主' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['call_status','usage_status','prompt_tokens','completion_tokens','total_tokens','elapsed_ms','error_code','finished_at','received_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['call_status','usage_status','prompt_tokens','completion_tokens','total_tokens','elapsed_ms','error_code','finished_at','received_at']) THEN
    RAISE EXCEPTION 'AI 调用 identity、模型和来源不可变' USING ERRCODE='23514';
  END IF;
  IF OLD.call_status='started' THEN
    IF NEW.call_status NOT IN ('completed','failed') THEN
      RAISE EXCEPTION 'AI 调用只可从开始进入终态' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.call_status,NEW.elapsed_ms,NEW.error_code,NEW.finished_at) IS DISTINCT FROM
      (OLD.call_status,OLD.elapsed_ms,OLD.error_code,OLD.finished_at) THEN
      RAISE EXCEPTION 'AI 调用终态不可覆写或复活' USING ERRCODE='23514';
    END IF;
    IF NEW IS DISTINCT FROM OLD AND NOT (OLD.usage_status='unknown' AND NEW.usage_status='known') THEN
      RAISE EXCEPTION 'AI 调用终态只允许一次补充未知用量' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_model_call_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_model_calls FOR EACH ROW EXECUTE FUNCTION guard_ai_model_call();

CREATE TABLE ai_quota_periods (
  id text PRIMARY KEY CHECK (id ~ '^aqp_[A-Za-z0-9_-]{24}$'),
  billing_account_id text NOT NULL REFERENCES billing_accounts(id),
  kind text NOT NULL CHECK (kind IN ('trial','paid')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  grant_key varchar(128) NOT NULL UNIQUE CHECK (grant_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  granted_tokens bigint NOT NULL DEFAULT 0 CHECK (granted_tokens BETWEEN 0 AND 9007199254740991),
  reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens BETWEEN 0 AND 9007199254740991),
  consumed_tokens bigint NOT NULL DEFAULT 0 CHECK (consumed_tokens BETWEEN 0 AND 9007199254740991),
  available_tokens bigint GENERATED ALWAYS AS (granted_tokens-reserved_tokens-consumed_tokens) STORED
    CHECK (available_tokens BETWEEN -9007199254740991 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,billing_account_id), UNIQUE(billing_account_id,grant_key)
);
CREATE INDEX ai_quota_periods_account ON ai_quota_periods(billing_account_id,starts_at DESC,id);
CREATE UNIQUE INDEX ai_quota_trial_once_per_account ON ai_quota_periods(billing_account_id) WHERE kind='trial';
CREATE TABLE ai_quota_ledger (
  id text PRIMARY KEY CHECK (id ~ '^aql_[A-Za-z0-9_-]{24}$'),
  period_id text NOT NULL,
  billing_account_id text NOT NULL REFERENCES billing_accounts(id),
  call_id text,
  entry_type text NOT NULL CHECK (entry_type IN ('grant','reserve','settle','release','adjust','expire')),
  idempotency_key varchar(128) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  delta_granted_tokens bigint NOT NULL CHECK (delta_granted_tokens BETWEEN -9007199254740991 AND 9007199254740991),
  delta_reserved_tokens bigint NOT NULL CHECK (delta_reserved_tokens BETWEEN -9007199254740991 AND 9007199254740991),
  delta_consumed_tokens bigint NOT NULL CHECK (delta_consumed_tokens BETWEEN -9007199254740991 AND 9007199254740991),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  actor_user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(period_id,billing_account_id) REFERENCES ai_quota_periods(id,billing_account_id),
  FOREIGN KEY(call_id,billing_account_id) REFERENCES ai_model_calls(id,billing_account_id),
  CHECK (
    (entry_type='grant' AND call_id IS NULL AND delta_granted_tokens>0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0) OR
    (entry_type='reserve' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens>0 AND delta_consumed_tokens=0) OR
    (entry_type='settle' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens<0 AND delta_consumed_tokens>=0) OR
    (entry_type='release' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens<0 AND delta_consumed_tokens=0) OR
    (entry_type='adjust' AND call_id IS NULL AND delta_granted_tokens<>0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0) OR
    (entry_type='expire' AND call_id IS NULL AND delta_granted_tokens<0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0)
  )
);
CREATE INDEX ai_quota_ledger_period ON ai_quota_ledger(period_id,created_at,id);
CREATE UNIQUE INDEX ai_quota_ledger_call_action ON ai_quota_ledger(call_id,entry_type) WHERE entry_type IN ('reserve','settle','release');

-- 投影不是独立可写余额；即使 owner 直接写入 ledger 也必须锁 period 并更新投影。
CREATE FUNCTION guard_ai_quota_period() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE granted numeric; reserved numeric; consumed numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '额度周期不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF (NEW.granted_tokens,NEW.reserved_tokens,NEW.consumed_tokens) IS DISTINCT FROM (0::bigint,0::bigint,0::bigint) THEN
      RAISE EXCEPTION '额度只能通过账本授予' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.billing_account_id,NEW.kind,NEW.starts_at,NEW.ends_at,NEW.grant_key,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.billing_account_id,OLD.kind,OLD.starts_at,OLD.ends_at,OLD.grant_key,OLD.created_at) THEN
    RAISE EXCEPTION '额度周期归属及边界不可变' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(sum(delta_granted_tokens),0),coalesce(sum(delta_reserved_tokens),0),coalesce(sum(delta_consumed_tokens),0)
    INTO granted,reserved,consumed FROM public.ai_quota_ledger WHERE period_id=NEW.id;
  IF (NEW.granted_tokens::numeric,NEW.reserved_tokens::numeric,NEW.consumed_tokens::numeric) IS DISTINCT FROM (granted,reserved,consumed) THEN
    RAISE EXCEPTION '额度投影必须与账本守恒' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_quota_period_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_quota_periods FOR EACH ROW EXECUTE FUNCTION guard_ai_quota_period();

CREATE FUNCTION guard_ai_quota_ledger() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE outstanding numeric; available bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '额度账本只可追加' USING ERRCODE='23514'; END IF;
  SELECT available_tokens INTO available FROM public.ai_quota_periods
    WHERE id=NEW.period_id AND billing_account_id=NEW.billing_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '额度周期归属不匹配' USING ERRCODE='23503'; END IF;
  -- 锁后检查可用量，真实结算可超预留，但新预留不能双花或继续扩大负余额。
  IF NEW.entry_type='reserve' AND NEW.delta_reserved_tokens>available THEN
    RAISE EXCEPTION '额度不足以预留新调用' USING ERRCODE='23514';
  END IF;
  -- ON CONFLICT 重试先由调用函数检查；直接 INSERT 仍由唯一约束阻止重复。
  IF NEW.entry_type IN ('settle','release') THEN
    SELECT coalesce(sum(delta_reserved_tokens),0) INTO outstanding FROM public.ai_quota_ledger
      WHERE period_id=NEW.period_id AND call_id=NEW.call_id;
    IF outstanding<=0 OR NEW.delta_reserved_tokens::numeric<>-outstanding THEN
      RAISE EXCEPTION '结算或释放必须且只能关闭本调用的预留' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_quota_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_quota_ledger FOR EACH ROW EXECUTE FUNCTION guard_ai_quota_ledger();
CREATE FUNCTION project_ai_quota_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  UPDATE public.ai_quota_periods SET granted_tokens=granted_tokens+NEW.delta_granted_tokens,
    reserved_tokens=reserved_tokens+NEW.delta_reserved_tokens,consumed_tokens=consumed_tokens+NEW.delta_consumed_tokens
    WHERE id=NEW.period_id AND billing_account_id=NEW.billing_account_id;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_quota_entry_projection AFTER INSERT ON ai_quota_ledger FOR EACH ROW EXECUTE FUNCTION project_ai_quota_entry();

CREATE FUNCTION apply_ai_quota_entry(
  p_period_id text,p_billing_account_id text,p_call_id text,p_entry_type text,p_idempotency_key text,
  p_delta_granted_tokens bigint,p_delta_reserved_tokens bigint,p_delta_consumed_tokens bigint,
  p_reason_code text,p_actor_user_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE existing public.ai_quota_ledger; entry_id text;
BEGIN
  PERFORM 1 FROM public.ai_quota_periods WHERE id=p_period_id AND billing_account_id=p_billing_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '额度周期归属不匹配' USING ERRCODE='23503'; END IF;
  SELECT * INTO existing FROM public.ai_quota_ledger WHERE idempotency_key=p_idempotency_key;
  IF NOT FOUND THEN
    entry_id:='aql_'||translate(encode(decode(substr(md5(random()::text||clock_timestamp()::text)||md5(random()::text),1,36),'hex'),'base64'),'+/','-_');
    INSERT INTO public.ai_quota_ledger(id,period_id,billing_account_id,call_id,entry_type,idempotency_key,
      delta_granted_tokens,delta_reserved_tokens,delta_consumed_tokens,reason_code,actor_user_id)
    VALUES(entry_id,p_period_id,p_billing_account_id,p_call_id,p_entry_type,p_idempotency_key,
      p_delta_granted_tokens,p_delta_reserved_tokens,p_delta_consumed_tokens,p_reason_code,p_actor_user_id)
    ON CONFLICT(idempotency_key) DO NOTHING RETURNING * INTO existing;
    IF FOUND THEN RETURN existing.id; END IF;
    SELECT * INTO existing FROM public.ai_quota_ledger WHERE idempotency_key=p_idempotency_key;
  END IF;
  IF (existing.period_id,existing.billing_account_id,existing.call_id,existing.entry_type,
      existing.delta_granted_tokens,existing.delta_reserved_tokens,existing.delta_consumed_tokens,existing.reason_code,existing.actor_user_id)
    IS DISTINCT FROM (p_period_id,p_billing_account_id,p_call_id,p_entry_type,
      p_delta_granted_tokens,p_delta_reserved_tokens,p_delta_consumed_tokens,p_reason_code,p_actor_user_id) THEN
    RAISE EXCEPTION '额度幂等键不可用于不同请求' USING ERRCODE='23514';
  END IF;
  RETURN existing.id;
END $fn$;
REVOKE ALL ON billing_accounts,ai_model_calls,ai_quota_periods,ai_quota_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_billing_account(),guard_ai_model_call(),guard_ai_quota_period(),guard_ai_quota_ledger(),project_ai_quota_entry(),
  apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text) FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON billing_accounts,ai_model_calls,ai_quota_periods,ai_quota_ledger FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON billing_accounts,ai_model_calls,ai_quota_periods,ai_quota_ledger TO %I',role_name);
      EXECUTE format('GRANT SELECT(version,applied_at) ON schema_migrations TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,owner_user_id) ON billing_accounts TO %I',role_name);
      EXECUTE format('GRANT INSERT(id,billing_account_id,requesting_user_id,restaurant_id,website_job_id,menu_job_id,feature,model,call_index,runner_token,request_key) ON ai_model_calls TO %I',role_name);
      EXECUTE format('GRANT UPDATE(call_status,usage_status,prompt_tokens,completion_tokens,total_tokens,elapsed_ms,error_code,finished_at,received_at) ON ai_model_calls TO %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text) FROM %I',role_name);
    END IF;
  END LOOP;
END $grant$;
