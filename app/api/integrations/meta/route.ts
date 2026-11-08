import { NextResponse } from 'next/server';
import { getMetaMetricSummary, getMetaStatus, safeMetaError } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET() {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try {
    const [status, metrics] = await Promise.all([
      getMetaStatus(session.activeTenantId, session.userId),
      getMetaMetricSummary(session.activeTenantId, session.userId),
    ]);
    return NextResponse.json({ data: {
      status,
      metrics: metrics.map(metric => ({
        ...metric,
        spendCents: metric.spendCents.toString(),
        declaredRevenueCents: metric.declaredRevenueCents.toString(),
        attributedNetRevenueCents: metric.attributedNetRevenueCents.toString(),
        attributedMarginAfterMediaCents: metric.attributedMarginAfterMediaCents?.toString() ?? null,
      })),
    } });
  } catch (error) {
    return NextResponse.json(
      { error: safeMetaError(error) },
      { status: error instanceof ForbiddenError ? 403 : 500 },
    );
  }
}
