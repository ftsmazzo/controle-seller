import { NextResponse } from 'next/server';
import { finishShopifyOAuth } from '@/src/integrations/marketplace-connect.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.redirect(publicUrl('/login', request), 303);
  }
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const shop = url.searchParams.get('shop');
  if (!state || !code || !shop) {
    return NextResponse.redirect(publicUrl('/configuracoes?error=Callback%20Shopify%20incompleto', request), 303);
  }
  try {
    const result = await finishShopifyOAuth(session.activeTenantId, session.userId, state, code, shop);
    return NextResponse.redirect(publicUrl(result.redirectPath, request), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha no callback Shopify.';
    return NextResponse.redirect(publicUrl(`/configuracoes?error=${encodeURIComponent(message)}`, request), 303);
  }
}
