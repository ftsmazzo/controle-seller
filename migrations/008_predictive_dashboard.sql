-- Dashboard preditiva: séries diárias, runs de forecast e avaliações (ensemble learning).

INSERT INTO seller.calculation_versions(tenant_id, version, definitions)
SELECT id, 'predictive-ensemble-v1',
  '{"method":"stacking","base_learners":["seasonal_ma","ridge_sales","ridge_ads"],"metrics":["mae","mape","rmse"],"horizons":[30,60,90],"causal":false}'::jsonb
FROM seller.tenants
ON CONFLICT (tenant_id, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS seller.daily_store_metrics (
  tenant_id uuid NOT NULL,
  metric_date date NOT NULL,
  revenue_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
  orders_count integer NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  avg_ticket_cents bigint NOT NULL DEFAULT 0 CHECK (avg_ticket_cents >= 0),
  revenue_nuvemshop_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_nuvemshop_cents >= 0),
  revenue_mercadolivre_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_mercadolivre_cents >= 0),
  revenue_shopee_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_shopee_cents >= 0),
  revenue_shopify_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_shopify_cents >= 0),
  revenue_other_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_other_cents >= 0),
  ads_spend_cents bigint NOT NULL DEFAULT 0 CHECK (ads_spend_cents >= 0),
  ads_impressions bigint NOT NULL DEFAULT 0 CHECK (ads_impressions >= 0),
  ads_clicks bigint NOT NULL DEFAULT 0 CHECK (ads_clicks >= 0),
  ads_declared_purchase_cents bigint NOT NULL DEFAULT 0 CHECK (ads_declared_purchase_cents >= 0),
  source_coverage numeric(6,5) CHECK (source_coverage IS NULL OR source_coverage BETWEEN 0 AND 1),
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric_date),
  FOREIGN KEY (tenant_id) REFERENCES seller.tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS daily_store_metrics_date_idx
  ON seller.daily_store_metrics(tenant_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS seller.forecast_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  as_of_date date NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days IN (30, 60, 90)),
  scenario text NOT NULL DEFAULT 'baseline'
    CHECK (scenario IN ('baseline','ads_up','ads_down','custom')),
  ads_spend_assumed_cents bigint CHECK (ads_spend_assumed_cents IS NULL OR ads_spend_assumed_cents >= 0),
  model_version text NOT NULL,
  calculation_version text NOT NULL DEFAULT 'predictive-ensemble-v1',
  mae numeric(18,4),
  mape numeric(12,6),
  rmse numeric(18,4),
  train_days integer NOT NULL DEFAULT 0,
  drivers jsonb NOT NULL DEFAULT '[]',
  metrics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES seller.tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS forecast_runs_latest_idx
  ON seller.forecast_runs(tenant_id, as_of_date DESC, horizon_days, scenario);

CREATE TABLE IF NOT EXISTS seller.forecast_points (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  target_date date NOT NULL,
  yhat_cents bigint NOT NULL CHECK (yhat_cents >= 0),
  yhat_p10_cents bigint NOT NULL CHECK (yhat_p10_cents >= 0),
  yhat_p50_cents bigint NOT NULL CHECK (yhat_p50_cents >= 0),
  yhat_p90_cents bigint NOT NULL CHECK (yhat_p90_cents >= 0),
  yhat_nuvemshop_cents bigint,
  yhat_mercadolivre_cents bigint,
  yhat_shopee_cents bigint,
  yhat_shopify_cents bigint,
  yhat_other_cents bigint,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES seller.forecast_runs(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, run_id, target_date)
);
CREATE INDEX IF NOT EXISTS forecast_points_run_idx
  ON seller.forecast_points(tenant_id, run_id, target_date);

CREATE TABLE IF NOT EXISTS seller.forecast_evals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  model_version text NOT NULL,
  eval_date date NOT NULL,
  window_days integer NOT NULL CHECK (window_days > 0),
  mae numeric(18,4) NOT NULL,
  mape numeric(12,6) NOT NULL,
  rmse numeric(18,4) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES seller.tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS seller.forecast_job_outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  processed_at timestamptz,
  horizon_days integer NOT NULL DEFAULT 30 CHECK (horizon_days IN (30, 60, 90)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES seller.tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS forecast_job_pending_idx
  ON seller.forecast_job_outbox(requested_at)
  WHERE enqueued_at IS NULL;

ALTER TABLE seller.daily_store_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.daily_store_metrics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.daily_store_metrics;
CREATE POLICY tenant_scope ON seller.daily_store_metrics
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

ALTER TABLE seller.forecast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.forecast_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.forecast_runs;
CREATE POLICY tenant_scope ON seller.forecast_runs
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

ALTER TABLE seller.forecast_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.forecast_points FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.forecast_points;
CREATE POLICY tenant_scope ON seller.forecast_points
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

ALTER TABLE seller.forecast_evals ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.forecast_evals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.forecast_evals;
CREATE POLICY tenant_scope ON seller.forecast_evals
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

ALTER TABLE seller.forecast_job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.forecast_job_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON seller.forecast_job_outbox;
CREATE POLICY tenant_scope ON seller.forecast_job_outbox
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

CREATE OR REPLACE FUNCTION seller.pending_forecast_jobs(limit_count integer DEFAULT 50)
RETURNS TABLE(tenant_id uuid, outbox_id uuid, horizon_days integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = seller, pg_temp
AS $$
  SELECT o.tenant_id, o.id, o.horizon_days
  FROM seller.forecast_job_outbox o
  WHERE o.enqueued_at IS NULL
  ORDER BY o.requested_at
  LIMIT greatest(limit_count, 1);
$$;
REVOKE ALL ON FUNCTION seller.pending_forecast_jobs(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION seller.mark_forecast_job_enqueued(p_tenant uuid, p_outbox uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = seller, pg_temp
AS $$
  UPDATE seller.forecast_job_outbox
  SET enqueued_at = now()
  WHERE tenant_id = p_tenant AND id = p_outbox AND enqueued_at IS NULL;
$$;
REVOKE ALL ON FUNCTION seller.mark_forecast_job_enqueued(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION seller.forecast_weekly_candidates(limit_count integer DEFAULT 100)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = seller, pg_temp
AS $$
  SELECT t.id
  FROM seller.tenants t
  WHERE EXISTS (
    SELECT 1 FROM seller.orders o
    WHERE o.tenant_id = t.id AND o.status = 'paid'
  )
  AND NOT EXISTS (
    SELECT 1 FROM seller.forecast_runs r
    WHERE r.tenant_id = t.id
      AND r.scenario = 'baseline'
      AND r.created_at > now() - interval '6 days'
  )
  ORDER BY t.created_at
  LIMIT greatest(limit_count, 1);
$$;
REVOKE ALL ON FUNCTION seller.forecast_weekly_candidates(integer) FROM PUBLIC;
