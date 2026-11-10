import type { PoolClient } from 'pg';
import { z } from 'zod';
import { runEnsembleForecast, rollingBaselineBacktest, type EnsembleResult } from '@/src/predictive/ensemble.mjs';
import type { DailyPoint } from '@/src/predictive/features.mjs';
import { withTenant } from './core.mts';

export const forecastQuerySchema = z.object({
  horizon: z.coerce.number().refine(v => v === 30 || v === 60 || v === 90),
  scenario: z.enum(['baseline', 'ads_up', 'ads_down', 'custom']).default('baseline'),
  dailyAdsSpendCents: z.coerce.number().int().nonnegative().optional(),
});

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

function isMissingRelation(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return err?.code === '42P01' || /does not exist|relation/i.test(String(err?.message ?? error));
}

function toDailyPoint(row: Record<string, unknown>): DailyPoint {
  return {
    metricDate: String(row.metric_date).slice(0, 10),
    revenueCents: Number(row.revenue_cents),
    ordersCount: Number(row.orders_count),
    avgTicketCents: Number(row.avg_ticket_cents),
    revenueNuvemshopCents: Number(row.revenue_nuvemshop_cents),
    revenueMercadolivreCents: Number(row.revenue_mercadolivre_cents),
    revenueShopeeCents: Number(row.revenue_shopee_cents),
    revenueShopifyCents: Number(row.revenue_shopify_cents),
    revenueOtherCents: Number(row.revenue_other_cents),
    adsSpendCents: Number(row.ads_spend_cents),
    adsImpressions: Number(row.ads_impressions),
    adsClicks: Number(row.ads_clicks),
    adsDeclaredPurchaseCents: Number(row.ads_declared_purchase_cents),
  };
}

const dailySeriesSql = `
  WITH sales AS (
    SELECT o.placed_at::date metric_date,
      coalesce(i.provider,'other') provider,
      sum(greatest(ol.quantity*ol.unit_price_cents - ol.discount_cents,0))::bigint revenue_cents,
      count(DISTINCT o.id)::int orders_count
    FROM seller.orders o
    JOIN seller.order_lines ol ON ol.tenant_id=o.tenant_id AND ol.order_id=o.id
    LEFT JOIN seller.integrations i ON i.tenant_id=o.tenant_id AND i.id=o.integration_id
    WHERE o.tenant_id=$1 AND o.status='paid'
    GROUP BY 1,2
  ), sales_pivot AS (
    SELECT metric_date,
      sum(revenue_cents)::bigint revenue_cents,
      sum(orders_count)::int orders_count,
      sum(revenue_cents) FILTER (WHERE provider='nuvemshop')::bigint revenue_nuvemshop_cents,
      sum(revenue_cents) FILTER (WHERE provider='mercado_livre' OR provider='mercadolivre')::bigint revenue_mercadolivre_cents,
      sum(revenue_cents) FILTER (WHERE provider='shopee')::bigint revenue_shopee_cents,
      sum(revenue_cents) FILTER (WHERE provider='shopify')::bigint revenue_shopify_cents,
      sum(revenue_cents) FILTER (
        WHERE provider IS DISTINCT FROM 'nuvemshop'
          AND provider IS DISTINCT FROM 'mercado_livre'
          AND provider IS DISTINCT FROM 'mercadolivre'
          AND provider IS DISTINCT FROM 'shopee'
          AND provider IS DISTINCT FROM 'shopify'
      )::bigint revenue_other_cents
    FROM sales
    GROUP BY metric_date
  ), ads AS (
    SELECT f.metric_date,
      sum(f.spend_cents)::bigint ads_spend_cents,
      coalesce(sum(f.impressions),0)::bigint ads_impressions,
      coalesce(sum(f.clicks),0)::bigint ads_clicks,
      coalesce(sum(pc.declared_value_cents),0)::bigint ads_declared_purchase_cents
    FROM seller.ad_insight_facts f
    JOIN seller.ad_accounts a ON a.tenant_id=f.tenant_id AND a.id=f.ad_account_id
    LEFT JOIN seller.platform_conversions pc
      ON pc.tenant_id=f.tenant_id AND pc.insight_fact_id=f.id
    WHERE f.tenant_id=$1
      AND f.object_level='campaign'
      AND a.selected IS TRUE
      AND a.archived_at IS NULL
    GROUP BY f.metric_date
  )
  SELECT coalesce(s.metric_date, a.metric_date)::text AS metric_date,
    coalesce(s.revenue_cents,0)::text AS revenue_cents,
    coalesce(s.orders_count,0) AS orders_count,
    CASE WHEN coalesce(s.orders_count,0)>0
      THEN (coalesce(s.revenue_cents,0) / s.orders_count) ELSE 0 END::text AS avg_ticket_cents,
    coalesce(s.revenue_nuvemshop_cents,0)::text AS revenue_nuvemshop_cents,
    coalesce(s.revenue_mercadolivre_cents,0)::text AS revenue_mercadolivre_cents,
    coalesce(s.revenue_shopee_cents,0)::text AS revenue_shopee_cents,
    coalesce(s.revenue_shopify_cents,0)::text AS revenue_shopify_cents,
    coalesce(s.revenue_other_cents,0)::text AS revenue_other_cents,
    coalesce(a.ads_spend_cents,0)::text AS ads_spend_cents,
    coalesce(a.ads_impressions,0)::text AS ads_impressions,
    coalesce(a.ads_clicks,0)::text AS ads_clicks,
    coalesce(a.ads_declared_purchase_cents,0)::text AS ads_declared_purchase_cents
  FROM sales_pivot s
  FULL OUTER JOIN ads a ON a.metric_date=s.metric_date
  WHERE coalesce(s.revenue_cents,0)>0 OR coalesce(a.ads_spend_cents,0)>0
  ORDER BY 1
`;

