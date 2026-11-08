import { NextResponse } from 'next/server';
import { beginMetaOAuth, safeMetaError } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `meta-start:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  try {
    const form = await readLimitedFormData(request);
    const target = await beginMetaOAuth(
      session.activeTenantId, session.userId, String(form.get('redirect') ?? '/configuracoes'),
    );
    return NextResponse.redirect(target, 303);
  } catch (error) {
    return NextResponse.json(
      { error: safeMetaError(error) },
      { status: error instanceof ForbiddenError ? 403 : 500 },
    );
  }
}
