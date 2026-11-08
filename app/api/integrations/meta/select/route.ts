import { NextResponse } from 'next/server';
import { safeMetaError, selectMetaAccounts } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `meta-select:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const form = await readLimitedFormData(request);
  const integrationId = form.get('integrationId');
  const accountIds = form.getAll('accountIds').map(String);
  if (typeof integrationId !== 'string') {
    return NextResponse.json({ error: 'Integração inválida.' }, { status: 400 });
  }
  try {
    await selectMetaAccounts(session.activeTenantId, session.userId, integrationId, accountIds);
    return NextResponse.redirect(new URL('/configuracoes?meta=connected', request.url), 303);
  } catch (error) {
    return NextResponse.json(
      { error: safeMetaError(error) },
      { status: error instanceof ForbiddenError ? 403 : 400 },
    );
  }
}
