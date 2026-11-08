ALTER TABLE seller.oauth_states
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'nuvemshop',
  ADD COLUMN IF NOT EXISTS redirect_uri text;
ALTER TABLE seller.oauth_states
  ADD CONSTRAINT oauth_states_provider_check CHECK (provider IN ('nuvemshop','meta'));

ALTER TABLE seller.ad_accounts
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS account_status integer,
  ADD COLUMN IF NOT EXISTS selected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_payload jsonb NOT NULL DEFAULT '{}';

ALTER TABLE seller.ad_campaigns
  ADD COLUMN IF NOT EXISTS effective_status text,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS quality jsonb NOT NULL DEFAULT '{}';

CREATE TABLE seller.meta_account_candidates (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  currency char(3) NOT NULL,
  timezone text NOT NULL,
  account_status integer NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,integration_id,external_id),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES seller.integrations(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE seller.ad_sets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ad_account_id uuid NOT NULL,
  campaign_id uuid,
  external_id text NOT NULL,
  name text NOT NULL,
  status text,
  effective_status text,
  source_updated_at timestamptz,
  archived_at timestamptz,
  source_payload jsonb NOT NULL,
  provenance jsonb NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,ad_account_id) REFERENCES seller.ad_accounts(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES seller.ad_campaigns(tenant_id,id),
  UNIQUE (tenant_id,ad_account_id,external_id)
);

CREATE TABLE seller.ads (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ad_account_id uuid NOT NULL,
  campaign_id uuid,
  adset_id uuid,
  external_id text NOT NULL,
  name text NOT NULL,
  status text,
  effective_status text,
  source_updated_at timestamptz,
  archived_at timestamptz,
  source_payload jsonb NOT NULL,
  provenance jsonb NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,ad_account_id) REFERENCES seller.ad_accounts(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,campaign_id) REFERENCES seller.ad_campaigns(tenant_id,id),
  FOREIGN KEY (tenant_id,adset_id) REFERENCES seller.ad_sets(tenant_id,id),
  UNIQUE (tenant_id,ad_account_id,external_id)
);

CREATE TABLE seller.ad_insight_facts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ad_account_id uuid NOT NULL,
  object_level text NOT NULL CHECK (object_level IN ('campaign','adset','ad')),
  object_id uuid NOT NULL,
  metric_date date NOT NULL,
  breakdowns jsonb NOT NULL DEFAULT '{}',
  breakdown_hash text NOT NULL,
  configuration jsonb NOT NULL,
  configuration_hash text NOT NULL,
  currency char(3) NOT NULL,
  timezone text NOT NULL,
  spend_cents bigint NOT NULL CHECK (spend_cents >= 0),
  impressions bigint CHECK (impressions >= 0),
  clicks bigint CHECK (clicks >= 0),
  reach bigint CHECK (reach >= 0),
  source_payload jsonb NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,ad_account_id) REFERENCES seller.ad_accounts(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,ad_account_id,object_level,object_id,metric_date,breakdown_hash,configuration_hash)
);

CREATE TABLE seller.platform_conversions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  insight_fact_id uuid NOT NULL,
  action_type text NOT NULL,
  conversion_count numeric(24,6) CHECK (conversion_count >= 0),
  declared_value_cents bigint CHECK (declared_value_cents >= 0),
  currency char(3) NOT NULL,
  source_payload jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,insight_fact_id) REFERENCES seller.ad_insight_facts(tenant_id,id) ON DELETE CASCADE,
  UNIQUE (tenant_id,insight_fact_id,action_type)
);

CREATE TABLE seller.attribution_models (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version text NOT NULL,
  model text NOT NULL CHECK (model IN ('last_evidence','first_evidence','linear_evidence')),
  window_days integer NOT NULL CHECK (window_days BETWEEN 1 AND 90),
  evidence_rules jsonb NOT NULL,
  active_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,version)
);

CREATE TABLE seller.marketing_touchpoints (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ad_account_id uuid,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,
  medium text,
  campaign_external_id text,
  adset_external_id text,
  ad_external_id text,
  click_identifier text,
  utm jsonb NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  provenance jsonb NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,ad_account_id) REFERENCES seller.ad_accounts(tenant_id,id),
  UNIQUE (tenant_id,evidence_hash)
);

