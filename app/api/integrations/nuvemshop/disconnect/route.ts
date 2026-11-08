import { NextResponse } from 'next/server';
import { disconnectNuvemshop, safeError } from '@/src/integrations/nuvemshop-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try { guardMutation(request, `nuvemshop-disconnect:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const form = await readLimitedFormData(request);
  const integrationId = form.get('integrationId');
  if (typeof integrationId !== 'string') return NextResponse.json({ error: 'Integração inválida.' }, { status: 400 });
  try {
    await disconnectNuvemshop(session.activeTenantId, session.userId, integrationId);
    return NextResponse.redirect(publicUrl('/configuracoes?nuvemshop=disconnected', request), 303);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: error instanceof ForbiddenError ? 403 : 502 });
  }
}
