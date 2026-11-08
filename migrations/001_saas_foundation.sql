CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS seller;
ALTER DEFAULT PRIVILEGES IN SCHEMA seller REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS seller.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seller.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES seller.users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  active_tenant_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON seller.sessions(user_id, expires_at);
CREATE TABLE IF NOT EXISTS seller.login_attempts (
  ip_hash bytea NOT NULL,
  identifier_hash bytea NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ip_hash, identifier_hash)
);

CREATE TABLE IF NOT EXISTS seller.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE seller.sessions DROP CONSTRAINT IF EXISTS sessions_active_tenant_id_fkey;
ALTER TABLE seller.sessions ADD CONSTRAINT sessions_active_tenant_id_fkey
  FOREIGN KEY (active_tenant_id) REFERENCES seller.tenants(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS seller.memberships (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES seller.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','analyst','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS seller.products (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.variants (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  sku text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES seller.products(tenant_id, id),
  UNIQUE (tenant_id, sku)
);
CREATE TABLE IF NOT EXISTS seller.cost_versions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  source text NOT NULL CHECK (source IN ('manual','import','integration')),
  created_by uuid NOT NULL REFERENCES seller.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  UNIQUE (tenant_id, variant_id, effective_at)
);
CREATE TABLE IF NOT EXISTS seller.integrations (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('commerce','ads','payments','other')),
  external_account_id text,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, provider, external_account_id)
);
CREATE TABLE IF NOT EXISTS seller.oauth_credentials (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  key_version text NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  ciphertext bytea NOT NULL,
  aad_version smallint NOT NULL DEFAULT 2 CHECK (aad_version IN (1,2)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, integration_id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS seller.orders (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid,
  external_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('paid','pending','cancelled','refunded')),
  placed_at timestamptz NOT NULL,
  currency char(3) NOT NULL DEFAULT 'BRL',
  source_updated_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, integration_id, external_id)
);
CREATE TABLE IF NOT EXISTS seller.order_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  variant_id uuid,
  external_line_id text NOT NULL,
  sku_snapshot text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0 AND discount_cents <= quantity * unit_price_cents),
  cost_version_id uuid,
  unit_cost_snapshot_cents bigint CHECK (unit_cost_snapshot_cents >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES seller.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_version_id) REFERENCES seller.cost_versions(tenant_id, id),
  UNIQUE (tenant_id, order_id, external_line_id)
);
CREATE TABLE IF NOT EXISTS seller.order_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  source_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'order_discount','shipping','refund','payment_fee','tax','packaging','cashback','other'
  )),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  direction smallint NOT NULL CHECK (direction IN (-1,1)),
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES seller.orders(tenant_id, id),
  UNIQUE (tenant_id, order_id, source_key)
);
CREATE TABLE IF NOT EXISTS seller.expenses (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('ads','operating')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  competence_date date NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.webhook_inbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id),
  UNIQUE (tenant_id, integration_id, provider_event_id)
);
CREATE TABLE IF NOT EXISTS seller.sync_cursors (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  resource text NOT NULL,
  cursor jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, integration_id, resource),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.sync_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  resource text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','partial')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}',
  error text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id)
);
ALTER TABLE seller.sync_runs ADD CONSTRAINT sync_runs_finished_status_check CHECK (
  (status='running' AND finished_at IS NULL) OR
  (status IN ('succeeded','failed','partial') AND finished_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS seller.sync_jobs (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  deduplication_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','retry','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, deduplication_key)
);
CREATE TABLE IF NOT EXISTS seller.dead_letters (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.ad_accounts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'BRL',
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id),
  UNIQUE (tenant_id, integration_id, external_id)
);
CREATE TABLE IF NOT EXISTS seller.ad_campaigns (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ad_account_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  status text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ad_account_id) REFERENCES seller.ad_accounts(tenant_id, id),
  UNIQUE (tenant_id, ad_account_id, external_id)
);
CREATE TABLE IF NOT EXISTS seller.ad_daily_metrics (
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  metric_date date NOT NULL,
  spend_cents bigint NOT NULL CHECK (spend_cents >= 0),
  impressions bigint CHECK (impressions >= 0),
  clicks bigint CHECK (clicks >= 0),
  declared_revenue_cents bigint CHECK (declared_revenue_cents >= 0),
  payload jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, campaign_id, metric_date),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES seller.ad_campaigns(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.data_quality_issues (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  resource_type text NOT NULL,
  resource_id text,
  details jsonb NOT NULL DEFAULT '{}',
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.recommendations (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  title text NOT NULL,
  rationale jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','expired')),
  calculation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.calculation_versions (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  version text NOT NULL,
  definitions jsonb NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, version)
);
CREATE TABLE IF NOT EXISTS seller.audit_log (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  id bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id uuid REFERENCES seller.users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS seller.worker_heartbeats (
  worker_name text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE FUNCTION seller.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION seller.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION seller.list_user_tenants()
RETURNS TABLE(id uuid, name text, slug text, role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = seller, pg_temp
SET row_security = off
AS $$
  SELECT t.id, t.name, t.slug, m.role
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = seller.current_user_id()
  ORDER BY t.name
$$;
REVOKE ALL ON FUNCTION seller.list_user_tenants() FROM PUBLIC;
CREATE OR REPLACE FUNCTION seller.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% é append-only', TG_TABLE_NAME; END $$;

DROP TRIGGER IF EXISTS audit_append_only ON seller.audit_log;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON seller.audit_log
FOR EACH ROW EXECUTE FUNCTION seller.reject_mutation();
DROP TRIGGER IF EXISTS costs_append_only ON seller.cost_versions;
CREATE TRIGGER costs_append_only BEFORE UPDATE OR DELETE ON seller.cost_versions
FOR EACH ROW EXECUTE FUNCTION seller.reject_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','products','variants','cost_versions','integrations','oauth_credentials',
    'orders','order_lines','order_events','expenses','webhook_inbox','sync_cursors',
    'sync_runs','sync_jobs','dead_letters','ad_accounts','ad_campaigns','ad_daily_metrics',
    'data_quality_issues','recommendations','calculation_versions','audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE seller.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE seller.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON seller.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON seller.%I USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant())', t
    );
  END LOOP;
END $$;
ALTER TABLE seller.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.tenants;
CREATE POLICY tenant_scope ON seller.tenants
  USING (id = seller.current_tenant()) WITH CHECK (id = seller.current_tenant());

CREATE INDEX IF NOT EXISTS orders_period_idx ON seller.orders(tenant_id, placed_at);
CREATE INDEX IF NOT EXISTS sessions_active_tenant_idx ON seller.sessions(active_tenant_id) WHERE active_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memberships_user_idx ON seller.memberships(user_id);
CREATE INDEX IF NOT EXISTS variants_product_idx ON seller.variants(tenant_id,product_id);
CREATE INDEX IF NOT EXISTS cost_versions_variant_idx ON seller.cost_versions(tenant_id,variant_id,effective_at DESC);
CREATE INDEX IF NOT EXISTS orders_integration_idx ON seller.orders(tenant_id,integration_id) WHERE integration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON seller.order_lines(tenant_id,order_id);
CREATE INDEX IF NOT EXISTS order_lines_variant_idx ON seller.order_lines(tenant_id,variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_events_order_idx ON seller.order_events(tenant_id,order_id);
CREATE INDEX IF NOT EXISTS webhook_inbox_integration_idx ON seller.webhook_inbox(tenant_id,integration_id);
CREATE INDEX IF NOT EXISTS sync_runs_integration_fk_idx ON seller.sync_runs(tenant_id,integration_id);
CREATE INDEX IF NOT EXISTS ad_accounts_integration_fk_idx ON seller.ad_accounts(tenant_id,integration_id);
CREATE INDEX IF NOT EXISTS ad_campaigns_account_idx ON seller.ad_campaigns(tenant_id,ad_account_id);
CREATE INDEX IF NOT EXISTS sync_jobs_due_idx ON seller.sync_jobs(tenant_id, run_after) WHERE status IN ('queued','retry');
CREATE INDEX IF NOT EXISTS quality_open_idx ON seller.data_quality_issues(tenant_id, detected_at) WHERE resolved_at IS NULL;
