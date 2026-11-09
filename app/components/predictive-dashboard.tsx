'use client';

import { useMemo, useState, useTransition } from 'react';

type HistoryPoint = {
  metricDate: string;
  revenueCents: number;
  adsSpendCents: number;
};

type ForecastPoint = {
  targetDate: string;
  yhatCents: number;
  yhatP10Cents: number;
  yhatP50Cents: number;
  yhatP90Cents: number;
  yhatNuvemshopCents: number;
  yhatMercadolivreCents: number;
  yhatShopeeCents: number;
  yhatShopifyCents: number;
  yhatOtherCents: number;
};

type Driver = { feature: string; impact: number; direction: string };

type Payload = {
  status: string;
  message?: string;
  trainDays?: number;
  horizonDays?: number;
  scenario?: string;
  adsSpendAssumedCents?: number;
  modelVersion?: string;
  metrics?: { validation?: { mae: number; mape: number; rmse: number } };
  baselineBacktest?: {
    seasonalNaive?: { mae: number; mape: number };
    seasonalMovingAverage?: { mae: number; mape: number };
  };
  drivers?: Driver[];
  actualVsPredicted?: Array<{ date: string; actualCents: number; predictedCents: number }>;
  forecast?: ForecastPoint[];
  history?: HistoryPoint[];
  caveats?: string[];
};

const brl = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

const featureLabel: Record<string, string> = {
  revenue_lag_1: 'Receita D-1',
  revenue_lag_7: 'Receita D-7',
  revenue_lag_14: 'Receita D-14',
  revenue_lag_28: 'Receita D-28',
  revenue_ma_7: 'Média 7 dias',
  revenue_ma_28: 'Média 28 dias',
  ads_spend_lag_1: 'Investimento Ads D-1',
  ads_spend_lag_7: 'Investimento Ads D-7',
  ads_spend_ma_7: 'Média Ads 7 dias',
  ads_spend_ma_14: 'Média Ads 14 dias',
  is_black_friday_week: 'Semana Black Friday',
  is_christmas_season: 'Temporada de Natal',
  is_weekend: 'Fim de semana',
  dow: 'Dia da semana',
  month: 'Mês',
  trend_index: 'Tendência',
  share_ml_lag_1: 'Share Mercado Livre',
  share_shopee_lag_1: 'Share Shopee',
  share_nuvemshop_lag_1: 'Share Nuvemshop',
  ads_roas_lag_1: 'ROAS declarado D-1',
  ads_clicks_lag_1: 'Cliques Ads D-1',
  orders_lag_1: 'Pedidos D-1',
  avg_ticket_lag_1: 'Ticket médio D-1',
};

function SparkBars({
  values,
  accent,
}: {
  values: number[];
  accent?: 'actual' | 'pred' | 'band';
}) {
  const max = Math.max(...values, 1);
  return (
    <div className={`spark ${accent ?? ''}`} role="img" aria-label="Série temporal">
      {values.map((value, index) => (
        <i key={index} style={{ height: `${Math.max(4, (value / max) * 100)}%` }} />
      ))}
    </div>
  );
}

