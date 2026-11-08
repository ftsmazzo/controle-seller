import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import {
  databasePool, ensureSafeDatabaseRole, guardMutation, loginSchema, readLimitedBody,
  requestIp, sessionToken, verifyPassword,
} from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { COOKIE_NAME } from '@/src/server/session.mjs';

export async function POST(request: Request) {
  try { guardMutation(request, `login:${requestIp(request)}`, 20); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  await ensureSafeDatabaseRole();
  let raw: Buffer;
  try { raw = await readLimitedBody(request, 8_192); }
  catch { return NextResponse.json({ error: 'Solicitação acima do limite.' }, { status: 413 }); }
  const contentType = request.headers.get('content-type') ?? '';
  let input: unknown;
  try {
    input = contentType.includes('application/json')
      ? JSON.parse(raw.toString('utf8'))
      : Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } catch {
    return NextResponse.json({ error: 'Credenciais inválidas.' }, { status: 400 });
  }
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: 'Credenciais inválidas.' }, { status: 400 });
  const ipHash = createHash('sha256').update(requestIp(request)).digest();
  const identifierHash = createHash('sha256').update(parsed.data.email).digest();
  const attempt = await databasePool().query<{ attempts:number; blocked:boolean }>(
    `INSERT INTO seller.login_attempts(ip_hash,identifier_hash,attempts,window_started_at,blocked_until,updated_at)
     VALUES($1,$2,1,now(),NULL,now())
     ON CONFLICT (ip_hash,identifier_hash) DO UPDATE SET
       attempts=CASE WHEN seller.login_attempts.window_started_at<now()-interval '15 minutes'
         THEN 1 ELSE seller.login_attempts.attempts+1 END,
       window_started_at=CASE WHEN seller.login_attempts.window_started_at<now()-interval '15 minutes'
         THEN now() ELSE seller.login_attempts.window_started_at END,
       blocked_until=CASE
         WHEN seller.login_attempts.blocked_until>now() THEN seller.login_attempts.blocked_until
         WHEN seller.login_attempts.attempts+1>=10 THEN now()+interval '15 minutes'
         ELSE NULL END,updated_at=now()
     RETURNING attempts,blocked_until>now() blocked`,
    [ipHash, identifierHash],
  );
  const state = attempt.rows[0]!;
  await new Promise(resolve => setTimeout(resolve, Math.min(2_000, Math.max(0, state.attempts - 1) * 150)));
  if (state.blocked) return NextResponse.json({ error: 'Muitas tentativas. Aguarde antes de tentar novamente.' }, { status: 429 });
  const result = await databasePool().query<{
    id: string; password_hash: string; must_change_password: boolean;
  }>('SELECT id, password_hash, must_change_password FROM seller.users WHERE email = $1 AND disabled_at IS NULL', [parsed.data.email]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    return NextResponse.json({ error: 'E-mail ou senha inválidos.' }, { status: 401 });
  }
  const token = sessionToken();
  const ttl = Math.max(1, Number(process.env.SESSION_TTL_HOURS ?? 168));
  await databasePool().query(
    `INSERT INTO seller.sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 hour'))`,
    [user.id, token.hash, ttl],
  );
  await databasePool().query(
    'DELETE FROM seller.login_attempts WHERE ip_hash=$1 AND identifier_hash=$2',
    [ipHash, identifierHash],
  );
  const response = NextResponse.redirect(publicUrl(user.must_change_password ? '/trocar-senha' : '/empresas', request), 303);
  response.cookies.set(COOKIE_NAME, token.raw, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: '/', maxAge: ttl * 3600,
  });
  return response;
}
