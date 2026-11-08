import { NextResponse } from 'next/server';
import { disconnectMeta, safeMetaError } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `meta-disconnect:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const form = await readLimitedFormData(request);
  const integrationId = form.get('integrationId');
  if (typeof integrationId !== 'string') {
    return NextResponse.json({ error: 'Integração inválida.' }, { status: 400 });
  }
  try {
    await disconnectMeta(session.activeTenantId, session.userId, integrationId);
    return NextResponse.redirect(publicUrl('/configuracoes?meta=disconnected', request), 303);
  } catch (error) {
    return NextResponse.json(
      { error: safeMetaError(error) },
      { status: error instanceof ForbiddenError ? 403 : 502 },
    );
  }
}
