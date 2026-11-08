CREATE INDEX IF NOT EXISTS order_lines_variant_orders_idx
  ON seller.order_lines(tenant_id,variant_id,order_id)
  WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recommendations_open_rule_sku_idx
  ON seller.recommendations(tenant_id,rule_code,(evidence->>'sku'))
  WHERE status='open' AND rule_code='missing_cost';

CREATE INDEX IF NOT EXISTS recommendations_open_rule_order_idx
  ON seller.recommendations(tenant_id,rule_code,(evidence->>'orderId'))
  WHERE status='open' AND rule_code='negative_margin';

CREATE INDEX IF NOT EXISTS recommendations_open_rule_campaign_idx
  ON seller.recommendations(tenant_id,rule_code,(evidence->>'campaignId'))
  WHERE status='open' AND rule_code='campaign_margin_drain';
