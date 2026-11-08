import { NextResponse } from 'next/server';
import { databasePool, guardMutation, sessionHash } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { COOKIE_NAME } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  try { guardMutation(request, 'logout', 30); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const raw = request.headers.get('cookie')?.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`))?.[1];
  if (raw) await databasePool().query('DELETE FROM seller.sessions WHERE token_hash = $1', [sessionHash(decodeURIComponent(raw))]);
  const response = NextResponse.redirect(publicUrl('/login', request), 303);
  response.cookies.set(COOKIE_NAME, '', { httpOnly: true, path: '/', expires: new Date(0) });
  return response;
}
