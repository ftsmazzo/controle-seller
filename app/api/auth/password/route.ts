import { NextResponse } from 'next/server';
import {
  guardMutation, hashPassword, inTransaction, passwordSchema, readLimitedBody, sessionToken,
} from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { COOKIE_NAME, readSession } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'Sessão expirada.' }, { status: 401 });
  if (!session.mustChangePassword) {
    return NextResponse.json({ error: 'Troca obrigatória já concluída.' }, { status: 403 });
  }
  try { guardMutation(request, `password:${session.userId}`, 5); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  let raw: Buffer;
  try { raw = await readLimitedBody(request, 8_192); }
  catch { return NextResponse.json({ error: 'Solicitação acima do limite.' }, { status: 413 }); }
  const parsed = passwordSchema.safeParse(new URLSearchParams(raw.toString('utf8')).get('password'));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const token = sessionToken();
  const ttl = Math.max(1, Number(process.env.SESSION_TTL_HOURS ?? 168));
  await inTransaction(async client => {
    await client.query(
      'UPDATE seller.users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2',
      [await hashPassword(parsed.data), session.userId],
    );
    await client.query('DELETE FROM seller.sessions WHERE user_id=$1', [session.userId]);
    await client.query(
      `INSERT INTO seller.sessions(user_id,token_hash,active_tenant_id,expires_at)
       VALUES($1,$2,$3,now()+($4*interval '1 hour'))`,
      [session.userId, token.hash, session.activeTenantId, ttl],
    );
  });
  const response = NextResponse.redirect(publicUrl('/empresas', request), 303);
  response.cookies.set(COOKIE_NAME, token.raw, {
    httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', path:'/', maxAge:ttl*3600,
  });
  return response;
}
