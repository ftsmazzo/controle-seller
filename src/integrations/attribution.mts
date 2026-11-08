import { createHash } from 'node:crypto';
import type { Queryable } from '@/src/server/core.mjs';

interface Evidence {
  type: 'utm'|'click_identifier'|'external_identifier';
  source: string;
  medium: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  clickId: string | null;
  utm: Record<string,string>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function parseUrl(value: unknown): URL | null {
  const candidate = text(value);
  if (!candidate) return null;
  try { return new URL(candidate); } catch { return null; }
}
function valueFrom(payload: Record<string,unknown>, key: string): string | null {
  const direct = text(payload[key]);
  if (direct) return direct;
  const attributes = Array.isArray(payload.note_attributes)
    ? payload.note_attributes as Array<Record<string,unknown>> : [];
  return text(attributes.find(item => item.name === key)?.value);
}

export function extractAttributionEvidence(payload: Record<string,unknown>): Evidence | null {
  const url = parseUrl(payload.landing_url) ?? parseUrl(payload.referring_site);
  const parameter = (key: string) => valueFrom(payload, key) ?? url?.searchParams.get(key) ?? null;
  const utm = Object.fromEntries(
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']
      .map(key => [key, parameter(key)] as const).filter((entry): entry is [string,string] => Boolean(entry[1])),
  );
  const clickId = parameter('fbclid') ?? parameter('fbc');
  const campaignId = parameter('campaign_id') ?? parameter('utm_id');
  const adsetId = parameter('adset_id');
  const adId = parameter('ad_id');
  const source = utm.utm_source?.toLowerCase() ?? (clickId ? 'meta' : '');
  const isMeta = ['meta','facebook','instagram','fb','ig'].includes(source) || Boolean(clickId || campaignId || adsetId || adId);
  if (!isMeta) return null;
  return {
    type: clickId ? 'click_identifier' : campaignId || adsetId || adId ? 'external_identifier' : 'utm',
    source: source || 'meta',
    medium: utm.utm_medium ?? null,
    campaignId, adsetId, adId, clickId, utm,
  };
}

export async function attributeOrderFromEvidence(
  db: Queryable, tenantId: string, orderId: string, payload: Record<string,unknown>,
) {
  const evidence = extractAttributionEvidence(payload);
  const order = await db.query<{ placed_at:Date; status:string }>(
    `SELECT placed_at,status FROM seller.orders WHERE tenant_id=$1 AND id=$2`,
    [tenantId, orderId],
  );
  if (!order.rows[0]) return;
  const model = await db.query<{ id:string }>(
    `INSERT INTO seller.attribution_models(tenant_id,version,model,window_days,evidence_rules)
     VALUES($1,'evidence-last-touch-v1','last_evidence',28,$2)
     ON CONFLICT (tenant_id,version) DO UPDATE SET version=excluded.version
     RETURNING id`,
    [tenantId, { accepted: ['utm','click_identifier','external_identifier'], causal: false }],
  );
  if (order.rows[0].status !== 'paid' || !evidence) {
    await db.query(
      `DELETE FROM seller.attribution_links
       WHERE tenant_id=$1 AND order_id=$2 AND attribution_model_id=$3`,
      [tenantId, orderId, model.rows[0]!.id],
    );
    return;
  }
  const account = evidence.campaignId
    ? await db.query<{ id:string }>(
      `SELECT a.id FROM seller.ad_accounts a JOIN seller.ad_campaigns c
         ON c.tenant_id=a.tenant_id AND c.ad_account_id=a.id
       WHERE a.tenant_id=$1 AND c.external_id=$2 AND a.selected=true LIMIT 1`,
      [tenantId, evidence.campaignId],
    ) : { rows: [] };
  const provenance = { source: 'nuvemshop_order', method: 'explicit_evidence', version: 'v1' };
  const fingerprint = createHash('sha256').update(JSON.stringify({
    orderId, evidence, occurredAt: order.rows[0].placed_at.toISOString(),
  })).digest('hex');
  const touchpoint = await db.query<{ id:string }>(
    `INSERT INTO seller.marketing_touchpoints
      (tenant_id,ad_account_id,occurred_at,source,medium,campaign_external_id,adset_external_id,
       ad_external_id,click_identifier,utm,evidence,evidence_hash,provenance,quality)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (tenant_id,evidence_hash) DO UPDATE SET evidence=excluded.evidence
     RETURNING id`,
    [tenantId, account.rows[0]?.id ?? null, order.rows[0].placed_at, evidence.source, evidence.medium,
      evidence.campaignId, evidence.adsetId, evidence.adId, evidence.clickId, evidence.utm, evidence,
      fingerprint, provenance, { explicit: true, causal: false }],
  );
  const totals = await db.query<{ revenue:string; margin:string|null }>(
    `WITH lines AS (
       SELECT coalesce(sum(ol.quantity*ol.unit_price_cents),0)::bigint gross,
         coalesce(sum(ol.discount_cents),0)::bigint line_discount,
         CASE WHEN o.status='cancelled' THEN 0
           WHEN bool_and(coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents) IS NOT NULL
             AND ol.restocked_quantity IS NOT NULL)
           THEN sum((ol.quantity-ol.restocked_quantity)
             *coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents)) END::bigint cogs,
         o.status
       FROM seller.order_lines ol
       JOIN seller.orders o ON o.tenant_id=ol.tenant_id AND o.id=ol.order_id
       LEFT JOIN LATERAL (
         SELECT unit_cost_cents FROM (
           SELECT c.unit_cost_cents,c.effective_at,
             CASE WHEN c.integration_id=o.integration_id THEN 2 ELSE 1 END priority
           FROM seller.cost_channel_versions c
           WHERE c.tenant_id=ol.tenant_id AND c.variant_id=ol.variant_id
             AND (c.integration_id=o.integration_id OR c.integration_id IS NULL)
             AND c.effective_at<=o.placed_at
           UNION ALL
           SELECT c.unit_cost_cents,c.effective_at,0 priority FROM seller.cost_versions c
           WHERE c.tenant_id=ol.tenant_id AND c.variant_id=ol.variant_id
             AND c.effective_at<=o.placed_at
         ) available_costs ORDER BY priority DESC,effective_at DESC LIMIT 1
       ) cv ON true WHERE ol.tenant_id=$1 AND ol.order_id=$2 GROUP BY o.status
     ), events AS (
       SELECT
         greatest(-coalesce(sum(direction*amount_cents) FILTER (WHERE kind='order_discount'),0),0)::bigint order_discount,
         coalesce(sum(amount_cents) FILTER (WHERE kind='shipping' AND direction=1),0)::bigint shipping_revenue,
         greatest(-coalesce(sum(direction*amount_cents) FILTER (WHERE kind='refund'),0),0)::bigint refund,
         CASE WHEN bool_or(kind='payment_fee') THEN greatest(-sum(direction*amount_cents) FILTER (WHERE kind='payment_fee'),0) END::bigint fees,
         CASE WHEN bool_or(kind='shipping' AND direction=-1) THEN sum(amount_cents) FILTER (WHERE kind='shipping' AND direction=-1) END::bigint shipping_cost,
         CASE WHEN bool_or(kind='tax') THEN greatest(-sum(direction*amount_cents) FILTER (WHERE kind='tax'),0) END::bigint taxes,
         CASE WHEN bool_or(kind='packaging') THEN greatest(-sum(direction*amount_cents) FILTER (WHERE kind='packaging'),0) END::bigint packaging,
         CASE WHEN bool_or(kind='cashback') THEN greatest(-sum(direction*amount_cents) FILTER (WHERE kind='cashback'),0) END::bigint cashback
       FROM seller.order_events WHERE tenant_id=$1 AND order_id=$2
     ), calculated AS (
       SELECT CASE WHEN lines.status IN ('pending','cancelled') THEN 0 ELSE greatest(
         lines.gross-lines.line_discount-events.order_discount
           +events.shipping_revenue-events.refund,0) END::bigint revenue,
         lines.cogs,events.fees,events.shipping_cost,events.taxes,events.packaging,events.cashback
       FROM lines,events
     )
     SELECT revenue::text,
       CASE WHEN cogs IS NOT NULL AND fees IS NOT NULL AND shipping_cost IS NOT NULL
         AND taxes IS NOT NULL AND packaging IS NOT NULL AND cashback IS NOT NULL
         THEN (revenue-cogs-fees-shipping_cost-taxes-packaging-cashback)::text END margin
     FROM calculated`,
    [tenantId, orderId],
  );
  await db.query(
    `DELETE FROM seller.attribution_links
     WHERE tenant_id=$1 AND order_id=$2 AND attribution_model_id=$3 AND touchpoint_id<>$4`,
    [tenantId, orderId, model.rows[0]!.id, touchpoint.rows[0]!.id],
  );
  await db.query(
    `INSERT INTO seller.attribution_links
      (tenant_id,order_id,touchpoint_id,attribution_model_id,evidence_type,confidence,weight,
       attributed_net_revenue_cents,attributed_margin_cents,provenance)
     VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8)
     ON CONFLICT (tenant_id,order_id,touchpoint_id,attribution_model_id) DO UPDATE SET
       attributed_net_revenue_cents=excluded.attributed_net_revenue_cents,
       attributed_margin_cents=excluded.attributed_margin_cents,provenance=excluded.provenance`,
    [tenantId, orderId, touchpoint.rows[0]!.id, model.rows[0]!.id, evidence.type,
      totals.rows[0]!.revenue, totals.rows[0]!.margin, provenance],
  );
}

export async function recalculateAttributionsForVariantPage(
  db: Queryable,
  input: {
    tenantId: string;
    variantId: string;
    sku: string;
    effectiveAt: Date;
    integrationId: string | null;
    afterOrderId?: string | null;
    limit?: number;
  },
): Promise<{ nextOrderId: string | null; processed: number }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const orders = await db.query<{ id:string; source_payload:Record<string,unknown>|null }>(
    `SELECT DISTINCT o.id,o.source_payload FROM seller.orders o
     JOIN seller.order_lines ol ON ol.tenant_id=o.tenant_id AND ol.order_id=o.id
     WHERE o.tenant_id=$1 AND ol.variant_id=$2 AND o.placed_at >= $3
       AND ($4::uuid IS NULL OR o.integration_id=$4)
       AND ($5::uuid IS NULL OR o.id>$5)
     ORDER BY o.id LIMIT $6`,
    [input.tenantId,input.variantId,input.effectiveAt,input.integrationId,input.afterOrderId??null,limit],
  );
  for (const order of orders.rows) {
    if (order.source_payload) {
      await attributeOrderFromEvidence(db,input.tenantId,order.id,order.source_payload);
    } else {
      await db.query(
        `DELETE FROM seller.attribution_links WHERE tenant_id=$1 AND order_id=$2`,
        [input.tenantId,order.id],
      );
    }
  }
  const orderIds = orders.rows.map(order => order.id);
  await db.query(
    `UPDATE seller.recommendations SET status='expired',updated_at=now()
     WHERE tenant_id=$1 AND status='open' AND (
       (rule_code='missing_cost' AND evidence->>'sku'=$2)
       OR (rule_code='negative_margin' AND evidence->>'orderId'=ANY($3::text[]))
       OR (rule_code='campaign_margin_drain' AND evidence->>'campaignId' IN (
         SELECT c.id::text FROM seller.ad_campaigns c
         WHERE c.tenant_id=$1 AND c.external_id IN (
           SELECT DISTINCT mt.campaign_external_id
           FROM seller.attribution_links al
           JOIN seller.marketing_touchpoints mt
             ON mt.tenant_id=al.tenant_id AND mt.id=al.touchpoint_id
           WHERE al.tenant_id=$1 AND al.order_id=ANY($3::uuid[])
             AND mt.campaign_external_id IS NOT NULL
         )
       ))
     )`,
    [input.tenantId,input.sku,orderIds],
  );
  return {
    nextOrderId: orders.rows.length === limit ? orders.rows.at(-1)!.id : null,
    processed: orders.rows.length,
  };
}
