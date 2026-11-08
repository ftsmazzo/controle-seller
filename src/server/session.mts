import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { databasePool, ensureSafeDatabaseRole, inTransaction, sessionHash, withTenant, type Role } from './core.mts';

export const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'controle_seller_session';
export interface Session {
  id: string;
  userId: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
  activeTenantId: string | null;
}
export async function readSession(raw?: string): Promise<Session | null> {
  const token = raw ?? (await cookies()).get(COOKIE_NAME)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  await ensureSafeDatabaseRole();
  const result = await databasePool().query<{
    id: string; user_id: string; email: string; name: string;
    must_change_password: boolean; active_tenant_id: string | null;
  }>(
    `SELECT s.id, s.user_id, u.email, u.name, u.must_change_password, s.active_tenant_id
     FROM seller.sessions s JOIN seller.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sessionHash(token)],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, userId: row.user_id, email: row.email, name: row.name,
    mustChangePassword: row.must_change_password, activeTenantId: row.active_tenant_id,
  } : null;
}
export async function requireSession(): Promise<Session> {
  const session = await readSession();
  if (!session) redirect('/login');
  return session;
}
export async function requireReadySession(): Promise<Session & { activeTenantId: string }> {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/trocar-senha');
  if (!session.activeTenantId) redirect('/empresas');
  return { ...session, activeTenantId: session.activeTenantId };
}
export async function listTenants(userId: string): Promise<Array<{ id: string; name: string; slug: string; role: Role }>> {
  return inTransaction(async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const result = await client.query<{ id: string; name: string; slug: string; role: Role }>(
      'SELECT * FROM seller.list_user_tenants()',
    );
    return result.rows;
  });
}
export async function activeMembership(session: Session & { activeTenantId: string }) {
  return withTenant(session.activeTenantId, session.userId, async (_client, context) => context);
}
