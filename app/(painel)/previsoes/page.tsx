import { PredictiveDashboard } from '@/app/components/predictive-dashboard';
import { computeTenantForecast, readLatestForecast } from '@/src/server/predictive.mjs';
import { requireReadySession } from '@/src/server/session.mjs';

function mapCachedForecast(cached: NonNullable<Awaited<ReturnType<typeof readLatestForecast>>>) {
  const run = cached.run;
  return {
    status: 'ok' as const,
    source: 'cache' as const,
    runId: String(run.id),
    horizonDays: Number(run.horizon_days),
    scenario: String(run.scenario),
    adsSpendAssumedCents: run.ads_spend_assumed_cents == null ? 0 : Number(run.ads_spend_assumed_cents),
    modelVersion: String(run.model_version),
    calculationVersion: String(run.calculation_version),
    metrics: (run.metrics ?? {}) as {
      validation?: { mae: number; mape: number; rmse: number };
    },
    drivers: Array.isArray(run.drivers) ? run.drivers : [],
    actualVsPredicted: [],
    forecast: cached.points.map(point => ({
      targetDate: String(point.target_date).slice(0, 10),
      yhatCents: Number(point.yhat_cents),
      yhatP10Cents: Number(point.yhat_p10_cents),
      yhatP50Cents: Number(point.yhat_p50_cents),
      yhatP90Cents: Number(point.yhat_p90_cents),
      yhatNuvemshopCents: Number(point.yhat_nuvemshop_cents ?? 0),
      yhatMercadolivreCents: Number(point.yhat_mercadolivre_cents ?? 0),
      yhatShopeeCents: Number(point.yhat_shopee_cents ?? 0),
      yhatShopifyCents: Number(point.yhat_shopify_cents ?? 0),
      yhatOtherCents: Number(point.yhat_other_cents ?? 0),
    })),
    history: cached.history,
    caveats: [
      'Previsão estatística com intervalo de confiança; não é garantia de receita.',
      'Efeito de Meta Ads é correlacional (observado), não causal/incremental.',
      'Breakdown por marketplace usa participação média recente.',
    ],
  };
}

export default async function PrevisoesPage() {
  const session = await requireReadySession();
  const cached = await readLatestForecast(session.activeTenantId, session.userId, 30);
  const initial = cached
    ? mapCachedForecast(cached)
    : await computeTenantForecast(session.activeTenantId, session.userId, {
      horizon: 30,
      scenario: 'baseline',
    });

  return (
    <div className="decision-page">
      <header className="page-head">
        <div>
          <span className="kicker">Dashboard preditiva</span>
          <h2>Próximos meses de vendas</h2>
          <p className="muted">
            Ensemble learning com sazonalidade, canais de marketplace e investimento em Meta Ads.
          </p>
        </div>
      </header>
      <PredictiveDashboard initial={initial} />
    </div>
  );
}
