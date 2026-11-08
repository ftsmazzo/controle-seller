import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyWebhookHmac } from '@/src/integrations/nuvemshop.mjs';
import { databasePool, readLimitedBody } from '@/src/server/core.mjs';
import { enqueueNuvemshop } from '@/src/server/queue.mjs';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  let raw: Buffer;
  try { raw = await readLimitedBody(request, 1_000_000); }
  catch { return NextResponse.json({ error: 'Payload excede 1 MB.' }, { status: 413 }); }
  if (!verifyWebhookHmac(raw, request.headers.get('x-linkedstore-hmac-sha256'))) {
    return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const hook = new URL(request.url).searchParams.get('hook');
  if (!hook || !/^[A-Za-z0-9_-]{40,60}$/.test(hook)) return NextResponse.json({ error: 'Webhook desconhecido.' }, { status: 404 });
  const tokenHash = createHash('sha256').update(hook).digest();
  const eventId = createHash('sha256').update(hook).update('\0').update(raw).digest('hex');
  const safeHeaders = Object.fromEntries(
    [...request.headers.entries()].filter(([key]) => !['authorization', 'cookie', 'x-linkedstore-hmac-sha256'].includes(key.toLowerCase())),
  );
  const result = await databasePool().query<{
    tenant_id:string; integration_id:string; inbox_id:string; inserted:boolean; enqueued_at:Date|null;
  }>(
    `SELECT * FROM seller.ingest_nuvemshop_webhook($1,$2,$3,$4,$5)`,
    [tokenHash, eventId, safeHeaders, payload, raw],
  );
  const row = result.rows[0];
  if (row && !row.enqueued_at) {
    await enqueueNuvemshop(
      { tenantId: row.tenant_id, integrationId: row.integration_id, resource: 'webhook', mode: 'webhook', inboxId: row.inbox_id },
    );
    await databasePool().query(
      `SELECT seller.mark_nuvemshop_webhook_enqueued($1,$2)`,
      [row.tenant_id,row.inbox_id],
    );
  }
  return NextResponse.json({ accepted: true }, { status: 202 });
}
