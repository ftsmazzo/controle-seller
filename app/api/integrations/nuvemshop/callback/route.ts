import { NextResponse } from 'next/server';
import { finishNuvemshopOAuth, safeError } from '@/src/integrations/nuvemshop-store.mjs';
import { ForbiddenError } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.redirect(publicUrl('/login', request), 303);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) return NextResponse.json({ error: 'Callback OAuth incompleto.' }, { status: 400 });
  try {
    const result = await finishNuvemshopOAuth(session.activeTenantId, session.userId, state, code);
    const redirect = publicUrl(result.redirectPath, request);
    redirect.searchParams.set('nuvemshop', 'connected');
    return NextResponse.redirect(redirect, 303);
  } catch (error) {
    const status = error instanceof ForbiddenError ? 403 : 502;
    return NextResponse.json({ error: safeError(error) }, { status });
  }
}
