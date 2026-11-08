ALTER TABLE seller.integrations
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

ALTER TABLE seller.products
  ADD COLUMN IF NOT EXISTS integration_id uuid,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_payload jsonb,
  ADD COLUMN IF NOT EXISTS source_hash text;
ALTER TABLE seller.products
  ADD CONSTRAINT products_integration_fk FOREIGN KEY (tenant_id, integration_id)
  REFERENCES seller.integrations(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS products_external_uidx
  ON seller.products(tenant_id, integration_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_integration_idx
  ON seller.products(tenant_id,integration_id) WHERE integration_id IS NOT NULL;

ALTER TABLE seller.variants
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS price_cents bigint CHECK (price_cents >= 0),
  ADD COLUMN IF NOT EXISTS stock bigint,
  ADD COLUMN IF NOT EXISTS source_payload jsonb,
  ADD COLUMN IF NOT EXISTS source_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS variants_external_uidx
  ON seller.variants(tenant_id, product_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE seller.orders
  ADD COLUMN IF NOT EXISTS source_payload jsonb,
  ADD COLUMN IF NOT EXISTS source_hash text;

ALTER TABLE seller.webhook_inbox
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS raw_body bytea,
  ADD COLUMN IF NOT EXISTS enqueued_at timestamptz;

CREATE TABLE seller.oauth_states (
  state_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES seller.users(id) ON DELETE CASCADE,
  redirect_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_states_expiry_idx ON seller.oauth_states(expires_at);

CREATE TABLE seller.integration_webhooks (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  topic text NOT NULL,
  external_id text,
  token_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','error','deleted')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, integration_id, topic),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES seller.integrations(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX integration_webhooks_token_uidx ON seller.integration_webhooks(token_hash);

ALTER TABLE seller.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON seller.oauth_states
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());
ALTER TABLE seller.integration_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.integration_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON seller.integration_webhooks
  USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant());

CREATE OR REPLACE FUNCTION seller.ingest_nuvemshop_webhook(
  p_token_hash bytea, p_event_id text, p_headers jsonb, p_payload jsonb, p_raw_body bytea
) RETURNS TABLE(tenant_id uuid, integration_id uuid, inbox_id uuid, inserted boolean, enqueued_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = seller, pg_temp
SET row_security = off
AS $$
DECLARE v_tenant uuid; v_integration uuid; v_topic text; v_inbox uuid; v_inserted boolean := false; v_enqueued timestamptz;
BEGIN
  SELECT i.tenant_id, i.id, w.topic INTO v_tenant, v_integration, v_topic
  FROM integration_webhooks w JOIN integrations i
    ON i.tenant_id=w.tenant_id AND i.id=w.integration_id
  WHERE w.token_hash=p_token_hash AND w.status='active' AND i.provider='nuvemshop'
    AND i.status IN ('active','error') AND i.disconnected_at IS NULL
  LIMIT 1;
  IF v_integration IS NULL THEN RETURN; END IF;
  INSERT INTO webhook_inbox(tenant_id,integration_id,provider_event_id,topic,headers,payload,raw_body,enqueued_at)
  VALUES(v_tenant,v_integration,p_event_id,v_topic,p_headers,p_payload,p_raw_body,NULL)
  ON CONFLICT (tenant_id,integration_id,provider_event_id) DO NOTHING
  RETURNING id INTO v_inbox;
  IF v_inbox IS NOT NULL THEN v_inserted := true;
  ELSE
    SELECT w.id,w.enqueued_at INTO v_inbox,v_enqueued FROM webhook_inbox w
    WHERE w.tenant_id=v_tenant AND w.integration_id=v_integration AND w.provider_event_id=p_event_id;
  END IF;
  RETURN QUERY SELECT v_tenant,v_integration,v_inbox,v_inserted,v_enqueued;
END $$;
REVOKE ALL ON FUNCTION seller.ingest_nuvemshop_webhook(bytea,text,jsonb,jsonb,bytea) FROM PUBLIC;

CREATE OR REPLACE FUNCTION seller.mark_nuvemshop_webhook_enqueued(p_inbox_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = seller, pg_temp
SET row_security = off
AS $$ UPDATE webhook_inbox SET enqueued_at=now() WHERE id=p_inbox_id AND enqueued_at IS NULL $$;
REVOKE ALL ON FUNCTION seller.mark_nuvemshop_webhook_enqueued(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION seller.pending_nuvemshop_webhooks(p_limit integer DEFAULT 100)
RETURNS TABLE(tenant_id uuid, integration_id uuid, inbox_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = seller, pg_temp
SET row_security = off
AS $$
  SELECT w.tenant_id,w.integration_id,w.id
  FROM webhook_inbox w JOIN integrations i
    ON i.tenant_id=w.tenant_id AND i.id=w.integration_id
  WHERE i.provider='nuvemshop' AND w.enqueued_at IS NULL AND w.processed_at IS NULL
  ORDER BY w.received_at
  LIMIT LEAST(GREATEST(p_limit,1),500)
$$;
REVOKE ALL ON FUNCTION seller.pending_nuvemshop_webhooks(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION seller.nuvemshop_webhook_retry_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE(tenant_id uuid, integration_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = seller, pg_temp
SET row_security = off
AS $$
  SELECT i.tenant_id,i.id
  FROM integrations i
  WHERE i.provider='nuvemshop' AND i.disconnected_at IS NULL
    AND EXISTS (SELECT 1 FROM integration_webhooks w
      WHERE w.tenant_id=i.tenant_id AND w.integration_id=i.id AND w.status='error')
  ORDER BY i.created_at
  LIMIT LEAST(GREATEST(p_limit,1),200)
$$;
REVOKE ALL ON FUNCTION seller.nuvemshop_webhook_retry_candidates(integer) FROM PUBLIC;

CREATE INDEX integrations_provider_account_idx
  ON seller.integrations(provider, external_account_id) WHERE disconnected_at IS NULL;
CREATE UNIQUE INDEX integrations_nuvemshop_active_uidx
  ON seller.integrations(provider, external_account_id)
  WHERE provider='nuvemshop' AND disconnected_at IS NULL;
CREATE INDEX webhook_inbox_pending_idx
  ON seller.webhook_inbox(tenant_id, integration_id, received_at) WHERE processed_at IS NULL;
CREATE INDEX sync_runs_integration_idx ON seller.sync_runs(tenant_id, integration_id, started_at DESC);
