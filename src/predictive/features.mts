export interface DailyPoint {
  metricDate: string; // YYYY-MM-DD
  revenueCents: number;
  ordersCount: number;
  avgTicketCents: number;
  revenueNuvemshopCents: number;
  revenueMercadolivreCents: number;
  revenueShopeeCents: number;
  revenueShopifyCents: number;
  revenueOtherCents: number;
  adsSpendCents: number;
  adsImpressions: number;
  adsClicks: number;
  adsDeclaredPurchaseCents: number;
}

export interface FeatureRow {
  date: string;
  target: number;
  values: number[];
}

export const FEATURE_NAMES = [
  'dow', 'dom', 'month', 'is_weekend', 'is_holiday_approx',
  'is_black_friday_week', 'is_christmas_season',
  'revenue_lag_1', 'revenue_lag_7', 'revenue_lag_14', 'revenue_lag_28',
  'revenue_ma_7', 'revenue_ma_28',
  'orders_lag_1', 'avg_ticket_lag_1',
  'share_ml_lag_1', 'share_shopee_lag_1', 'share_nuvemshop_lag_1',
  'ads_spend_lag_1', 'ads_spend_lag_7', 'ads_spend_ma_7', 'ads_spend_ma_14',
  'ads_clicks_lag_1', 'ads_roas_lag_1', 'trend_index',
] as const;

const BR_FIXED = new Set([
  '01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25',
]);

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function isBlackFridayWeek(d: Date): number {
  if (d.getUTCMonth() !== 10) return 0;
  const last = new Date(Date.UTC(d.getUTCFullYear(), 10, 30));
  while (last.getUTCDay() !== 5) last.setUTCDate(last.getUTCDate() - 1);
  return Math.abs((d.getTime() - last.getTime()) / 86400000) <= 3 ? 1 : 0;
}

function channelShares(point: DailyPoint) {
  const total = Math.max(point.revenueCents, 1);
  return {
    ml: point.revenueMercadolivreCents / total,
    shopee: point.revenueShopeeCents / total,
    nuvemshop: point.revenueNuvemshopCents / total,
  };
}

/** Features point-in-time: só usam informação até t-1 para prever revenue em t. */
export function buildFeatureRows(series: DailyPoint[]): FeatureRow[] {
  const rows: FeatureRow[] = [];
  for (let i = 0; i < series.length; i += 1) {
    if (i < 28) continue;
    const point = series[i]!;
    const d = parseDate(point.metricDate);
    const lag = (n: number) => series[i - n]!;
    const window = (n: number) => series.slice(Math.max(0, i - n), i).map(p => p.revenueCents);
    const adsWindow = (n: number) => series.slice(Math.max(0, i - n), i).map(p => p.adsSpendCents);
    const prev = lag(1);
    const shares = channelShares(prev);
    const prevRoas = prev.adsSpendCents > 0
      ? prev.adsDeclaredPurchaseCents / prev.adsSpendCents
      : 0;
    const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    rows.push({
      date: point.metricDate,
      target: point.revenueCents,
      values: [
        d.getUTCDay(),
        d.getUTCDate(),
        d.getUTCMonth() + 1,
        d.getUTCDay() >= 5 ? 1 : 0,
        BR_FIXED.has(mmdd) ? 1 : 0,
        isBlackFridayWeek(d),
        d.getUTCMonth() === 11 ? 1 : 0,
        lag(1).revenueCents,
        lag(7).revenueCents,
        lag(14).revenueCents,
        lag(28).revenueCents,
        mean(window(7)),
        mean(window(28)),
        lag(1).ordersCount,
        lag(1).avgTicketCents,
        shares.ml,
        shares.shopee,
        shares.nuvemshop,
        lag(1).adsSpendCents,
        lag(7).adsSpendCents,
        mean(adsWindow(7)),
        mean(adsWindow(14)),
        lag(1).adsClicks,
        prevRoas,
        i,
      ],
    });
  }
  return rows;
}

export function extendSeriesForHorizon(
  series: DailyPoint[],
  horizon: number,
  plannedAdsSpendCents: number,
): { futureDates: string[]; working: DailyPoint[] } {
  const working = series.map(p => ({ ...p }));
  const last = parseDate(working[working.length - 1]!.metricDate);
  const futureDates: string[] = [];
  for (let i = 1; i <= horizon; i += 1) {
    const next = new Date(last);
    next.setUTCDate(last.getUTCDate() + i);
    const date = iso(next);
    futureDates.push(date);
    const tail = working.slice(-7);
    working.push({
      metricDate: date,
      revenueCents: mean(tail.map(p => p.revenueCents)),
      ordersCount: Math.round(mean(tail.map(p => p.ordersCount))),
      avgTicketCents: Math.round(mean(tail.map(p => p.avgTicketCents))),
      revenueNuvemshopCents: 0,
      revenueMercadolivreCents: 0,
      revenueShopeeCents: 0,
      revenueShopifyCents: 0,
      revenueOtherCents: 0,
      adsSpendCents: plannedAdsSpendCents,
      adsImpressions: Math.round(mean(tail.map(p => p.adsImpressions))),
      adsClicks: Math.round(mean(tail.map(p => p.adsClicks))),
      adsDeclaredPurchaseCents: Math.round(mean(tail.map(p => p.adsDeclaredPurchaseCents))),
    });
  }
  return { futureDates, working };
}

export function averageChannelShares(series: DailyPoint[]) {
  const tail = series.slice(-28);
  const totals = {
    nuvemshop: 0, mercadolivre: 0, shopee: 0, shopify: 0, other: 0, all: 0,
  };
  for (const p of tail) {
    totals.nuvemshop += p.revenueNuvemshopCents;
    totals.mercadolivre += p.revenueMercadolivreCents;
    totals.shopee += p.revenueShopeeCents;
    totals.shopify += p.revenueShopifyCents;
    totals.other += p.revenueOtherCents;
    totals.all += p.revenueCents;
  }
  const den = Math.max(totals.all, 1);
  return {
    nuvemshop: totals.nuvemshop / den,
    mercadolivre: totals.mercadolivre / den,
    shopee: totals.shopee / den,
    shopify: totals.shopify / den,
    other: totals.other / den,
  };
}
