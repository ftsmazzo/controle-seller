import { NextResponse } from 'next/server';
import { beginNuvemshopOAuth } from '@/src/integrations/nuvemshop-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try { guardMutation(request, `nuvemshop-start:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  try {
    const form = await readLimitedFormData(request);
    const url = await beginNuvemshopOAuth(session.activeTenantId, session.userId, String(form.get('redirect') ?? '/configuracoes'));
    return NextResponse.redirect(url, 303);
  } catch (error) {
    if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
