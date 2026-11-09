import { describe, expect, it } from 'vitest';
import { runEnsembleForecast, rollingBaselineBacktest } from '../src/predictive/ensemble.mts';
import { buildFeatureRows, type DailyPoint } from '../src/predictive/features.mts';
import { mae, mape, summarize } from '../src/predictive/metrics.mts';

function makeSeries(days = 120): DailyPoint[] {
  const start = new Date('2025-01-01T12:00:00Z');
  const rows: DailyPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const weekend = d.getUTCDay() >= 5 ? 1.2 : 1;
    const season = 1 + 0.15 * Math.sin((2 * Math.PI * i) / 365);
    const spend = 15000 + Math.round(3000 * Math.sin(i / 9));
    const revenue = Math.round((320000 * season * weekend) + spend * 2.2 + ((i % 11) * 900));
    rows.push({
      metricDate: d.toISOString().slice(0, 10),
      revenueCents: revenue,
      ordersCount: Math.max(1, Math.round(revenue / 12000)),
      avgTicketCents: 12000,
      revenueNuvemshopCents: Math.round(revenue * 0.2),
      revenueMercadolivreCents: Math.round(revenue * 0.45),
      revenueShopeeCents: Math.round(revenue * 0.25),
      revenueShopifyCents: Math.round(revenue * 0.05),
      revenueOtherCents: Math.round(revenue * 0.05),
      adsSpendCents: spend,
      adsImpressions: spend * 20,
      adsClicks: Math.round(spend / 150),
      adsDeclaredPurchaseCents: Math.round(spend * 2.5),
    });
  }
  return rows;
}

describe('métricas de forecasting', () => {
  it('calcula mae/mape/rmse', () => {
    expect(mae([100, 200], [110, 180])).toBe(15);
    expect(mape([100, 200], [110, 180])).toBeCloseTo(0.1, 5);
    expect(summarize([100], [100])).toEqual({ mae: 0, mape: 0, rmse: 0 });
  });
});

describe('features point-in-time', () => {
  it('só gera linhas após lag 28 e não usa o próprio alvo como feature de lag 0', () => {
    const series = makeSeries(40);
    const rows = buildFeatureRows(series);
    expect(rows.length).toBe(12);
    expect(rows[0]?.values[7]).toBe(series[27]!.revenueCents); // revenue_lag_1
    expect(rows[0]?.target).toBe(series[28]!.revenueCents);
  });
});

describe('ensemble preditivo', () => {
  it('gera horizonte 30 com banda e drivers', () => {
    const series = makeSeries(150);
    const result = runEnsembleForecast(series, 30);
    expect(result.points).toHaveLength(30);
    expect(result.points[0]!.yhatP10Cents).toBeLessThanOrEqual(result.points[0]!.yhatP50Cents);
    expect(result.points[0]!.yhatP90Cents).toBeGreaterThanOrEqual(result.points[0]!.yhatP50Cents);
    expect(result.drivers.length).toBeGreaterThan(0);
    const { seasonal_ma: wSma, ridge_sales: wSales, ridge_ads: wAds } = result.metrics.weights;
    expect((wSma ?? 0) + (wSales ?? 0) + (wAds ?? 0)).toBeCloseTo(1, 5);
  });

  it('what-if com mais ads altera a curva', () => {
    const series = makeSeries(150);
    const base = runEnsembleForecast(series, 30);
    const boosted = runEnsembleForecast(series, 30, 80_000);
    const sum = (points: typeof base.points) => points.reduce((a, p) => a + p.yhatCents, 0);
    expect(sum(boosted.points)).not.toBe(sum(base.points));
  });

  it('baseline backtest retorna métricas', () => {
    const series = makeSeries(120);
    const backtest = rollingBaselineBacktest(series, 14, 40);
    expect(backtest.windowDays).toBeGreaterThan(0);
    expect(backtest.seasonalMovingAverage.mae).toBeGreaterThan(0);
  });

  it('recusa histórico curto', () => {
    expect(() => runEnsembleForecast(makeSeries(20), 30)).toThrow(/45 dias/);
  });
});
