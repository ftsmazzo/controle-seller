-- PROPOSTA INICIAL, NÃO APLICADA A UM BANCO.
-- PostgreSQL 15+. Revisar e testar migração, autenticação, RLS e restauração
-- antes de usar dados reais. Não cria contas nem conecta nenhum canal.
-- O backend deve autenticar o usuário, conferir membership e definir tenant_id
-- via SET LOCAL, dentro de uma transação, usando uma role sem BYPASSRLS.
-- Clientes nunca recebem acesso direto ao banco nem podem escolher esse contexto.
BEGIN;
CREATE SCHEMA IF NOT EXISTS seller;

CREATE TABLE seller.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE seller.memberships (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id),
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'analyst')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id)
);
CREATE TABLE seller.channel_accounts (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id),
  id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('nuvemshop', 'mercadolivre', 'shopee', 'shein')),
  external_store_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  secret_reference text, -- Somente referência ao cofre; nunca token em texto.
  last_synced_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel, external_store_id)
);
CREATE TABLE seller.variants (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id),
  id uuid NOT NULL,
  sku text NOT NULL,
  product_name text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku)
);
CREATE TABLE seller.channel_listings (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES seller.channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  UNIQUE (tenant_id, account_id, external_product_id, external_variant_id)
);
CREATE TABLE seller.cost_versions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  variant_id uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  source text NOT NULL CHECK (source IN ('manual', 'import', 'integration')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  UNIQUE (tenant_id, variant_id, effective_at)
);
-- Custos serão append-only pela API; não regravar versões já utilizadas.
-- Custo ausente = inexistência de versão aplicável, nunca custo zero.
CREATE TABLE seller.orders (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  external_order_id text NOT NULL,
  placed_at timestamptz NOT NULL,
  financial_status text NOT NULL,
  fulfillment_status text,
  gross_cents bigint NOT NULL CHECK (gross_cents >= 0),
  seller_discount_cents bigint NOT NULL DEFAULT 0 CHECK (seller_discount_cents >= 0),
  shipping_revenue_cents bigint NOT NULL DEFAULT 0 CHECK (shipping_revenue_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  source_updated_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES seller.channel_accounts(tenant_id, id),
  UNIQUE (tenant_id, account_id, external_order_id),
  CHECK (seller_discount_cents <= gross_cents)
);
CREATE TABLE seller.order_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  variant_id uuid, -- Pode estar pendente de mapeamento.
  source_line_id text NOT NULL,
  sku_snapshot text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  cost_version_id uuid,
  unit_cost_snapshot_cents bigint CHECK (unit_cost_snapshot_cents >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES seller.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_version_id) REFERENCES seller.cost_versions(tenant_id, id),
  UNIQUE (tenant_id, order_id, source_line_id)
);
CREATE TABLE seller.financial_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  source_event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'fee', 'shipping_cost', 'tax', 'packaging', 'cashback',
    'refund', 'refund_fee', 'fee_reversal', 'tax_reversal'
  )),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  quality text NOT NULL CHECK (quality IN ('estimated', 'confirmed')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES seller.orders(tenant_id, id),
  UNIQUE (tenant_id, order_id, source_event_key)
);
-- Um valor conhecido igual a zero deve ser um evento explícito.
-- Evento ausente não será presumido zero. A projeção valida cobertura por campo.
-- financial_events é append-only; reversões geram eventos compensatórios.
CREATE TABLE seller.stock_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  variant_id uuid NOT NULL,
  source_event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'receipt', 'sale', 'restock', 'loss', 'adjustment')),
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES seller.variants(tenant_id, id),
  UNIQUE (tenant_id, source_event_key)
);
CREATE TABLE seller.expenses (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('ads', 'operating')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  competence_date date NOT NULL,
  due_date date,
  paid_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES seller.channel_accounts(tenant_id, id)
);
CREATE TABLE seller.settlements (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider text NOT NULL, -- Provedor confirmado; não inferir pelo canal.
  external_settlement_id text NOT NULL,
  expected_at timestamptz,
  received_at timestamptz,
  expected_cents bigint CHECK (expected_cents >= 0),
  received_cents bigint CHECK (received_cents >= 0),
  status text NOT NULL CHECK (status IN ('expected', 'received', 'held', 'disputed')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES seller.channel_accounts(tenant_id, id),
  UNIQUE (tenant_id, account_id, provider, external_settlement_id)
);
CREATE TABLE seller.settlement_allocations (
  tenant_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_cents bigint NOT NULL, -- Ajustes podem ser negativos.
  PRIMARY KEY (tenant_id, settlement_id, order_id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES seller.settlements(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES seller.orders(tenant_id, id)
);
CREATE TABLE seller.sync_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  deduplication_key text NOT NULL,
  resource_type text NOT NULL,
  source_updated_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'retry', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at timestamptz,
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES seller.channel_accounts(tenant_id, id),
  UNIQUE (tenant_id, account_id, deduplication_key)
);
CREATE TABLE seller.audit_log (
  tenant_id uuid NOT NULL REFERENCES seller.tenants(id),
  id uuid NOT NULL,
  subject_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX orders_period_idx ON seller.orders(tenant_id, placed_at, account_id);
CREATE INDEX financial_events_order_idx ON seller.financial_events(tenant_id, order_id, occurred_at);
CREATE INDEX settlements_due_idx ON seller.settlements(tenant_id, expected_at) WHERE received_at IS NULL;
CREATE INDEX sync_retry_idx ON seller.sync_events(tenant_id, retry_at) WHERE status IN ('queued', 'retry');

CREATE FUNCTION seller.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
ALTER TABLE seller.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON seller.tenants
  USING (id = seller.current_tenant()) WITH CHECK (id = seller.current_tenant());
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships', 'channel_accounts', 'variants', 'channel_listings',
    'cost_versions', 'orders', 'order_lines', 'financial_events', 'stock_events',
    'expenses', 'settlements', 'settlement_allocations', 'sync_events', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE seller.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE seller.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON seller.%I USING (tenant_id = seller.current_tenant()) WITH CHECK (tenant_id = seller.current_tenant())',
      table_name
    );
  END LOOP;
END $$;
-- Grants, bootstrap de empresa, autorização por papel, cofre de segredos,
-- imutabilidade de eventos e testes de acesso ficam para a implementação do backend.
-- RLS não substitui a autorização na API e não protege roles superuser/BYPASSRLS.
COMMIT;
