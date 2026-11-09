import { NextResponse } from 'next/server';
import { assertPermission, guardMutation } from '@/src/server/core.mjs';
import { computeTenantForecast, forecastQuerySchema, readLatestForecast } from '@/src/server/predictive.mjs';
import { withTenant } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = forecastQuerySchema.safeParse({
    horizon: url.searchParams.get('horizon') ?? '30',
    scenario: url.searchParams.get('scenario') ?? 'baseline',
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await withTenant(session.activeTenantId, session.userId, async (_client, ctx) => {
      assertPermission(ctx.role, 'finance:read');
    });
    const cached = await readLatestForecast(
      session.activeTenantId,
      session.userId,
      parsed.data.horizon as 30 | 60 | 90,
    );
    if (cached) {
      const run = cached.run;
      return NextResponse.json({
        status: 'ok',
        source: 'cache',
        runId: run.id,
        horizonDays: Number(run.horizon_days),
        scenario: run.scenario,
        adsSpendAssumedCents: run.ads_spend_assumed_cents == null ? 0 : Number(run.ads_spend_assumed_cents),
        modelVersion: run.model_version,
        calculationVersion: run.calculation_version,
        metrics: run.metrics ?? {},
        drivers: Array.isArray(run.drivers) ? run.drivers : [],
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
      });
    }
    const fresh = await computeTenantForecast(session.activeTenantId, session.userId, parsed.data);
    return NextResponse.json(fresh);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao carregar previsão.' },
      { status: 403 },
    );
  }
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try {
    guardMutation(request, `forecast:${session.userId}`, 6);
    const body = await request.json().catch(() => ({}));
    const parsed = forecastQuerySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await withTenant(session.activeTenantId, session.userId, async (_client, ctx) => {
      assertPermission(ctx.role, 'finance:read');
      if (ctx.role === 'viewer') throw new Error('Viewer não pode recalcular previsões.');
    });
    const result = await computeTenantForecast(session.activeTenantId, session.userId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao calcular previsão.' },
      { status: 403 },
    );
  }
}
