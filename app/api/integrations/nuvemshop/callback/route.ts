import { NextResponse } from 'next/server';
import { finishNuvemshopOAuth, safeError } from '@/src/integrations/nuvemshop-store.mjs';
import { ForbiddenError } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.redirect(new URL('/login', request.url), 303);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) return NextResponse.json({ error: 'Callback OAuth incompleto.' }, { status: 400 });
  try {
    const result = await finishNuvemshopOAuth(session.activeTenantId, session.userId, state, code);
    const redirect = new URL(result.redirectPath, request.url);
    redirect.searchParams.set('nuvemshop', 'connected');
    return NextResponse.redirect(redirect, 303);
  } catch (error) {
    const status = error instanceof ForbiddenError ? 403 : 502;
    return NextResponse.json({ error: safeError(error) }, { status });
  }
}
