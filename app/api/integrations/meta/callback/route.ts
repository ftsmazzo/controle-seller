import { NextResponse } from 'next/server';
import { finishMetaOAuth, safeMetaError } from '@/src/integrations/meta-store.mjs';
import { ForbiddenError } from '@/src/server/core.mjs';
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
  if (!state || !code || url.searchParams.has('error')) {
    return NextResponse.json({ error: 'Callback OAuth Meta incompleto ou negado.' }, { status: 400 });
  }
  try {
    const result = await finishMetaOAuth(session.activeTenantId, session.userId, state, code);
    const redirect = publicUrl(result.redirectPath, request);
    redirect.searchParams.set('meta', 'select-accounts');
    return NextResponse.redirect(redirect, 303);
  } catch (error) {
    return NextResponse.json(
      { error: safeMetaError(error) },
      { status: error instanceof ForbiddenError ? 403 : 502 },
    );
  }
}
