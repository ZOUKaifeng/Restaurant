-- 依赖 001 的 users、010 的 billing_accounts；本批只有目录与观察状态，不接通收费或额度授予。
CREATE TABLE billing_plan_versions (
  id text PRIMARY KEY CHECK (id ~ '^bpv_[A-Za-z0-9_-]{24}$'),
  code text NOT NULL CHECK (code IN ('maintain','build','unlimited')),
  version integer NOT NULL CHECK (version>0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  ai_mode text NOT NULL CHECK (ai_mode IN ('limited','unlimited')),
  monthly_credits bigint CHECK (monthly_credits BETWEEN 1 AND 9007199254740991),
  tokens_per_credit integer NOT NULL DEFAULT 100 CHECK (tokens_per_credit=100),
  allocation_status text NOT NULL DEFAULT 'proposed' CHECK (allocation_status IN ('proposed','confirmed')),
  grant_schedule text NOT NULL DEFAULT 'unconfirmed' CHECK (grant_schedule IN ('unconfirmed','service_month')),
  -- NULL 只表示尚未确认网站限额，不表示无限。
  hosted_site_limit integer CHECK (hosted_site_limit>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(code,version),
  CHECK ((ai_mode='limited' AND monthly_credits IS NOT NULL) OR (ai_mode='unlimited' AND monthly_credits IS NULL)),
  CHECK (status<>'active' OR (allocation_status='confirmed' AND grant_schedule='service_month' AND hosted_site_limit IS NOT NULL))
);

CREATE TABLE billing_price_versions (
  id text PRIMARY KEY CHECK (id ~ '^bpr_[A-Za-z0-9_-]{24}$'),
  plan_version_id text NOT NULL REFERENCES billing_plan_versions(id),
  interval text NOT NULL CHECK (interval IN ('month','year')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  offer_type text NOT NULL DEFAULT 'standard' CHECK (offer_type IN ('standard','seed')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  tax_policy text NOT NULL DEFAULT 'unconfirmed' CHECK (tax_policy IN ('unconfirmed','exclusive','inclusive')),
  seed_duration_policy text NOT NULL DEFAULT 'unconfirmed' CHECK (seed_duration_policy IN ('unconfirmed','cycles','lifetime')),
  seed_cycles integer CHECK (seed_cycles>0),
  seed_terms text CHECK (length(btrim(seed_terms)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(plan_version_id,interval,offer_type),
  UNIQUE(id,plan_version_id),
  CHECK (offer_type<>'seed' OR interval='month'),
  CHECK ((seed_duration_policy='unconfirmed' AND seed_cycles IS NULL) OR
    (seed_duration_policy='cycles' AND seed_cycles IS NOT NULL AND seed_terms IS NOT NULL) OR
    (seed_duration_policy='lifetime' AND seed_cycles IS NULL AND seed_terms IS NOT NULL)),
  CHECK (offer_type<>'standard' OR (seed_duration_policy='unconfirmed' AND seed_cycles IS NULL AND seed_terms IS NULL)),
  CHECK (status<>'active' OR (tax_policy<>'unconfirmed' AND
    (offer_type='standard' OR (seed_duration_policy<>'unconfirmed' AND seed_terms IS NOT NULL))))
);

CREATE TABLE billing_credit_pack_versions (
  id text PRIMARY KEY CHECK (id ~ '^bcp_[A-Za-z0-9_-]{24}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  credits bigint NOT NULL CHECK (credits BETWEEN 1 AND 9007199254740991),
  tokens_per_credit integer NOT NULL DEFAULT 100 CHECK (tokens_per_credit=100),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  validity_days integer CHECK (validity_days>0),
  validity_policy text NOT NULL DEFAULT 'unconfirmed' CHECK (validity_policy IN ('unconfirmed','days','never_expires')),
  tax_policy text NOT NULL DEFAULT 'unconfirmed' CHECK (tax_policy IN ('unconfirmed','exclusive','inclusive')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((validity_policy='unconfirmed' AND validity_days IS NULL) OR
    (validity_policy='days' AND validity_days IS NOT NULL) OR
    (validity_policy='never_expires' AND validity_days IS NULL)),
  CHECK (status<>'active' OR (validity_policy<>'unconfirmed' AND tax_policy<>'unconfirmed'))
);

-- 版本内容自 INSERT 起冻结；补齐商业条件需新增版本，不能修改原草稿。
CREATE FUNCTION guard_billing_catalog_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE plan public.billing_plan_versions;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '账单目录历史不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
      RAISE EXCEPTION '账单版本内容不可变，请新增版本' USING ERRCODE='23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT
      ((OLD.status='draft' AND NEW.status IN ('active','retired')) OR (OLD.status='active' AND NEW.status='retired')) THEN
      RAISE EXCEPTION '账单版本只可激活或退役，不得复活' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='billing_price_versions' THEN
    SELECT * INTO plan FROM public.billing_plan_versions WHERE id=NEW.plan_version_id;
    IF NOT FOUND THEN RAISE EXCEPTION '报价所属套餐不存在' USING ERRCODE='23503'; END IF;
    IF NEW.offer_type='seed' AND (plan.code<>'unlimited' OR NEW.interval<>'month') THEN
      RAISE EXCEPTION '种子报价只属于 Unlimited 月付' USING ERRCODE='23514';
    END IF;
    IF NEW.status='active' AND (plan.status='retired' OR plan.allocation_status<>'confirmed' OR
      plan.grant_schedule<>'service_month' OR plan.hosted_site_limit IS NULL) THEN
      RAISE EXCEPTION '激活报价前须确认套餐积分、年发规则及网站限额' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='billing_plan_versions' AND NEW.status='active' THEN
    IF NOT EXISTS (SELECT 1 FROM public.billing_price_versions WHERE plan_version_id=NEW.id
      AND offer_type='standard' AND status='active' AND tax_policy<>'unconfirmed') THEN
      RAISE EXCEPTION '激活套餐前须有商业条款完整的标准报价' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER billing_plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_plan_versions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_catalog_version();
CREATE TRIGGER billing_price_version_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_price_versions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_catalog_version();
CREATE TRIGGER billing_credit_pack_version_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_credit_pack_versions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_catalog_version();

CREATE TABLE billing_offer_grants (
  id text PRIMARY KEY CHECK (id ~ '^bog_[A-Za-z0-9_-]{24}$'),
  billing_account_id text NOT NULL REFERENCES billing_accounts(id),
  price_version_id text NOT NULL REFERENCES billing_price_versions(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','ended')),
  valid_from timestamptz,
  valid_end timestamptz,
  approved_by text REFERENCES users(id),
  granted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,billing_account_id,price_version_id),
  CHECK (valid_end IS NULL OR (valid_from IS NOT NULL AND valid_end>valid_from)),
  CHECK (status<>'approved' OR (valid_from IS NOT NULL AND approved_by IS NOT NULL AND granted_at IS NOT NULL)),
  CHECK (status<>'pending' OR (approved_by IS NULL AND granted_at IS NULL))
);
CREATE UNIQUE INDEX billing_offer_grants_one_current ON billing_offer_grants(billing_account_id)
  WHERE status IN ('pending','approved');

CREATE FUNCTION guard_billing_offer_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE price public.billing_price_versions; plan_code text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '报价授予历史不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status='ended' THEN
      RAISE EXCEPTION '报价授予须从初始版本开始' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','approved_by','granted_at','revision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','approved_by','granted_at','revision']) OR NEW.revision<>OLD.revision THEN
      RAISE EXCEPTION '报价授予身份、价格、期限及版本不可覆写' USING ERRCODE='23514';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF NOT ((OLD.status='pending' AND NEW.status IN ('approved','ended')) OR (OLD.status='approved' AND NEW.status='ended')) THEN
      RAISE EXCEPTION '报价授予只可审批或结束，不得复活' USING ERRCODE='23514';
    END IF;
    IF (OLD.status='approved' OR NEW.status='ended') AND
      (NEW.approved_by,NEW.granted_at) IS DISTINCT FROM (OLD.approved_by,OLD.granted_at) THEN
      RAISE EXCEPTION '报价授予审批事实不可覆写' USING ERRCODE='23514';
    END IF;
    NEW.revision:=OLD.revision+1;
  END IF;
  SELECT * INTO price FROM public.billing_price_versions WHERE id=NEW.price_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION '授予报价不存在' USING ERRCODE='23503'; END IF;
  SELECT code INTO plan_code FROM public.billing_plan_versions WHERE id=price.plan_version_id;
  IF price.offer_type<>'seed' OR price.interval<>'month' OR plan_code<>'unlimited' THEN
    RAISE EXCEPTION '授予只适用于 Unlimited 月付种子报价' USING ERRCODE='23514';
  END IF;
  IF NEW.status='approved' AND (price.status<>'active' OR price.seed_duration_policy='unconfirmed' OR
    NEW.valid_from IS NULL OR NEW.approved_by IS NULL OR NEW.granted_at IS NULL OR
    (price.seed_duration_policy='cycles' AND NEW.valid_end IS NULL) OR
    (price.seed_duration_policy='lifetime' AND NEW.valid_end IS NOT NULL)) THEN
    RAISE EXCEPTION '审批须有有效报价、明确期限及审批事实' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER billing_offer_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_offer_grants
  FOR EACH ROW EXECUTE FUNCTION guard_billing_offer_grant();

CREATE TABLE billing_subscriptions (
  id text PRIMARY KEY CHECK (id ~ '^bsu_[A-Za-z0-9_-]{24}$'),
  billing_account_id text NOT NULL REFERENCES billing_accounts(id),
  plan_version_id text NOT NULL REFERENCES billing_plan_versions(id),
  price_version_id text NOT NULL,
  offer_grant_id text,
  provider text NOT NULL DEFAULT 'paypal' CHECK (provider='paypal'),
  provider_subscription_id text UNIQUE CHECK (provider_subscription_id ~ '^I-[A-Za-z0-9]+$'),
  status text NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete','active','past_due','suspended','cancelled','expired')),
  period_start timestamptz,
  period_end timestamptz,
  paid_through timestamptz,
  cancel_requested_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(price_version_id,plan_version_id) REFERENCES billing_price_versions(id,plan_version_id),
  FOREIGN KEY(offer_grant_id,billing_account_id,price_version_id) REFERENCES billing_offer_grants(id,billing_account_id,price_version_id),
  CHECK ((period_start IS NULL AND period_end IS NULL) OR
    (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end>period_start))
);
CREATE UNIQUE INDEX billing_subscriptions_one_current ON billing_subscriptions(billing_account_id)
  WHERE status IN ('incomplete','active','past_due','suspended');

CREATE FUNCTION guard_billing_subscription() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE offer_type text; grant_row public.billing_offer_grants;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '订阅历史不可删除' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.paid_through IS NOT NULL THEN
      RAISE EXCEPTION '无支付事实不得初始化已付期限或非初始版本' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','period_start','period_end','cancel_requested_at','revision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','period_start','period_end','cancel_requested_at','revision']) OR NEW.revision<>OLD.revision THEN
      RAISE EXCEPTION '订阅身份、所选价格及支付期限不可覆写' USING ERRCODE='23514';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF OLD.status IN ('cancelled','expired') THEN
      RAISE EXCEPTION '已结束订阅不可覆写或复活' USING ERRCODE='23514';
    END IF;
    NEW.revision:=OLD.revision+1;
    RETURN NEW;
  END IF;
  SELECT p.offer_type INTO offer_type FROM public.billing_price_versions p WHERE p.id=NEW.price_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION '订阅报价不存在' USING ERRCODE='23503'; END IF;
  IF offer_type='standard' AND NEW.offer_grant_id IS NOT NULL THEN
    RAISE EXCEPTION '标准报价不得绑定种子授予' USING ERRCODE='23514';
  ELSIF offer_type='seed' THEN
    IF NEW.offer_grant_id IS NULL THEN RAISE EXCEPTION '种子订阅须有同账户同报价授予' USING ERRCODE='23514'; END IF;
    SELECT * INTO grant_row FROM public.billing_offer_grants WHERE id=NEW.offer_grant_id;
    IF NOT FOUND THEN RAISE EXCEPTION '订阅授予不存在' USING ERRCODE='23503'; END IF;
    IF grant_row.status<>'approved' OR grant_row.valid_from IS NULL OR grant_row.valid_from>clock_timestamp() OR
      (grant_row.valid_end IS NOT NULL AND grant_row.valid_end<=clock_timestamp()) THEN
      RAISE EXCEPTION '种子订阅须有已审批且未过期授予' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER billing_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION guard_billing_subscription();

-- 固定 24 位 base64url 安全后缀；不种积分包、种子授予、订阅或额度赠送。
INSERT INTO billing_plan_versions(id,code,version,name,ai_mode,monthly_credits) VALUES
  ('bpv_000000000000000000000001','maintain',1,'Maintain','limited',1000),
  ('bpv_000000000000000000000002','build',1,'Build','limited',10000),
  ('bpv_000000000000000000000003','unlimited',1,'Unlimited','unlimited',NULL);
INSERT INTO billing_price_versions(id,plan_version_id,interval,amount_minor,offer_type) VALUES
  ('bpr_000000000000000000000001','bpv_000000000000000000000001','month',5900,'standard'),
  ('bpr_000000000000000000000002','bpv_000000000000000000000001','year',41300,'standard'),
  ('bpr_000000000000000000000003','bpv_000000000000000000000002','month',9900,'standard'),
  ('bpr_000000000000000000000004','bpv_000000000000000000000002','year',69300,'standard'),
  ('bpr_000000000000000000000005','bpv_000000000000000000000003','month',19900,'standard'),
  ('bpr_000000000000000000000006','bpv_000000000000000000000003','year',139300,'standard'),
  ('bpr_000000000000000000000007','bpv_000000000000000000000003','month',3990,'seed');

REVOKE ALL ON billing_plan_versions,billing_price_versions,billing_credit_pack_versions,billing_offer_grants,billing_subscriptions FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_billing_catalog_version(),guard_billing_offer_grant(),guard_billing_subscription() FROM PUBLIC;
DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['restaurant_app','restaurant_test_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON billing_plan_versions,billing_price_versions,billing_credit_pack_versions,billing_offer_grants,billing_subscriptions FROM %I',role_name);
      EXECUTE format('GRANT SELECT ON billing_plan_versions,billing_price_versions,billing_credit_pack_versions,billing_offer_grants,billing_subscriptions TO %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION guard_billing_catalog_version(),guard_billing_offer_grant(),guard_billing_subscription() FROM %I',role_name);
    END IF;
  END LOOP;
END $grant$;
