-- 仅显式登记的 development_test 自然月消费；观察模式及非收费策略保持不变。
CREATE TABLE ai_calendar_credit_grants (
  period_id text PRIMARY KEY,
  billing_account_id text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC' CHECK (timezone='UTC'),
  tokens_per_credit integer NOT NULL DEFAULT 100 CHECK (tokens_per_credit=100),
  origin text NOT NULL DEFAULT 'development_test' CHECK (origin='development_test'),
  actor_user_id text NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  auto_renew boolean NOT NULL DEFAULT false CHECK (auto_renew=false),
  FOREIGN KEY(period_id,billing_account_id) REFERENCES ai_quota_periods(id,billing_account_id),
  FOREIGN KEY(billing_account_id,actor_user_id) REFERENCES billing_accounts(id,owner_user_id)
);
CREATE INDEX ai_calendar_credit_grants_account ON ai_calendar_credit_grants(billing_account_id,granted_at,period_id);

CREATE FUNCTION guard_ai_calendar_credit_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE p public.ai_quota_periods; amount bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '自然月测试积分登记不可变' USING ERRCODE='23514'; END IF;
  -- 授额仅锁 user → account → period；非键锁兼容消费 INSERT 的 FK KEY SHARE，避免反序等待。
  PERFORM 1 FROM public.users WHERE id=NEW.actor_user_id AND status='active' AND email_verified_at IS NOT NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '授额需要真实已验证活跃用户' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.billing_accounts WHERE id=NEW.billing_account_id AND owner_user_id=NEW.actor_user_id AND status='active' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '授额需要活跃归属账户' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM public.ai_quota_periods WHERE id=NEW.period_id AND billing_account_id=NEW.billing_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '自然月周期归属不匹配' USING ERRCODE='23503'; END IF;
  IF p.kind<>'trial' OR p.starts_at<>(date_trunc('month',p.starts_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') OR
      p.ends_at<>((date_trunc('month',p.starts_at AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC') OR
      NEW.granted_at<p.starts_at OR NEW.granted_at>=p.ends_at OR NEW.granted_at>clock_timestamp() THEN
    RAISE EXCEPTION '测试积分仅登记已发生的 UTC 自然月 trial 授额' USING ERRCODE='23514';
  END IF;
  SELECT delta_granted_tokens INTO amount FROM public.ai_quota_ledger
    WHERE period_id=p.id AND billing_account_id=p.billing_account_id AND entry_type='grant' AND call_id IS NULL
      AND idempotency_key=p.grant_key AND actor_user_id=NEW.actor_user_id AND reason_code='DEVELOPMENT_TEST_GRANT'
      AND delta_granted_tokens>0 AND delta_granted_tokens%100=0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0;
  IF NOT FOUND OR p.granted_tokens IS DISTINCT FROM amount OR p.reserved_tokens<>0 OR p.consumed_tokens<>0 OR
      (SELECT count(*) FROM public.ai_quota_ledger WHERE period_id=p.id)<>1 THEN
    RAISE EXCEPTION '登记必须在唯一真实授额账本投影之后' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_calendar_credit_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_calendar_credit_grants
  FOR EACH ROW EXECUTE FUNCTION guard_ai_calendar_credit_grant();

-- 010 的匿名 CHECK 名称由 PG 生成；只扩枚举和五字段 entry 形状，不动各 numeric 安全边界。
DO $checks$
DECLARE c record; entry_att smallint; enum_checks integer:=0; shape_checks integer:=0;
BEGIN
  SELECT attnum INTO entry_att FROM pg_attribute WHERE attrelid='public.ai_quota_ledger'::regclass AND attname='entry_type';
  FOR c IN SELECT conname,conkey,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.ai_quota_ledger'::regclass AND contype='c' LOOP
    IF c.conkey=ARRAY[entry_att]::smallint[] AND c.definition LIKE '%entry_type%' AND
        c.definition LIKE '%''grant''%' AND c.definition LIKE '%''expire''%' THEN
      EXECUTE format('ALTER TABLE public.ai_quota_ledger DROP CONSTRAINT %I',c.conname);
      enum_checks:=enum_checks+1;
    ELSIF cardinality(c.conkey)=5 AND entry_att=ANY(c.conkey) AND c.definition LIKE '%entry_type%' AND
        c.definition LIKE '%call_id%' AND c.definition LIKE '%delta_granted_tokens%' AND
        c.definition LIKE '%delta_reserved_tokens%' AND c.definition LIKE '%delta_consumed_tokens%' AND
        c.definition LIKE '%''reserve''%' AND c.definition LIKE '%''expire''%' THEN
      EXECUTE format('ALTER TABLE public.ai_quota_ledger DROP CONSTRAINT %I',c.conname);
      shape_checks:=shape_checks+1;
    END IF;
  END LOOP;
  IF enum_checks<>1 OR shape_checks<>1 THEN RAISE EXCEPTION '010 账本 CHECK 结构不匹配'; END IF;
END $checks$;
ALTER TABLE ai_quota_ledger ADD CONSTRAINT ai_quota_ledger_calendar_entry_type
  CHECK (entry_type IN ('grant','reserve','settle','release','adjust','expire','consume'));
ALTER TABLE ai_quota_ledger ADD CONSTRAINT ai_quota_ledger_calendar_entry_shape CHECK (
  (entry_type='grant' AND call_id IS NULL AND delta_granted_tokens>0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0) OR
  (entry_type='reserve' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens>0 AND delta_consumed_tokens=0) OR
  (entry_type='settle' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens<0 AND delta_consumed_tokens>=0) OR
  (entry_type='release' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens<0 AND delta_consumed_tokens=0) OR
  (entry_type='adjust' AND call_id IS NULL AND delta_granted_tokens<>0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0) OR
  (entry_type='expire' AND call_id IS NULL AND delta_granted_tokens<0 AND delta_reserved_tokens=0 AND delta_consumed_tokens=0) OR
  (entry_type='consume' AND call_id IS NOT NULL AND delta_granted_tokens=0 AND delta_reserved_tokens=0 AND delta_consumed_tokens>=0)
);
CREATE UNIQUE INDEX ai_quota_ledger_calendar_consume_call ON ai_quota_ledger(call_id) WHERE entry_type='consume';

CREATE FUNCTION guard_ai_calendar_consume() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.entry_type='consume' THEN
    -- 调用完成的事务已经持有 call 锁；这里仅追加 period 锁，绝不反向锁旧调用。
    PERFORM 1 FROM public.ai_quota_periods WHERE id=NEW.period_id AND billing_account_id=NEW.billing_account_id FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM public.ai_calendar_credit_grants g
      JOIN public.ai_quota_periods p ON p.id=g.period_id AND p.billing_account_id=g.billing_account_id
      JOIN public.billing_accounts a ON a.id=g.billing_account_id AND a.owner_user_id=g.actor_user_id
      JOIN public.ai_model_calls c ON c.id=NEW.call_id AND c.billing_account_id=a.id AND c.requesting_user_id=a.owner_user_id
      WHERE g.period_id=NEW.period_id AND g.billing_account_id=NEW.billing_account_id AND g.actor_user_id=NEW.actor_user_id
        AND p.kind='trial' AND c.origin='live' AND c.usage_status='known'
        AND c.prompt_tokens IS NOT NULL AND c.completion_tokens IS NOT NULL AND c.total_tokens IS NOT NULL
        AND c.prompt_tokens::numeric+c.completion_tokens::numeric=c.total_tokens::numeric
        AND c.created_at>=g.granted_at AND c.created_at>=p.starts_at AND c.created_at<p.ends_at
        AND NEW.delta_consumed_tokens=c.total_tokens AND NEW.delta_granted_tokens=0 AND NEW.delta_reserved_tokens=0
        AND NEW.reason_code='DEVELOPMENT_TEST_USAGE' AND NEW.idempotency_key='calendar-test:'||c.id
    ) OR EXISTS(SELECT 1 FROM public.ai_quota_ledger WHERE call_id=NEW.call_id AND entry_type IN ('reserve','settle','release')) THEN
      RAISE EXCEPTION '测试积分消费必须对应登记后真实且未预留的同归属 known 调用' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.entry_type IN ('reserve','settle','release') THEN
    PERFORM 1 FROM public.ai_quota_periods WHERE id=NEW.period_id AND billing_account_id=NEW.billing_account_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.ai_quota_ledger WHERE call_id=NEW.call_id AND entry_type='consume') THEN
      RAISE EXCEPTION '已直接消费的调用不能再预留或结算' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_quota_ledger_calendar_guard BEFORE INSERT ON ai_quota_ledger FOR EACH ROW EXECUTE FUNCTION guard_ai_calendar_consume();

CREATE FUNCTION book_ai_calendar_consumption() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE g public.ai_calendar_credit_grants; p public.ai_quota_periods;
BEGIN
  -- 未登记的全局观察账户不触及 quota/ledger，保持 010 的无授额、无消费行为。
  SELECT * INTO g FROM public.ai_calendar_credit_grants
    WHERE billing_account_id=NEW.billing_account_id AND actor_user_id=NEW.requesting_user_id AND granted_at<=NEW.created_at;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.ai_quota_periods WHERE id=g.period_id AND billing_account_id=g.billing_account_id
    AND starts_at<=NEW.created_at AND NEW.created_at<ends_at AND kind='trial' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.ai_quota_ledger(id,period_id,billing_account_id,call_id,entry_type,idempotency_key,
    delta_granted_tokens,delta_reserved_tokens,delta_consumed_tokens,reason_code,actor_user_id)
  VALUES('aql_'||translate(encode(decode(substr(md5(random()::text||clock_timestamp()::text)||md5(random()::text),1,36),'hex'),'base64'),'+/','-_'),
    p.id,p.billing_account_id,NEW.id,'consume','calendar-test:'||NEW.id,0,0,NEW.total_tokens,'DEVELOPMENT_TEST_USAGE',g.actor_user_id)
  ON CONFLICT DO NOTHING;
  -- 仍由 010 project_ai_quota_entry 更新并校验投影，不独立写余额。
  RETURN NEW;
END $fn$;
CREATE TRIGGER ai_model_call_calendar_consumption AFTER INSERT OR UPDATE OF usage_status ON ai_model_calls
  FOR EACH ROW WHEN (NEW.origin='live' AND NEW.usage_status='known') EXECUTE FUNCTION book_ai_calendar_consumption();

REVOKE ALL ON ai_calendar_credit_grants FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_ai_calendar_credit_grant(),guard_ai_calendar_consume(),book_ai_calendar_consumption() FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ai_calendar_credit_grants FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON ai_calendar_credit_grants TO %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION guard_ai_calendar_credit_grant(),guard_ai_calendar_consume(),book_ai_calendar_consumption() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION apply_ai_quota_entry(text,text,text,text,text,bigint,bigint,bigint,text,text) FROM %I',role_name);
    END IF;
  END LOOP;
END $grant$;
