import { NextResponse } from 'next/server';
import { beginMercadoLivreOAuth } from '@/src/integrations/marketplace-connect.mjs';
import { guardMutation } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `ml-start:${session.userId}`, 10); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  try {
    const url = await beginMercadoLivreOAuth(session.activeTenantId, session.userId);
    return NextResponse.redirect(url, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao iniciar Mercado Livre.';
    return NextResponse.redirect(publicUrl(`/configuracoes?error=${encodeURIComponent(message)}`, request), 303);
  }
}
