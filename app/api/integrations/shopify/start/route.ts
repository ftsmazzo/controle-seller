import { NextResponse } from 'next/server';
import { beginShopifyOAuth } from '@/src/integrations/marketplace-connect.mjs';
import { ForbiddenError, guardMutation, readLimitedFormData } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `shopify-start:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  try {
    const form = await readLimitedFormData(request);
    const url = await beginShopifyOAuth(
      session.activeTenantId, session.userId, String(form.get('shop') ?? ''),
    );
    return NextResponse.redirect(url, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao iniciar Shopify.';
    if (error instanceof ForbiddenError) {
      return NextResponse.redirect(publicUrl(`/configuracoes?error=${encodeURIComponent(message)}`, request), 303);
    }
    return NextResponse.redirect(publicUrl(`/configuracoes?error=${encodeURIComponent(message)}`, request), 303);
  }
}
