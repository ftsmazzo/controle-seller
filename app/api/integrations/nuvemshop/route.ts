import { NextResponse } from 'next/server';
import { disconnectNuvemshop, getNuvemshopStatus, safeError } from '@/src/integrations/nuvemshop-store.mjs';
import { ForbiddenError, guardMutation, readLimitedJson } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

async function readySession() {
  const session = await readSession();
  return session?.activeTenantId && !session.mustChangePassword ? session : null;
}
export async function GET() {
  const session = await readySession();
  if (!session?.activeTenantId) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try {
    return NextResponse.json({ data: await getNuvemshopStatus(session.activeTenantId, session.userId) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: error instanceof ForbiddenError ? 403 : 500 });
  }
}
export async function DELETE(request: Request) {
  const session = await readySession();
  if (!session?.activeTenantId) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try { guardMutation(request, `nuvemshop-delete:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const body = await readLimitedJson(request).catch(() => null) as { integrationId?: unknown } | null;
  if (typeof body?.integrationId !== 'string') return NextResponse.json({ error: 'integrationId inválido.' }, { status: 400 });
  try {
    await disconnectNuvemshop(session.activeTenantId, session.userId, body.integrationId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: error instanceof ForbiddenError ? 403 : 502 });
  }
}
