import { NextResponse } from 'next/server';
import { assertPermission, audit, guardMutation, productSchema, readLimitedJson, withTenant } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET() {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const products = await withTenant(session.activeTenantId, session.userId, async (client, context) => {
    assertPermission(context.role, 'catalog:read');
    const result = await client.query(
      `SELECT p.id, p.name, v.id AS variant_id, v.sku
       FROM seller.products p LEFT JOIN seller.variants v
       ON v.tenant_id = p.tenant_id AND v.product_id = p.id
       WHERE p.archived_at IS NULL ORDER BY p.name`,
    );
    return result.rows;
  });
  return NextResponse.json({ data: products });
}
export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  try { guardMutation(request, `catalog:${session.userId}`, 20); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }
  const parsed = productSchema.safeParse(await readLimitedJson(request).catch(()=>null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const created = await withTenant(session.activeTenantId, session.userId, async (client, context) => {
    assertPermission(context.role, 'catalog:write');
    const product = await client.query<{ id: string }>(
      'INSERT INTO seller.products (tenant_id, name) VALUES ($1,$2) RETURNING id',
      [context.tenantId, parsed.data.name],
    );
    const productId = product.rows[0]!.id;
    const variant = await client.query<{ id: string }>(
      'INSERT INTO seller.variants (tenant_id, product_id, sku) VALUES ($1,$2,$3) RETURNING id',
      [context.tenantId, productId, parsed.data.sku],
    );
    await audit(client, context, 'catalog.product_created', 'product', productId, { sku: parsed.data.sku });
    return { id: productId, variantId: variant.rows[0]!.id };
  });
  return NextResponse.json({ data: created }, { status: 201 });
}
