import { NextResponse } from 'next/server';
import { beginMetaOAuth } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
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
    const message = error instanceof ForbiddenError || error instanceof Error
      ? error.message
      : 'Falha ao iniciar Meta Ads.';
    return NextResponse.redirect(
      publicUrl(`/configuracoes?error=${encodeURIComponent(message)}`, request),
      303,
    );
  }
}