CREATE TABLE seller.attribution_links (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  touchpoint_id uuid NOT NULL,
  attribution_model_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('utm','click_identifier','external_identifier')),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  weight numeric(8,7) NOT NULL CHECK (weight > 0 AND weight <= 1),
  attributed_net_revenue_cents bigint NOT NULL CHECK (attributed_net_revenue_cents >= 0),
  attributed_margin_cents bigint,
  linked_at timestamptz NOT NULL DEFAULT now(),
  provenance jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES seller.orders(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,touchpoint_id) REFERENCES seller.marketing_touchpoints(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,attribution_model_id) REFERENCES seller.attribution_models(tenant_id,id),
  UNIQUE (tenant_id,order_id,touchpoint_id,attribution_model_id)
);

INSERT INTO seller.calculation_versions(tenant_id,version,definitions)
SELECT id,'meta-metrics-v1',
  '{"declared_roas":"meta_declared_purchase_value/campaign_spend","attributed_net_revenue":"real_paid_orders_with_evidence","attributed_margin_after_media":"attributed_margin-campaign_spend","causal":false}'::jsonb
FROM seller.tenants
ON CONFLICT (tenant_id,version) DO NOTHING;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'meta_account_candidates','ad_sets','ads','ad_insight_facts','platform_conversions',
    'attribution_models','marketing_touchpoints','attribution_links'
  ] LOOP
    EXECUTE format('ALTER TABLE seller.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE seller.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON seller.%I USING (tenant_id=seller.current_tenant()) WITH CHECK (tenant_id=seller.current_tenant())',t
    );
  END LOOP;
END $$;

CREATE INDEX meta_candidates_integration_idx
  ON seller.meta_account_candidates(tenant_id,integration_id);
CREATE INDEX ad_accounts_selected_idx
  ON seller.ad_accounts(tenant_id,integration_id) WHERE selected AND archived_at IS NULL;
CREATE INDEX ad_insight_period_idx
  ON seller.ad_insight_facts(tenant_id,metric_date,object_level);
CREATE INDEX attribution_order_idx
  ON seller.attribution_links(tenant_id,order_id);
CREATE INDEX ad_sets_account_idx ON seller.ad_sets(tenant_id,ad_account_id);
CREATE INDEX ad_sets_campaign_idx ON seller.ad_sets(tenant_id,campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX ads_account_idx ON seller.ads(tenant_id,ad_account_id);
CREATE INDEX ads_campaign_idx ON seller.ads(tenant_id,campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX ads_adset_idx ON seller.ads(tenant_id,adset_id) WHERE adset_id IS NOT NULL;
CREATE INDEX insight_account_idx ON seller.ad_insight_facts(tenant_id,ad_account_id);
CREATE INDEX conversions_fact_idx ON seller.platform_conversions(tenant_id,insight_fact_id);
CREATE INDEX touchpoints_account_idx ON seller.marketing_touchpoints(tenant_id,ad_account_id) WHERE ad_account_id IS NOT NULL;
CREATE INDEX attribution_touchpoint_idx ON seller.attribution_links(tenant_id,touchpoint_id);
CREATE INDEX attribution_model_idx ON seller.attribution_links(tenant_id,attribution_model_id);
CREATE INDEX touchpoints_click_idx
  ON seller.marketing_touchpoints(tenant_id,click_identifier) WHERE click_identifier IS NOT NULL;

CREATE OR REPLACE FUNCTION seller.meta_daily_sync_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(tenant_id uuid,integration_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path=seller,pg_temp
SET row_security=off
AS $$
  SELECT i.tenant_id,i.id
  FROM integrations i
  WHERE i.provider='meta' AND i.status='active' AND i.disconnected_at IS NULL
    AND (i.last_sync_at IS NULL OR i.last_sync_at < current_date)
  ORDER BY i.last_sync_at NULLS FIRST
  LIMIT LEAST(GREATEST(p_limit,1),500)
$$;
REVOKE ALL ON FUNCTION seller.meta_daily_sync_candidates(integer) FROM PUBLIC;
