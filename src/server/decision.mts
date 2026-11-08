import type { PoolClient } from 'pg';
import { generateRecommendations, type DecisionSignals } from '@/src/decision-product.mjs';
import { summarizeDecisionFacts, type DecisionOrderFact } from './decision-finance.mts';
import { withTenant } from './core.mts';

export interface DecisionFilters {
  from: Date;
  to: Date;
  channel?: string | undefined;
  status?: string | undefined;
  q?: string | undefined;
}

const values = (filters: DecisionFilters) => [
  filters.from, filters.to, filters.channel ?? null, filters.status ?? null, filters.q ?? null,
];

const orderWhere = `
  o.placed_at >= $1 AND o.placed_at < ($2::date + interval '1 day')
  AND ($3::text IS NULL OR i.provider=$3)
  AND ($4::text IS NULL OR o.status=$4)
  AND ($5::text IS NULL OR o.external_id ILIKE '%'||$5||'%'
    OR EXISTS (SELECT 1 FROM seller.order_lines sx WHERE sx.tenant_id=o.tenant_id
      AND sx.order_id=o.id AND sx.sku_snapshot ILIKE '%'||$5||'%'))`;

export async function readDecisionData(
  tenantId: string, userId: string, filters: DecisionFilters,
) {
  return withTenant(tenantId, userId, async client => {
    const [summary, expenses, freshness, orders, products, marketing, integrations, quality, receipts] = await Promise.all([
      client.query(`WITH selected AS (
        SELECT o.id,o.status,o.integration_id,o.placed_at
        FROM seller.orders o
        LEFT JOIN seller.integrations i ON i.tenant_id=o.tenant_id AND i.id=o.integration_id
        WHERE ${orderWhere}
      ), lines AS (
        SELECT o.id,o.status,
          sum(ol.quantity*ol.unit_price_cents)::bigint gross_cents,
          sum(ol.discount_cents)::bigint line_discount_cents,
          CASE WHEN o.status='cancelled' THEN 0
            WHEN bool_and(coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents) IS NOT NULL
              AND ol.restocked_quantity IS NOT NULL)
            THEN sum((ol.quantity-ol.restocked_quantity)
              *coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents)) END::bigint cogs_cents
        FROM selected o
        JOIN seller.order_lines ol ON ol.order_id=o.id
        LEFT JOIN LATERAL (SELECT unit_cost_cents FROM (
          SELECT c.unit_cost_cents,c.effective_at,(c.integration_id IS NOT NULL)::int priority
          FROM seller.cost_channel_versions c
          WHERE c.variant_id=ol.variant_id AND (c.integration_id=o.integration_id OR c.integration_id IS NULL)
            AND c.effective_at<=o.placed_at
          UNION ALL
          SELECT c.unit_cost_cents,c.effective_at,0 FROM seller.cost_versions c
          WHERE c.variant_id=ol.variant_id AND c.effective_at<=o.placed_at
        ) available ORDER BY priority DESC,effective_at DESC LIMIT 1) cv ON true
        GROUP BY o.id,o.status
      ), events AS (
        SELECT s.id,
          greatest(-coalesce(sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='order_discount'),0),0)::bigint order_discount_cents,
          coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='shipping' AND e.direction=1),0)::bigint shipping_revenue_cents,
          greatest(-coalesce(sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='refund'),0),0)::bigint refund_cents,
          CASE WHEN bool_or(e.kind='payment_fee') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='payment_fee'),0) END::bigint fees_cents,
          CASE WHEN bool_or(e.kind='shipping' AND e.direction=-1) THEN sum(e.amount_cents) FILTER (WHERE e.kind='shipping' AND e.direction=-1) END::bigint shipping_cost_cents,
          CASE WHEN bool_or(e.kind='tax') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='tax'),0) END::bigint tax_cents,
          CASE WHEN bool_or(e.kind='packaging') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='packaging'),0) END::bigint packaging_cents,
          CASE WHEN bool_or(e.kind='cashback') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='cashback'),0) END::bigint cashback_cents
        FROM selected s LEFT JOIN seller.order_events e ON e.order_id=s.id GROUP BY s.id
      )
      SELECT l.id,l.status,l.gross_cents::text,l.line_discount_cents::text,
        e.order_discount_cents::text,e.shipping_revenue_cents::text,e.refund_cents::text,
        l.cogs_cents::text,e.fees_cents::text,e.shipping_cost_cents::text,e.tax_cents::text,
        e.packaging_cents::text,e.cashback_cents::text
      FROM lines l JOIN events e ON e.id=l.id`, values(filters)),
      client.query(`SELECT category,amount_cents::text
        FROM seller.expenses WHERE competence_date BETWEEN $1::date AND $2::date`,
      [filters.from,filters.to]),
      client.query<{updated_at:Date|null}>(`SELECT max(greatest(o.source_updated_at,o.imported_at)) updated_at
        FROM seller.orders o LEFT JOIN seller.integrations i
          ON i.tenant_id=o.tenant_id AND i.id=o.integration_id WHERE ${orderWhere}`, values(filters)),
      client.query(`WITH selected AS (
        SELECT o.id,o.external_id,o.status,o.placed_at,o.currency,o.integration_id,i.provider
        FROM seller.orders o LEFT JOIN seller.integrations i
          ON i.tenant_id=o.tenant_id AND i.id=o.integration_id WHERE ${orderWhere}
        ORDER BY o.placed_at DESC LIMIT 250
      ), lines AS (
        SELECT o.id,
          sum(ol.quantity*ol.unit_price_cents)::bigint gross,
          sum(ol.discount_cents)::bigint line_discount,
          CASE WHEN o.status='cancelled' THEN 0
            WHEN bool_and(coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents) IS NOT NULL
              AND ol.restocked_quantity IS NOT NULL)
            THEN sum((ol.quantity-ol.restocked_quantity)
              *coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents)) END::bigint cogs,
          json_agg(json_build_object('id',ol.id,'sku',ol.sku_snapshot,'quantity',ol.quantity,
            'unitPriceCents',ol.unit_price_cents::text,'discountCents',ol.discount_cents::text,
            'returnedQuantity',ol.returned_quantity,'restockedQuantity',ol.restocked_quantity,
            'unitCostCents',coalesce(ol.unit_cost_snapshot_cents,cv.unit_cost_cents)::text)
            ORDER BY ol.external_line_id) lines
        FROM selected o JOIN seller.order_lines ol ON ol.order_id=o.id
        LEFT JOIN LATERAL (SELECT unit_cost_cents FROM (
          SELECT c.unit_cost_cents,c.effective_at,(c.integration_id IS NOT NULL)::int priority
          FROM seller.cost_channel_versions c WHERE c.variant_id=ol.variant_id
            AND (c.integration_id=o.integration_id OR c.integration_id IS NULL) AND c.effective_at<=o.placed_at
          UNION ALL SELECT c.unit_cost_cents,c.effective_at,0 FROM seller.cost_versions c
          WHERE c.variant_id=ol.variant_id AND c.effective_at<=o.placed_at
        ) available ORDER BY priority DESC,effective_at DESC LIMIT 1) cv ON true GROUP BY o.id,o.status
      ), events AS (
        SELECT s.id,
          greatest(-coalesce(sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='order_discount'),0),0)::bigint order_discount,
          coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='shipping' AND e.direction=1),0)::bigint shipping_revenue,
          greatest(-coalesce(sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='refund'),0),0)::bigint refund,
          CASE WHEN bool_or(e.kind='payment_fee') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='payment_fee'),0) END::bigint fees,
          CASE WHEN bool_or(e.kind='shipping' AND e.direction=-1) THEN sum(e.amount_cents) FILTER (WHERE e.kind='shipping' AND e.direction=-1) END::bigint shipping_cost,
          CASE WHEN bool_or(e.kind='tax') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='tax'),0) END::bigint taxes,
          CASE WHEN bool_or(e.kind='packaging') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='packaging'),0) END::bigint packaging,
          CASE WHEN bool_or(e.kind='cashback') THEN greatest(-sum(e.direction*e.amount_cents) FILTER (WHERE e.kind='cashback'),0) END::bigint cashback
        FROM selected s LEFT JOIN seller.order_events e ON e.order_id=s.id GROUP BY s.id
      )
      SELECT s.id,s.external_id,s.status,s.placed_at,s.currency,s.provider,l.lines,
        (CASE WHEN s.status IN ('pending','cancelled') THEN 0 ELSE greatest(
          l.gross-l.line_discount-e.order_discount+e.shipping_revenue-e.refund,0) END)::text revenue_cents,
        CASE WHEN s.status<>'pending' AND l.cogs IS NOT NULL AND e.fees IS NOT NULL
          AND e.shipping_cost IS NOT NULL AND e.taxes IS NOT NULL AND e.packaging IS NOT NULL
          AND e.cashback IS NOT NULL THEN
          (CASE WHEN s.status='cancelled' THEN 0 ELSE greatest(
            l.gross-l.line_discount-e.order_discount+e.shipping_revenue-e.refund,0) END)
          -l.cogs-e.fees-e.shipping_cost-e.taxes-e.packaging-e.cashback END::text contribution_cents
      FROM selected s JOIN lines l ON l.id=s.id JOIN events e ON e.id=s.id
      ORDER BY s.placed_at DESC`, values(filters)),
      client.query(`SELECT p.id,p.name,v.id variant_id,v.sku,v.price_cents::text,v.stock::text,
        i.provider,cv.unit_cost_cents::text cost_cents,cv.effective_at cost_effective_at,
        (SELECT count(*)::int FROM seller.order_lines ol WHERE ol.tenant_id=v.tenant_id AND ol.variant_id=v.id) sold_lines
        FROM seller.products p JOIN seller.variants v ON v.tenant_id=p.tenant_id AND v.product_id=p.id
        LEFT JOIN seller.integrations i ON i.tenant_id=p.tenant_id AND i.id=p.integration_id
        LEFT JOIN LATERAL (SELECT unit_cost_cents,effective_at FROM (
          SELECT c.unit_cost_cents,c.effective_at,0 priority FROM seller.cost_channel_versions c
          WHERE c.tenant_id=v.tenant_id AND c.variant_id=v.id
          UNION ALL SELECT c.unit_cost_cents,c.effective_at,0 FROM seller.cost_versions c
          WHERE c.tenant_id=v.tenant_id AND c.variant_id=v.id
        ) costs ORDER BY priority DESC,effective_at DESC LIMIT 1) cv ON true
        WHERE p.archived_at IS NULL AND v.archived_at IS NULL
          AND ($1::text IS NULL OR i.provider=$1) AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR v.sku ILIKE '%'||$2||'%')
        ORDER BY p.name,v.sku LIMIT 500`, [filters.channel ?? null, filters.q ?? null]),
      client.query(`WITH facts AS (
          SELECT c.id,c.name,f.id fact_id,f.currency,f.spend_cents
          FROM seller.ad_campaigns c JOIN seller.ad_insight_facts f
            ON f.tenant_id=c.tenant_id AND f.object_level='campaign' AND f.object_id=c.id
          WHERE f.metric_date BETWEEN $1::date AND $2::date
        ), spend AS (
          SELECT f.id,f.name,f.currency,sum(f.spend_cents)::bigint spend,
            sum(coalesce((SELECT max(pc.declared_value_cents)
              FROM seller.platform_conversions pc
              WHERE pc.tenant_id=$4 AND pc.insight_fact_id=f.fact_id
                AND pc.action_type=ANY($3::text[])),0))::bigint declared
          FROM facts f GROUP BY f.id,f.name,f.currency
        ), attributed AS (
          SELECT mt.campaign_external_id,sum(al.attributed_net_revenue_cents)::bigint revenue,
            CASE WHEN bool_and(al.attributed_margin_cents IS NOT NULL)
              THEN sum(al.attributed_margin_cents) END::bigint margin,
            count(DISTINCT al.order_id)::int orders
          FROM seller.attribution_links al JOIN seller.marketing_touchpoints mt
            ON mt.tenant_id=al.tenant_id AND mt.id=al.touchpoint_id
          JOIN seller.orders o ON o.tenant_id=al.tenant_id AND o.id=al.order_id
          WHERE o.placed_at >= $1 AND o.placed_at < ($2::date+interval '1 day')
          GROUP BY mt.campaign_external_id
        ) SELECT s.*,coalesce(a.revenue,0)::text attributed_revenue,
          a.margin::text attributed_margin,coalesce(a.orders,0) attributed_orders
        FROM spend s LEFT JOIN seller.ad_campaigns c ON c.id=s.id
        LEFT JOIN attributed a ON a.campaign_external_id=c.external_id ORDER BY s.spend DESC`, [
          filters.from,filters.to,
          (process.env.META_PURCHASE_ACTION_TYPES??'purchase,omni_purchase,offsite_conversion.fb_pixel_purchase')
            .split(',').map(value=>value.trim()).filter(Boolean),
          tenantId,
        ]),
      client.query(`SELECT id,provider,display_name,status,last_sync_at,last_error,created_at
        FROM seller.integrations ORDER BY provider,created_at DESC`),
      client.query(`SELECT id,code,severity,resource_type,details,detected_at
        FROM seller.data_quality_issues WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT 200`),
      client.query(`SELECT o.id,o.external_id,o.placed_at,o.currency,
        sum(ol.quantity*ol.unit_price_cents-ol.discount_cents)::text amount_cents,i.provider
        FROM seller.orders o JOIN seller.order_lines ol ON ol.tenant_id=o.tenant_id AND ol.order_id=o.id
        LEFT JOIN seller.integrations i ON i.tenant_id=o.tenant_id AND i.id=o.integration_id
        WHERE ${orderWhere} AND o.status='paid'
        GROUP BY o.id,i.provider ORDER BY o.placed_at DESC LIMIT 250`, values(filters)),
    ]);
    const facts = summary.rows.map(row => ({
      id:String(row.id),status:String(row.status) as DecisionOrderFact['status'],
      grossCents:Number(row.gross_cents),lineDiscountCents:Number(row.line_discount_cents),
      orderDiscountCents:Number(row.order_discount_cents),shippingRevenueCents:Number(row.shipping_revenue_cents),
      refundCents:Number(row.refund_cents),cogsCents:row.cogs_cents==null?null:Number(row.cogs_cents),
      feesCents:row.fees_cents==null?null:Number(row.fees_cents),
      shippingCostCents:row.shipping_cost_cents==null?null:Number(row.shipping_cost_cents),
      taxCents:row.tax_cents==null?null:Number(row.tax_cents),
      packagingCents:row.packaging_cents==null?null:Number(row.packaging_cents),
      cashbackCents:row.cashback_cents==null?null:Number(row.cashback_cents),
    }));
    const totals = summarizeDecisionFacts(facts, expenses.rows.map(row => ({
      category:String(row.category) as 'ads'|'operating',amountCents:Number(row.amount_cents),
    })));
    const orderCount = totals.orderCount;
    const campaignRows = marketing.rows as Array<Record<string,unknown>>;
    const productRows = products.rows as Array<Record<string,unknown>>;
    const orderRows = orders.rows as Array<Record<string,unknown>>;
    const integrationRows = integrations.rows as Array<Record<string,unknown>>;
    const signals: DecisionSignals = {
      negativeMarginOrders: orderRows.filter(row => row.contribution_cents != null && Number(row.contribution_cents) < 0)
        .map(row => ({ id:String(row.id), contributionCents:Number(row.contribution_cents) })),
      missingCostSkus: productRows.filter(row => row.cost_cents == null && Number(row.sold_lines)>0)
        .map(row => ({ sku:String(row.sku), orders:Number(row.sold_lines) })),
      criticalStock: productRows.filter(row => row.stock != null && Number(row.stock)<=3)
        .map(row => ({ sku:String(row.sku), stock:Number(row.stock) })),
      marginDrainingCampaigns: campaignRows.filter(row => row.attributed_margin!=null && Number(row.attributed_margin)-Number(row.spend)<0)
        .map(row => ({ id:String(row.id), name:String(row.name), marginAfterMediaCents:Number(row.attributed_margin)-Number(row.spend) })),
      integrations: integrationRows.map(row => ({
        id:String(row.id), provider:String(row.provider), status:String(row.status),
        lastSyncAt: row.last_sync_at instanceof Date ? row.last_sync_at : null,
      })),
      divergences: quality.rows.filter(row => row.code==='divergence').map((row, index) => ({
        id:`${row.resource_type}:${index}`, description:JSON.stringify(row.details),
      })),
      costCoverage: totals.coverage,
    };
    return {
      summary: {
        orders:orderCount, revenueCents:totals.revenueCents,
        knownContributionCents:totals.knownContributionCents,
        contributionCents:totals.contributionCents,
        managerialResultCents:totals.managerialResultCents,
        coverage:totals.coverage, updatedAt:freshness.rows[0]?.updated_at ?? null,
      },
      orders: orderRows, products:productRows, marketing:campaignRows, integrations:integrationRows,
      quality:quality.rows, receipts:receipts.rows, generatedRecommendations:generateRecommendations(signals),
    };
  });
}

export async function persistRecommendations(
  client: PoolClient, tenantId: string, period: { from:Date; to:Date },
  candidates: ReturnType<typeof generateRecommendations>,
) {
  for (const item of candidates) await client.query(
    `INSERT INTO seller.recommendations
      (tenant_id,kind,title,rationale,status,calculation_version,fingerprint,severity,period_start,
       period_end,rule_code,evidence,coverage,confidence,suggested_action,updated_at)
     VALUES($1,$2,$3,$4,'open','decision-v1',$5,$6,$7,$8,$2,$9,$10,$11,$12,now())
     ON CONFLICT (tenant_id,fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE SET
       title=excluded.title,evidence=excluded.evidence,coverage=excluded.coverage,
       confidence=excluded.confidence,suggested_action=excluded.suggested_action,updated_at=now()`,
    [tenantId,item.rule,item.title,{ deterministic:true },item.fingerprint,item.severity,
      period.from,period.to,item.evidence,item.coverage,item.confidence,item.suggestedAction],
  );
}
