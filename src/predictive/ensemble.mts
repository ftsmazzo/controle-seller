import {
  FEATURE_NAMES,
  averageChannelShares,
  buildFeatureRows,
  extendSeriesForHorizon,
  type DailyPoint,
  type FeatureRow,
} from './features.mts';
import { summarize } from './metrics.mts';

export interface DriverItem {
  feature: string;
  impact: number;
  direction: 'positive' | 'negative';
}

export interface ForecastPoint {
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
}

export interface EnsembleResult {
  modelVersion: string;
  calculationVersion: 'predictive-ensemble-v1';
  points: ForecastPoint[];
  drivers: DriverItem[];
  metrics: {
    validation: { mae: number; mape: number; rmse: number };
    baseLearners: Record<string, { mae: number; mape: number; rmse: number }>;
    weights: Record<string, number>;
  };
  actualVsPredicted: Array<{ date: string; actualCents: number; predictedCents: number }>;
  trainDays: number;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

/** Ridge regression via normal equations (X'X + λI)β = X'y — closed form. */
function fitRidge(rows: FeatureRow[], lambda = 10): number[] {
  const nFeatures = FEATURE_NAMES.length;
  const xtx: number[][] = Array.from({ length: nFeatures }, () => Array(nFeatures).fill(0));
  const xty = Array(nFeatures).fill(0) as number[];
  for (const row of rows) {
    for (let i = 0; i < nFeatures; i += 1) {
      xty[i]! += row.values[i]! * row.target;
      for (let j = 0; j < nFeatures; j += 1) {
        xtx[i]![j]! += row.values[i]! * row.values[j]!;
      }
    }
  }
  for (let i = 0; i < nFeatures; i += 1) xtx[i]![i]! += lambda;
  return solveLinear(xtx, xty);
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const div = m[col]![col]! || 1e-12;
    for (let c = col; c <= n; c += 1) m[col]![c]! /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      for (let c = col; c <= n; c += 1) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map(row => row[n]!);
}

function predictRidge(weights: number[], values: number[]): number {
  return Math.max(dot(weights, values), 0);
}

function seasonalMaPredict(history: number[], dates: string[], futureDates: string[]): number[] {
  const byDow = new Map<number, number[]>();
  for (let i = 0; i < history.length; i += 1) {
    const dow = new Date(`${dates[i]}T12:00:00`).getUTCDay();
    const bucket = byDow.get(dow) ?? [];
    bucket.push(history[i]!);
    byDow.set(dow, bucket);
  }
  const overall = history.slice(-28);
  const overallMean = overall.reduce((a, b) => a + b, 0) / Math.max(overall.length, 1);
  const recent = history.slice(-28);
  let slope = 0;
  if (recent.length >= 2) {
    const xMean = (recent.length - 1) / 2;
    const yMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < recent.length; i += 1) {
      num += (i - xMean) * (recent[i]! - yMean);
      den += (i - xMean) ** 2;
    }
    slope = den ? num / den : 0;
  }
  return futureDates.map((date, idx) => {
    const dow = new Date(`${date}T12:00:00`).getUTCDay();
    const bucket = byDow.get(dow) ?? [];
    const base = bucket.length
      ? bucket.slice(-8).reduce((a, b) => a + b, 0) / Math.min(bucket.length, 8)
      : overallMean;
    return Math.max(base + slope * (idx + 1), 0);
  });
}

function seasonalNaiveInSample(targets: number[]): number[] {
  return targets.map((value, i) => (i >= 7 ? targets[i - 7]! : Number.NaN));
}

export function rollingBaselineBacktest(series: DailyPoint[], horizon = 28, minTrain = 60) {
  const dates = series.map(p => p.metricDate);
  const y = series.map(p => p.revenueCents);
  const actual: number[] = [];
  const naivePred: number[] = [];
  const smaPred: number[] = [];
  let t = Math.min(minTrain, Math.max(30, Math.floor(series.length / 2)));
  while (t < y.length) {
    const step = Math.min(horizon, y.length - t);
    const trainY = y.slice(0, t);
    const trainDates = dates.slice(0, t);
    const futureDates = dates.slice(t, t + step);
    const actualSlice = y.slice(t, t + step);
    const naive = actualSlice.map((_, i) => trainY[trainY.length - 7 + (i % 7)] ?? trainY[trainY.length - 1]!);
    const sma = seasonalMaPredict(trainY, trainDates, futureDates);
    actual.push(...actualSlice);
    naivePred.push(...naive);
    smaPred.push(...sma);
    t += step;
  }
  return {
    windowDays: actual.length,
    seasonalNaive: summarize(actual, naivePred),
    seasonalMovingAverage: summarize(actual, smaPred),
  };
}

