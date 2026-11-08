ALTER TABLE seller.recommendations
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info','warning','critical')),
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS rule_code text,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coverage numeric(6,5) CHECK (coverage BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS confidence numeric(6,5) CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS suggested_action text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS acted_at timestamptz,
  ADD COLUMN IF NOT EXISTS acted_by uuid REFERENCES seller.users(id);
CREATE UNIQUE INDEX IF NOT EXISTS recommendations_fingerprint_uidx
  ON seller.recommendations(tenant_id,fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS recommendations_open_idx
  ON seller.recommendations(tenant_id,severity,updated_at DESC) WHERE status='open';

CREATE TABLE IF NOT EXISTS seller.cost_channel_versions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  integration_id uuid,
  effective_at timestamptz NOT NULL,
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  source text NOT NULL CHECK (source IN ('manual','import','integration')),
  note text,
  created_by uuid NOT NULL REFERENCES seller.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,variant_id) REFERENCES seller.variants(tenant_id,id),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES seller.integrations(tenant_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,variant_id,integration_id,effective_at)
);
CREATE INDEX IF NOT EXISTS cost_channel_lookup_idx
  ON seller.cost_channel_versions(tenant_id,variant_id,integration_id,effective_at DESC);
CREATE INDEX IF NOT EXISTS cost_channel_integration_idx
  ON seller.cost_channel_versions(tenant_id,integration_id) WHERE integration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recommendations_acted_by_idx
  ON seller.recommendations(acted_by) WHERE acted_by IS NOT NULL;
ALTER TABLE seller.cost_channel_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.cost_channel_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON seller.cost_channel_versions
  USING (tenant_id=seller.current_tenant()) WITH CHECK (tenant_id=seller.current_tenant());
CREATE TRIGGER cost_channel_versions_append_only
  BEFORE UPDATE OR DELETE ON seller.cost_channel_versions
  FOR EACH ROW EXECUTE FUNCTION seller.reject_mutation();