export function PredictiveDashboard({ initial }: { initial: Payload }) {
  const [horizon, setHorizon] = useState<30 | 60 | 90>((initial.horizonDays as 30 | 60 | 90) || 30);
  const [adsReais, setAdsReais] = useState(
    Math.round((initial.adsSpendAssumedCents ?? 0) / 100),
  );
  const [data, setData] = useState<Payload>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totalForecast = useMemo(
    () => (data.forecast ?? []).reduce((sum, p) => sum + p.yhatCents, 0),
    [data.forecast],
  );
  const bandLow = useMemo(
    () => (data.forecast ?? []).reduce((sum, p) => sum + p.yhatP10Cents, 0),
    [data.forecast],
  );
  const bandHigh = useMemo(
    () => (data.forecast ?? []).reduce((sum, p) => sum + p.yhatP90Cents, 0),
    [data.forecast],
  );

  function refresh(body: Record<string, unknown>) {
    startTransition(async () => {
      setError(null);
      const response = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error ?? 'Falha ao recalcular.');
        return;
      }
      setData(json);
      if (typeof json.adsSpendAssumedCents === 'number') {
        setAdsReais(Math.round(json.adsSpendAssumedCents / 100));
      }
    });
  }

  function runWhatIf() {
    startTransition(async () => {
      setError(null);
      const response = await fetch('/api/forecast/what-if', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          horizon,
          dailyAdsSpendCents: Math.max(0, Math.round(adsReais * 100)),
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error ?? 'Falha no cenário.');
        return;
      }
      setData(json);
    });
  }

  if (data.status === 'insufficient_history') {
    return (
      <div className="empty">
        <strong>Histórico ainda curto para prever.</strong>
        <p>
          {data.message ?? 'Conecte canais e aguarde mais pedidos pagos.'}
          {' '}
          Dias disponíveis: {data.trainDays ?? 0}/45.
        </p>
      </div>
    );
  }

  const historyValues = (data.history ?? []).map(p => p.revenueCents);
  const forecastValues = (data.forecast ?? []).map(p => p.yhatCents);
  const avpActual = (data.actualVsPredicted ?? []).map(p => p.actualCents);
  const avpPred = (data.actualVsPredicted ?? []).map(p => p.predictedCents);

  return (
    <div className="predictive">
      <section className="metric-grid" aria-label="Resumo da previsão">
        <article className="metric-card accent">
          <span>Receita prevista ({horizon}d)</span>
          <strong>{brl(totalForecast)}</strong>
          <small>Faixa {brl(bandLow)} – {brl(bandHigh)}</small>
        </article>
        <article className="metric-card">
          <span>MAPE validação</span>
          <strong>
            {data.metrics?.validation
              ? `${(data.metrics.validation.mape * 100).toFixed(1)}%`
              : '—'}
          </strong>
          <small>Erro percentual médio no backtest</small>
        </article>
        <article className="metric-card">
          <span>Investimento Ads assumido</span>
          <strong>{brl(data.adsSpendAssumedCents ?? 0)}/dia</strong>
          <small>Cenário {data.scenario ?? 'baseline'}</small>
        </article>
        <article className="metric-card">
          <span>Modelo</span>
          <strong>Ensemble stack</strong>
          <small>{data.modelVersion ?? '—'}</small>
        </article>
      </section>

      <div className="split predictive-controls">
        <section className="ledger">
          <div className="section-title">
            <h3>Horizonte e recálculo</h3>
            <p>Baseline sazonal + ridge de vendas + ridge de ads, combinados por stacking.</p>
          </div>
          <div className="horizon-row" role="group" aria-label="Horizonte">
            {[30, 60, 90].map(days => (
              <button
                key={days}
                type="button"
                className={`button ${horizon === days ? '' : 'secondary'}`}
                disabled={pending}
                onClick={() => {
                  setHorizon(days as 30 | 60 | 90);
                  refresh({ horizon: days, scenario: 'baseline' });
                }}
              >
                {days} dias
              </button>
            ))}
          </div>
          {error && <p className="status bad" role="alert">{error}</p>}
        </section>

        <aside className="action-rail">
          <h3>What-if Meta Ads</h3>
          <p className="muted">Simula investimento diário futuro. Associação observacional, não causal.</p>
          <label>
            R$ / dia
            <input
              type="number"
              min={0}
              step={10}
              value={adsReais}
              onChange={event => setAdsReais(Number(event.target.value))}
            />
          </label>
          <button className="button" type="button" disabled={pending} onClick={runWhatIf}>
            {pending ? 'Calculando…' : 'Simular cenário'}
          </button>
        </aside>
      </div>

      <section className="ledger">
        <div className="section-title">
          <h3>Previsão vs realizado (últimos dias)</h3>
          <p>Prova de confiança do modelo antes de olhar o futuro.</p>
        </div>
        {avpActual.length ? (
          <div className="spark-pair">
            <div>
              <span>Realizado</span>
              <SparkBars values={avpActual} accent="actual" />
            </div>
            <div>
              <span>Previsto</span>
              <SparkBars values={avpPred} accent="pred" />
            </div>
          </div>
        ) : (
          <div className="empty"><p>Sem janela de comparação ainda.</p></div>
        )}
      </section>

      <section className="ledger">
        <div className="section-title">
          <h3>Histórico recente e curva prevista</h3>
          <p>P50 no centro; use a faixa P10–P90 como intervalo de confiança.</p>
        </div>
        <div className="spark-pair">
          <div>
            <span>Histórico 90d</span>
            <SparkBars values={historyValues} />
          </div>
          <div>
            <span>Previsto {horizon}d</span>
            <SparkBars values={forecastValues} accent="band" />
          </div>
        </div>
        <p className="scroll-hint">Deslize horizontalmente para ver todas as colunas.</p>
        <div className="table-scroll" role="region" aria-label="Tabela de previsão" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">P10</th>
                <th scope="col">P50</th>
                <th scope="col">P90</th>
                <th scope="col">ML</th>
                <th scope="col">Shopee</th>
                <th scope="col">Nuvemshop</th>
              </tr>
            </thead>
            <tbody>
              {(data.forecast ?? []).map(point => (
                <tr key={point.targetDate}>
                  <td>{point.targetDate}</td>
                  <td>{brl(point.yhatP10Cents)}</td>
                  <td>{brl(point.yhatP50Cents)}</td>
                  <td>{brl(point.yhatP90Cents)}</td>
                  <td>{brl(point.yhatMercadolivreCents)}</td>
                  <td>{brl(point.yhatShopeeCents)}</td>
                  <td>{brl(point.yhatNuvemshopCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="ledger">
          <div className="section-title">
            <h3>Drivers do modelo</h3>
            <p>Features com maior peso no learner de vendas (ridge).</p>
          </div>
          <ul className="driver-list">
            {(data.drivers ?? []).map(driver => (
              <li key={driver.feature}>
                <span>{featureLabel[driver.feature] ?? driver.feature}</span>
                <b className={driver.direction === 'positive' ? 'status ok' : 'status warn'}>
                  {(driver.impact * 100).toFixed(0)}%
                </b>
              </li>
            ))}
          </ul>
        </section>
        <aside className="coverage-ruler predictive-notes">
          <h3>Qualidade e limites</h3>
          <p>
            Baseline sazonal MAE{' '}
            {data.baselineBacktest?.seasonalMovingAverage
              ? brl(Math.round(data.baselineBacktest.seasonalMovingAverage.mae))
              : '—'}
          </p>
          <ul>
            {(data.caveats ?? []).map(item => <li key={item}>{item}</li>)}
          </ul>
        </aside>
      </div>
    </div>
  );
}
