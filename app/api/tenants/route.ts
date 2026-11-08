import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { audit, guardMutation, inTransaction, readLimitedFormData, tenantSchema, withTenant } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

function slugify(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'empresa';
}
export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.mustChangePassword) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try { guardMutation(request, `tenants:${session.userId}`, 15); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const form = await readLimitedFormData(request);
  const selectedTenant = String(form.get('tenantId') ?? '');
  if (selectedTenant) {
    await withTenant(selectedTenant, session.userId, async client => {
      await client.query('UPDATE seller.sessions SET active_tenant_id = $1 WHERE id = $2 AND user_id = $3', [selectedTenant, session.id, session.userId]);
    });
    return NextResponse.redirect(publicUrl('/dashboard', request), 303);
  }
  const parsed = tenantSchema.safeParse({ name: form.get('name') });
  if (!parsed.success) return NextResponse.json({ error: 'Nome de empresa inválido.' }, { status: 400 });
  const tenantId = randomUUID();
  const slug = `${slugify(parsed.data.name)}-${tenantId.slice(0, 8)}`;
  await inTransaction(async client => {
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenantId, session.userId]);
    await client.query('INSERT INTO seller.tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, parsed.data.name, slug]);
    await client.query('INSERT INTO seller.memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [tenantId, session.userId, 'owner']);
    await client.query('UPDATE seller.sessions SET active_tenant_id = $1 WHERE id = $2 AND user_id = $3', [tenantId, session.id, session.userId]);
    await audit(client, { tenantId, userId: session.userId, role: 'owner' }, 'tenant.created', 'tenant', tenantId);
  });
  return NextResponse.redirect(publicUrl('/dashboard', request), 303);
}