/** Série diária ao vivo a partir de pedidos + Meta (sem tabelas da 008). */
export async function loadDailySeriesLive(client: PoolClient, tenantId: string): Promise<DailyPoint[]> {
  const result = await client.query(dailySeriesSql, [tenantId]);
  return result.rows.map(toDailyPoint);
}

/** Materializa cache se a tabela 008 existir; senão no-op. */
export async function rebuildDailyStoreMetrics(client: PoolClient, tenantId: string): Promise<number> {
  try {
    await client.query(`DELETE FROM seller.daily_store_metrics WHERE tenant_id=$1`, [tenantId]);
  } catch (error) {
    if (isMissingRelation(error)) return 0;
    throw error;
  }
  const series = await loadDailySeriesLive(client, tenantId);
  for (const point of series) {
    await client.query(`
      INSERT INTO seller.daily_store_metrics (
        tenant_id, metric_date, revenue_cents, orders_count, avg_ticket_cents,
        revenue_nuvemshop_cents, revenue_mercadolivre_cents, revenue_shopee_cents,
        revenue_shopify_cents, revenue_other_cents,
        ads_spend_cents, ads_impressions, ads_clicks, ads_declared_purchase_cents,
        source_coverage, rebuilt_at
      ) VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,now())
    `, [
      tenantId, point.metricDate, point.revenueCents, point.ordersCount, point.avgTicketCents,
      point.revenueNuvemshopCents, point.revenueMercadolivreCents, point.revenueShopeeCents,
      point.revenueShopifyCents, point.revenueOtherCents,
      point.adsSpendCents, point.adsImpressions, point.adsClicks, point.adsDeclaredPurchaseCents,
    ]);
  }
  return series.length;
}

export async function loadDailySeries(client: PoolClient, tenantId: string): Promise<DailyPoint[]> {
  try {
    const result = await client.query(`
      SELECT metric_date::text, revenue_cents::text, orders_count,
        avg_ticket_cents::text,
        revenue_nuvemshop_cents::text, revenue_mercadolivre_cents::text,
        revenue_shopee_cents::text, revenue_shopify_cents::text, revenue_other_cents::text,
        ads_spend_cents::text, ads_impressions::text, ads_clicks::text,
        ads_declared_purchase_cents::text
      FROM seller.daily_store_metrics
      WHERE tenant_id=$1
      ORDER BY metric_date
    `, [tenantId]);
    if (result.rows.length) return result.rows.map(toDailyPoint);
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }
  return loadDailySeriesLive(client, tenantId);
}

async function persistForecast(
  client: PoolClient,
  tenantId: string,
  horizonDays: 30 | 60 | 90,
  scenario: ForecastQuery['scenario'],
  adsSpendAssumedCents: number | null,
  result: EnsembleResult,
) {
  try {
    const asOf = result.actualVsPredicted.at(-1)?.date
      ?? new Date().toISOString().slice(0, 10);
    const run = await client.query<{ id: string }>(`
      INSERT INTO seller.forecast_runs(
        tenant_id, as_of_date, horizon_days, scenario, ads_spend_assumed_cents,
        model_version, calculation_version, mae, mape, rmse, train_days, drivers, metrics
      ) VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
      RETURNING id
    `, [
      tenantId, asOf, horizonDays, scenario, adsSpendAssumedCents,
      result.modelVersion, result.calculationVersion,
      result.metrics.validation.mae, result.metrics.validation.mape, result.metrics.validation.rmse,
      result.trainDays, JSON.stringify(result.drivers), JSON.stringify(result.metrics),
    ]);
    const runId = run.rows[0]!.id;
    if (result.points.length) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      result.points.forEach((point, index) => {
        const o = index * 12;
        placeholders.push(
          `($${o + 1},$${o + 2},$${o + 3}::date,$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12})`,
        );
        values.push(
          tenantId, runId, point.targetDate, point.yhatCents, point.yhatP10Cents,
          point.yhatP50Cents, point.yhatP90Cents, point.yhatNuvemshopCents,
          point.yhatMercadolivreCents, point.yhatShopeeCents, point.yhatShopifyCents, point.yhatOtherCents,
        );
      });
      await client.query(`
        INSERT INTO seller.forecast_points(
          tenant_id, run_id, target_date, yhat_cents, yhat_p10_cents, yhat_p50_cents, yhat_p90_cents,
          yhat_nuvemshop_cents, yhat_mercadolivre_cents, yhat_shopee_cents,
          yhat_shopify_cents, yhat_other_cents
        ) VALUES ${placeholders.join(',')}
      `, values);
    }
    await client.query(`
      INSERT INTO seller.forecast_evals(tenant_id, model_version, eval_date, window_days, mae, mape, rmse, details)
      VALUES ($1,$2,current_date,$3,$4,$5,$6,$7::jsonb)
    `, [
      tenantId, result.modelVersion, result.actualVsPredicted.length,
      result.metrics.validation.mae, result.metrics.validation.mape, result.metrics.validation.rmse,
      JSON.stringify({ baseLearners: result.metrics.baseLearners, weights: result.metrics.weights }),
    ]);
    return runId;
  } catch (error) {
    if (isMissingRelation(error)) return `ephemeral-${Date.now()}`;
    throw error;
  }
}