export function runEnsembleForecast(
  series: DailyPoint[],
  horizonDays: 30 | 60 | 90,
  plannedAdsSpendCents?: number,
): EnsembleResult {
  if (series.length < 45) {
    throw new Error('Histórico insuficiente: são necessários pelo menos 45 dias com vendas para prever.');
  }

  const featured = buildFeatureRows(series);
  const split = Math.max(30, Math.floor(featured.length * 0.8));
  const train = featured.slice(0, split);
  const validation = featured.slice(split);
  if (validation.length < 7) {
    throw new Error('Histórico insuficiente para validação temporal do ensemble.');
  }

  const ridgeSales = fitRidge(train, 25);
  const adsHeavy = train.map(row => ({
    ...row,
    values: row.values.map((v, idx) => {
      const name = FEATURE_NAMES[idx]!;
      return name.startsWith('ads_') ? v * 1.35 : v;
    }),
  }));
  const ridgeAds = fitRidge(adsHeavy, 8);

  const trainDates = series.slice(0, series.length - validation.length).map(p => p.metricDate);
  const trainRevenue = series.slice(0, series.length - validation.length).map(p => p.revenueCents);
  const valDates = validation.map(r => r.date);
  const pSmaVal = seasonalMaPredict(trainRevenue, trainDates, valDates);
  const pSalesVal = validation.map(r => predictRidge(ridgeSales, r.values));
  const pAdsVal = validation.map(r => predictRidge(ridgeAds, r.values));
  const yVal = validation.map(r => r.target);

  const mSma = summarize(yVal, pSmaVal);
  const mSales = summarize(yVal, pSalesVal);
  const mAds = summarize(yVal, pAdsVal);
  const inv = [
    1 / Math.max(mSma.mae, 1),
    1 / Math.max(mSales.mae, 1),
    1 / Math.max(mAds.mae, 1),
  ];
  const invSum = inv[0]! + inv[1]! + inv[2]!;
  const weights = {
    seasonal_ma: inv[0]! / invSum,
    ridge_sales: inv[1]! / invSum,
    ridge_ads: inv[2]! / invSum,
  };

  const stackedVal = yVal.map((_, i) => (
    weights.seasonal_ma * pSmaVal[i]!
    + weights.ridge_sales * pSalesVal[i]!
    + weights.ridge_ads * pAdsVal[i]!
  ));
  const validationMetrics = summarize(yVal, stackedVal);

  const recentSpend = Math.round(
    series.slice(-7).reduce((a, p) => a + p.adsSpendCents, 0) / Math.min(series.length, 7),
  );
  const spend = plannedAdsSpendCents ?? recentSpend;
  const { futureDates, working } = extendSeriesForHorizon(series, horizonDays, spend);
  const shares = averageChannelShares(series);
  const points: ForecastPoint[] = [];

  for (let step = 0; step < horizonDays; step += 1) {
    const upto = series.length + step + 1;
    const slice = working.slice(0, upto);
    const rows = buildFeatureRows(slice);
    const lastRow = rows[rows.length - 1]!;
    const histDates = slice.slice(0, -1).map(p => p.metricDate);
    const histRevenue = slice.slice(0, -1).map(p => p.revenueCents);
    const pSma = seasonalMaPredict(histRevenue, histDates, [futureDates[step]!])[0]!;
    const pSales = predictRidge(ridgeSales, lastRow.values);
    const pAds = predictRidge(ridgeAds, lastRow.values);
    const yhat = Math.round(
      weights.seasonal_ma * pSma
      + weights.ridge_sales * pSales
      + weights.ridge_ads * pAds,
    );
    const sigma = validationMetrics.mae;
    const p10 = Math.max(Math.round(yhat - 1.28 * sigma), 0);
    const p90 = Math.round(yhat + 1.28 * sigma);
    points.push({
      targetDate: futureDates[step]!,
      yhatCents: yhat,
      yhatP10Cents: p10,
      yhatP50Cents: yhat,
      yhatP90Cents: p90,
      yhatNuvemshopCents: Math.round(yhat * shares.nuvemshop),
      yhatMercadolivreCents: Math.round(yhat * shares.mercadolivre),
      yhatShopeeCents: Math.round(yhat * shares.shopee),
      yhatShopifyCents: Math.round(yhat * shares.shopify),
      yhatOtherCents: Math.round(yhat * shares.other),
    });
    working[series.length + step]!.revenueCents = yhat;
    working[series.length + step]!.revenueNuvemshopCents = Math.round(yhat * shares.nuvemshop);
    working[series.length + step]!.revenueMercadolivreCents = Math.round(yhat * shares.mercadolivre);
    working[series.length + step]!.revenueShopeeCents = Math.round(yhat * shares.shopee);
    working[series.length + step]!.revenueShopifyCents = Math.round(yhat * shares.shopify);
    working[series.length + step]!.revenueOtherCents = Math.round(yhat * shares.other);
  }

  const absCoef = ridgeSales.map((w, i) => ({ feature: FEATURE_NAMES[i]!, impact: Math.abs(w), raw: w }));
  absCoef.sort((a, b) => b.impact - a.impact);
  const maxImpact = absCoef[0]?.impact || 1;
  const drivers: DriverItem[] = absCoef.slice(0, 8).map(item => ({
    feature: item.feature,
    impact: Number((item.impact / maxImpact).toFixed(4)),
    direction: item.raw >= 0 ? 'positive' : 'negative',
  }));

  const backWindow = Math.min(30, validation.length);
  const actualVsPredicted = validation.slice(-backWindow).map((row, i) => {
    const idx = validation.length - backWindow + i;
    return {
      date: row.date,
      actualCents: row.target,
      predictedCents: Math.round(stackedVal[idx]!),
    };
  });

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return {
    modelVersion: `ensemble_stack_v1_${stamp}`,
    calculationVersion: 'predictive-ensemble-v1',
    points,
    drivers,
    metrics: {
      validation: validationMetrics,
      baseLearners: {
        seasonal_ma: mSma,
        ridge_sales: mSales,
        ridge_ads: mAds,
      },
      weights,
    },
    actualVsPredicted,
    trainDays: series.length,
  };
}

export function baselineInSampleError(series: DailyPoint[]) {
  const y = series.map(p => p.revenueCents);
  const naive = seasonalNaiveInSample(y).filter(v => Number.isFinite(v));
  const actual = y.slice(7);
  return summarize(actual, naive as number[]);
}
