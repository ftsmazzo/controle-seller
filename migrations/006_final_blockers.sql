ALTER TABLE seller.order_lines
  ADD COLUMN IF NOT EXISTS returned_quantity integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS restocked_quantity integer DEFAULT 0;

ALTER TABLE seller.order_lines
  ADD CONSTRAINT order_lines_returned_quantity_check
    CHECK (returned_quantity IS NULL OR returned_quantity BETWEEN 0 AND quantity) NOT VALID,
  ADD CONSTRAINT order_lines_restocked_quantity_check
    CHECK (
      restocked_quantity IS NULL
      OR (returned_quantity IS NOT NULL AND restocked_quantity BETWEEN 0 AND returned_quantity)
    ) NOT VALID;

UPDATE seller.order_lines ol
SET returned_quantity=NULL,restocked_quantity=NULL
WHERE EXISTS (
    SELECT 1 FROM seller.order_events oe
    WHERE oe.tenant_id=ol.tenant_id AND oe.order_id=ol.order_id AND oe.kind='refund'
  );

INSERT INTO seller.data_quality_issues
  (tenant_id,code,severity,resource_type,resource_id,details)
SELECT DISTINCT ol.tenant_id,'return_allocation_unknown','error','order',ol.order_id::text,
  '{"reason":"Migração não pode inferir alocação/reposição histórica.","financialImpact":"contribution_unknown"}'::jsonb
FROM seller.order_lines ol
WHERE ol.restocked_quantity IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM seller.data_quality_issues d
    WHERE d.tenant_id=ol.tenant_id AND d.code='return_allocation_unknown'
      AND d.resource_type='order' AND d.resource_id=ol.order_id::text AND d.resolved_at IS NULL
  );

CREATE TABLE seller.cost_recalculation_outbox (
  tenant_id uuid NOT NULL,
  cost_version_id uuid NOT NULL,
  payload jsonb NOT NULL,
  enqueued_at timestamptz,
  queue_job_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,cost_version_id),
  FOREIGN KEY (tenant_id,cost_version_id)
    REFERENCES seller.cost_channel_versions(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE seller.cost_recalculation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.cost_recalculation_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON seller.cost_recalculation_outbox
  USING (tenant_id=seller.current_tenant()) WITH CHECK (tenant_id=seller.current_tenant());
CREATE INDEX cost_recalculation_outbox_pending_idx
  ON seller.cost_recalculation_outbox(created_at) WHERE enqueued_at IS NULL;

CREATE FUNCTION seller.pending_cost_recalculations(p_limit integer DEFAULT 100)
RETURNS TABLE(tenant_id uuid,cost_version_id uuid,payload jsonb)
LANGUAGE sql SECURITY DEFINER
SET search_path=seller,pg_temp
SET row_security=off
AS $$
  SELECT o.tenant_id,o.cost_version_id,o.payload
  FROM cost_recalculation_outbox o
  WHERE o.enqueued_at IS NULL
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(p_limit,1),500)
$$;
REVOKE ALL ON FUNCTION seller.pending_cost_recalculations(integer) FROM PUBLIC;

CREATE FUNCTION seller.mark_cost_recalculation_enqueued(
  p_tenant_id uuid,p_cost_version_id uuid,p_job_id uuid
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path=seller,pg_temp
SET row_security=off
AS $$
  UPDATE cost_recalculation_outbox
  SET enqueued_at=now(),queue_job_id=p_job_id,attempts=attempts+1,last_error=NULL
  WHERE tenant_id=p_tenant_id AND cost_version_id=p_cost_version_id AND enqueued_at IS NULL
  RETURNING true
$$;
REVOKE ALL ON FUNCTION seller.mark_cost_recalculation_enqueued(uuid,uuid,uuid) FROM PUBLIC;

CREATE INDEX IF NOT EXISTS oauth_states_tenant_user_idx
  ON seller.oauth_states(tenant_id,user_id);
CREATE INDEX IF NOT EXISTS oauth_states_user_fk_idx
  ON seller.oauth_states(user_id);
CREATE INDEX IF NOT EXISTS oauth_states_tenant_expiry_idx
  ON seller.oauth_states(tenant_id,expires_at);

DROP FUNCTION IF EXISTS seller.mark_nuvemshop_webhook_enqueued(uuid);
CREATE FUNCTION seller.mark_nuvemshop_webhook_enqueued(p_tenant_id uuid,p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path=seller,pg_temp
SET row_security=off
AS $$
  UPDATE webhook_inbox
  SET enqueued_at=now()
  WHERE tenant_id=p_tenant_id AND id=p_inbox_id AND enqueued_at IS NULL
  RETURNING true
$$;
REVOKE ALL ON FUNCTION seller.mark_nuvemshop_webhook_enqueued(uuid,uuid) FROM PUBLIC;
