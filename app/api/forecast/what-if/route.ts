import { NextResponse } from 'next/server';
import { assertPermission, guardMutation, withTenant } from '@/src/server/core.mjs';
import { computeTenantForecast, forecastQuerySchema } from '@/src/server/predictive.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try {
    guardMutation(request, `forecast-whatif:${session.userId}`, 8);
    const body = await request.json().catch(() => ({}));
    const parsed = forecastQuerySchema.safeParse({
      horizon: body.horizon ?? 30,
      scenario: 'custom',
      dailyAdsSpendCents: body.dailyAdsSpendCents,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.dailyAdsSpendCents == null) {
      return NextResponse.json({ error: 'dailyAdsSpendCents é obrigatório.' }, { status: 400 });
    }
    await withTenant(session.activeTenantId, session.userId, async (_client, ctx) => {
      assertPermission(ctx.role, 'finance:read');
      if (ctx.role === 'viewer') throw new Error('Viewer não pode simular cenários de previsão.');
    });
    const result = await computeTenantForecast(session.activeTenantId, session.userId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha no cenário what-if.' },
      { status: 403 },
    );
  }
}