export async function computeForecastOnClient(
  client: PoolClient,
  tenantId: string,
  query: ForecastQuery,
) {
  await rebuildDailyStoreMetrics(client, tenantId).catch(error => {
    if (!isMissingRelation(error)) throw error;
  });
  const series = await loadDailySeries(client, tenantId);
  if (series.length < 45) {
    return {
      status: 'insufficient_history' as const,
      trainDays: series.length,
      message: 'São necessários pelo menos 45 dias de pedidos pagos para a previsão ensemble.',
      history: series,
    };
  }

  const recentSpend = Math.round(
    series.slice(-7).reduce((a, p) => a + p.adsSpendCents, 0) / Math.min(series.length, 7),
  );
  let spend = query.dailyAdsSpendCents ?? recentSpend;
  let scenario = query.scenario;
  if (query.dailyAdsSpendCents != null) {
    if (query.dailyAdsSpendCents > recentSpend * 1.05) scenario = 'ads_up';
    else if (query.dailyAdsSpendCents < recentSpend * 0.95) scenario = 'ads_down';
    else if (query.scenario === 'baseline') scenario = 'custom';
    spend = query.dailyAdsSpendCents;
  }

  const result = runEnsembleForecast(series, query.horizon as 30 | 60 | 90, spend);
  const baseline = rollingBaselineBacktest(series);
  const runId = await persistForecast(
    client, tenantId, query.horizon as 30 | 60 | 90, scenario, spend, result,
  );

  return {
    status: 'ok' as const,
    runId,
    storeId: tenantId,
    horizonDays: query.horizon,
    scenario,
    adsSpendAssumedCents: spend,
    modelVersion: result.modelVersion,
    calculationVersion: result.calculationVersion,
    metrics: result.metrics,
    baselineBacktest: baseline,
    drivers: result.drivers,
    actualVsPredicted: result.actualVsPredicted,
    forecast: result.points,
    history: series.slice(-90),
    caveats: [
      'Previsão estatística com intervalo de confiança; não é garantia de receita.',
      'Efeito de Meta Ads é correlacional (observado), não causal/incremental.',
      'Breakdown por marketplace usa participação média recente.',
    ],
  };
}

export async function computeTenantForecast(
  tenantId: string,
  userId: string,
  query: ForecastQuery,
) {
  return withTenant(tenantId, userId, async client => computeForecastOnClient(client, tenantId, query));
}

export async function readLatestForecast(tenantId: string, userId: string, horizon: 30 | 60 | 90) {
  return withTenant(tenantId, userId, async client => {
    try {
      const run = await client.query(`
        SELECT id, as_of_date::text, horizon_days, scenario, ads_spend_assumed_cents::text,
          model_version, calculation_version, mae::text, mape::text, rmse::text,
          train_days, drivers, metrics, created_at
        FROM seller.forecast_runs
        WHERE tenant_id=$1 AND horizon_days=$2 AND scenario='baseline'
        ORDER BY created_at DESC LIMIT 1
      `, [tenantId, horizon]);
      if (!run.rows[0]) return null;
      const points = await client.query(`
        SELECT target_date::text, yhat_cents::text, yhat_p10_cents::text, yhat_p50_cents::text, yhat_p90_cents::text,
          yhat_nuvemshop_cents::text, yhat_mercadolivre_cents::text, yhat_shopee_cents::text,
          yhat_shopify_cents::text, yhat_other_cents::text
        FROM seller.forecast_points
        WHERE tenant_id=$1 AND run_id=$2
        ORDER BY target_date
      `, [tenantId, run.rows[0].id]);
      const history = await loadDailySeries(client, tenantId);
      return { run: run.rows[0], points: points.rows, history: history.slice(-90) };
    } catch (error) {
      if (isMissingRelation(error)) return null;
      throw error;
    }
  });
}

export async function enqueueForecastOutbox(client: PoolClient, tenantId: string, horizonDays = 30) {
  try {
    await client.query(`
      INSERT INTO seller.forecast_job_outbox(tenant_id, horizon_days)
      VALUES ($1,$2)
    `, [tenantId, horizonDays]);
  } catch (error) {
    if (isMissingRelation(error)) return;
    throw error;
  }
}
