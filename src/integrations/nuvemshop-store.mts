import type { Pool, PoolClient } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  audit, decryptCredential, encryptCredential, ForbiddenError, redactSecrets, withTenant, type Queryable, type Role,
} from '@/src/server/core.mjs';
import { enqueueNuvemshop, type NuvemshopJob } from '@/src/server/queue.mjs';
import {
  authorizationUrl, createOAuthState, exchangeAuthorizationCode, mapOrder, mapProduct, normalizeRedirect,
  nuvemshopConfig, NUVEMSHOP_TOPICS, NuvemshopClient, oauthStateDigest, type NuvemshopCredential,
} from '@/src/integrations/nuvemshop.mjs';
import { attributeOrderFromEvidence } from '@/src/integrations/attribution.mjs';

const credentialSchema = z.object({
  accessToken: z.string().min(1), storeId: z.string().min(1), scopes: z.array(z.string()),
});
export function assertIntegrationManager(role: Role) {
  if (role !== 'owner' && role !== 'admin') throw new ForbiddenError('Somente owner ou admin pode gerenciar integrações.');
}
export async function beginNuvemshopOAuth(tenantId: string, userId: string, redirectPath: string | null) {
  const config = nuvemshopConfig();
  const redirect = normalizeRedirect(redirectPath, config.redirectAllowlist);
  const callbackUri = `${config.publicUrl}/api/integrations/nuvemshop/callback`;
  return withTenant(tenantId, userId, async (client, context) => {
    assertIntegrationManager(context.role);
    const state = createOAuthState();
    await client.query(
      `INSERT INTO seller.oauth_states(state_hash,tenant_id,user_id,provider,redirect_uri,redirect_path,expires_at)
       VALUES($1,$2,$3,'nuvemshop',$4,$5,now()+interval '10 minutes')`,
      [state.digest, tenantId, userId, callbackUri, redirect],
    );
    await client.query(`DELETE FROM seller.oauth_states WHERE tenant_id=$1 AND (expires_at<now() OR used_at IS NOT NULL)`, [tenantId]);
    return authorizationUrl(state.raw);
  });
}

export async function finishNuvemshopOAuth(
  tenantId: string, userId: string, state: string, code: string, fetcher: typeof fetch = fetch,
) {
  const consumed = await withTenant(tenantId, userId, async (client, context) => {
    assertIntegrationManager(context.role);
    const result = await client.query<{ redirect_path: string }>(
      `UPDATE seller.oauth_states SET used_at=now()
       WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND provider='nuvemshop'
         AND redirect_uri=$4 AND used_at IS NULL AND expires_at>now()
       RETURNING redirect_path`,
      [oauthStateDigest(state), tenantId, userId, `${nuvemshopConfig().publicUrl}/api/integrations/nuvemshop/callback`],
    );
    if (!result.rows[0]) throw new ForbiddenError('State OAuth inválido, expirado ou já utilizado.');
    return result.rows[0].redirect_path;
  });
  const credential = await exchangeAuthorizationCode(code, fetcher);
  const installation = await withTenant(tenantId, userId, async (client, context) => {
    assertIntegrationManager(context.role);
    const integration = await client.query<{ id: string }>(
      `INSERT INTO seller.integrations
        (tenant_id,provider,kind,external_account_id,display_name,status,metadata,disconnected_at,last_error)
       VALUES($1,'nuvemshop','commerce',$2,$3,'active',$4,NULL,NULL)
       ON CONFLICT (tenant_id,provider,external_account_id) DO UPDATE SET
         status='active', display_name=excluded.display_name, metadata=excluded.metadata,
         disconnected_at=NULL, suspended_at=NULL, last_error=NULL
       RETURNING id`,
      [tenantId, credential.storeId, `Nuvemshop ${credential.storeId}`, { apiVersion: '2025-03', scopes: credential.scopes }],
    );
    const integrationId = integration.rows[0]!.id;
    const encrypted = encryptCredential(credential, { tenantId, provider:'nuvemshop', integrationId });
    await client.query(
      `INSERT INTO seller.oauth_credentials(tenant_id,integration_id,key_version,iv,auth_tag,ciphertext,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,integration_id) DO UPDATE SET
         key_version=excluded.key_version,iv=excluded.iv,auth_tag=excluded.auth_tag,
         ciphertext=excluded.ciphertext,aad_version=excluded.aad_version,updated_at=now()`,
      [tenantId, integrationId, encrypted.keyVersion, encrypted.iv, encrypted.authTag, encrypted.ciphertext, encrypted.aadVersion],
    );
    await audit(client, context, 'integration.nuvemshop_connected', 'integration', integrationId, { storeId: credential.storeId });
    return { integrationId, credential };
  });
  await registerWebhooks(tenantId, userId, installation.integrationId, installation.credential);
  await Promise.all((['products', 'orders'] as const).map(resource =>
    enqueueNuvemshop(
      { tenantId, integrationId: installation.integrationId, resource, mode: 'backfill' },
    ),
  ));
  return { integrationId: installation.integrationId, redirectPath: consumed };
}

async function registerWebhooks(
  tenantId: string, userId: string, integrationId: string, credential: NuvemshopCredential,
) {
  const config = nuvemshopConfig();
  const client = new NuvemshopClient({ storeId: credential.storeId, accessToken: credential.accessToken });
  for (const topic of NUVEMSHOP_TOPICS) {
    try {
      const webhookToken = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(webhookToken).digest();
      const created = await client.post<{ id?: string|number }>('/webhooks', {
        event: topic, url: `${config.publicUrl}/api/webhooks/nuvemshop?hook=${encodeURIComponent(webhookToken)}`,
      });
      await withTenant(tenantId, userId, async db => {
        await db.query(
          `INSERT INTO seller.integration_webhooks(tenant_id,integration_id,topic,external_id,token_hash,status,last_error)
           VALUES($1,$2,$3,$4,$5,'active',NULL)
           ON CONFLICT (tenant_id,integration_id,topic) DO UPDATE SET
             external_id=excluded.external_id,token_hash=excluded.token_hash,status='active',last_error=NULL`,
          [tenantId, integrationId, topic, created.id == null ? null : String(created.id), tokenHash],
        );
      });
    } catch (error) {
      const message = safeError(error);
      await withTenant(tenantId, userId, async db => {
        const failedTokenHash = createHash('sha256').update(randomBytes(32)).digest();
        await db.query(
          `INSERT INTO seller.integration_webhooks(tenant_id,integration_id,topic,token_hash,status,last_error)
           VALUES($1,$2,$3,$4,'error',$5)
           ON CONFLICT (tenant_id,integration_id,topic) DO UPDATE SET status='error',last_error=excluded.last_error`,
          [tenantId, integrationId, topic, failedTokenHash, message],
        );
        await db.query(`UPDATE seller.integrations SET status='error',last_error=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, integrationId, message]);
      });
    }
  }
}

export interface StoredIntegration {
  id: string; storeId: string; status: string; lastSyncAt: Date|null; lastError: string|null;
  suspendedAt: Date|null; webhookErrors: number;
}
export async function getNuvemshopStatus(tenantId: string, userId: string): Promise<StoredIntegration | null> {
  return withTenant(tenantId, userId, async (client, context) => {
    assertIntegrationManager(context.role);
    const result = await client.query<{
      id:string; external_account_id:string; status:string; last_sync_at:Date|null; last_error:string|null;
      suspended_at:Date|null; webhook_errors:string;
    }>(
      `SELECT i.id,i.external_account_id,i.status,i.last_sync_at,i.last_error,i.suspended_at,
        count(w.*) FILTER (WHERE w.status='error')::text webhook_errors
       FROM seller.integrations i LEFT JOIN seller.integration_webhooks w
         ON w.tenant_id=i.tenant_id AND w.integration_id=i.id
       WHERE i.tenant_id=$1 AND i.provider='nuvemshop' AND i.disconnected_at IS NULL
       GROUP BY i.tenant_id,i.id ORDER BY i.created_at DESC LIMIT 1`, [tenantId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id, storeId: row.external_account_id, status: row.status, lastSyncAt: row.last_sync_at,
      lastError: row.last_error, suspendedAt: row.suspended_at, webhookErrors: Number(row.webhook_errors),
    } : null;
  });
}

export async function disconnectNuvemshop(tenantId: string, userId: string, integrationId: string) {
  const loaded = await withTenant(tenantId, userId, async (client, context) => {
    assertIntegrationManager(context.role);
    return loadCredential(client, tenantId, integrationId);
  });
  const client = new NuvemshopClient({ storeId: loaded.credential.storeId, accessToken: loaded.credential.accessToken });
  for (const webhook of loaded.webhooks) {
    if (!webhook.externalId) continue;
    try { await client.delete(`/webhooks/${encodeURIComponent(webhook.externalId)}`); } catch { /* revogação local continua */ }
  }
  await withTenant(tenantId, userId, async (db, context) => {
    assertIntegrationManager(context.role);
    await db.query(`DELETE FROM seller.oauth_credentials WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]);
    await db.query(
      `UPDATE seller.integrations SET status='revoked',disconnected_at=now(),last_error=NULL WHERE tenant_id=$1 AND id=$2`,
      [tenantId, integrationId],
    );
    await db.query(`UPDATE seller.integration_webhooks SET status='deleted' WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]);
    await audit(db, context, 'integration.nuvemshop_disconnected', 'integration', integrationId);
  });
}

async function loadCredential(client: Queryable, tenantId: string, integrationId: string) {
  const result = await client.query<{
    key_version:string; iv:Buffer; auth_tag:Buffer; ciphertext:Buffer; aad_version:1|2; external_account_id:string;
  }>(
    `SELECT c.key_version,c.iv,c.auth_tag,c.ciphertext,c.aad_version,i.external_account_id
     FROM seller.oauth_credentials c JOIN seller.integrations i
       ON i.tenant_id=c.tenant_id AND i.id=c.integration_id
     WHERE c.tenant_id=$1 AND c.integration_id=$2 AND i.provider='nuvemshop'`,
    [tenantId, integrationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Credencial Nuvemshop não encontrada.');
  const credential = credentialSchema.parse(decryptCredential({
    keyVersion: row.key_version, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext,
    aadVersion: row.aad_version,
  }, { tenantId, provider:'nuvemshop', integrationId }));
  const webhooks = await client.query<{ externalId:string|null }>(
    `SELECT external_id "externalId" FROM seller.integration_webhooks
     WHERE tenant_id=$1 AND integration_id=$2 AND status='active'`, [tenantId, integrationId],
  );
  return { credential, webhooks: webhooks.rows };
}

async function withWorkerTenant<T>(
  pool: Pool, tenantId: string, callback: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id','',true)`, [tenantId]);
    const result = await callback(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function processNuvemshopJob(pool: Pool, job: NuvemshopJob, signal: AbortSignal) {
  let registrationFailures = 0;
  const syncStartedAt = new Date();
  const loaded = await withWorkerTenant(pool, job.tenantId, async db => {
    const credential = await loadCredential(db, job.tenantId, job.integrationId);
    const cursor = await db.query<{ cursor:{updatedThrough?:string} }>(
      `SELECT cursor FROM seller.sync_cursors
       WHERE tenant_id=$1 AND integration_id=$2 AND resource=$3`,
      [job.tenantId,job.integrationId,job.resource],
    );
    return { ...credential, updatedThrough:cursor.rows[0]?.cursor.updatedThrough ?? null };
  });
  const client = new NuvemshopClient({
    storeId: loaded.credential.storeId,
    accessToken: loaded.credential.accessToken,
  });
  const cursorTime = loaded.updatedThrough ? new Date(loaded.updatedThrough).getTime() : Date.now();
  const overlap = new Date(cursorTime - 10 * 60_000).toISOString();
  if (job.resource === 'registration') {
    registrationFailures = await retryWebhookRegistrations(pool, job, client, signal);
  } else if (job.resource === 'webhook' && job.inboxId) {
    const item = await withWorkerTenant(pool, job.tenantId, async db => {
      const inbox = await db.query<{ topic:string; payload:Record<string,unknown> }>(
        `SELECT topic,payload FROM seller.webhook_inbox WHERE tenant_id=$1 AND id=$2`,
        [job.tenantId, job.inboxId],
      );
      return inbox.rows[0] ?? null;
    });
    if (item) {
      const id = String(item.payload.id ?? item.payload.product_id ?? item.payload.order_id ?? '');
      if (!id && (item.topic.startsWith('product/') || item.topic.startsWith('order/'))) {
        throw new Error('Webhook sem identificador de recurso.');
      }
      let resourcePayload: Record<string,unknown>|null = null;
      if (item.topic.startsWith('product/') && !item.topic.endsWith('/deleted')) {
        resourcePayload = await client.get<Record<string,unknown>>(`/products/${encodeURIComponent(id)}`, signal);
      } else if (item.topic.startsWith('order/')) {
        resourcePayload = await client.get<Record<string,unknown>>(`/orders/${encodeURIComponent(id)}`, signal);
      }
      await withWorkerTenant(pool, job.tenantId, async db => {
        await handleWebhook(db, job, item.topic, item.payload, resourcePayload);
        await db.query(
          `UPDATE seller.webhook_inbox SET processed_at=now(),error=NULL WHERE tenant_id=$1 AND id=$2`,
          [job.tenantId, job.inboxId],
        );
      });
    }
  } else {
    const path = job.resource === 'products' ? '/products' : '/orders';
    const query = job.mode === 'incremental' ? `?updated_at_min=${encodeURIComponent(overlap)}` : '?per_page=200';
    const seen = new Set<string>();
    for await (const records of client.paginate<Record<string,unknown>>(`${path}${query}`, signal)) {
      await withWorkerTenant(pool, job.tenantId, async db => {
        for (const payload of records) {
          seen.add(String(payload.id));
          if (job.resource === 'products') await upsertProduct(db, job, payload);
          else await upsertOrder(db, job, payload);
        }
      });
    }
    if (job.resource === 'products' && job.mode === 'backfill') {
      await withWorkerTenant(pool, job.tenantId, async db => {
        await db.query(
          `UPDATE seller.products SET archived_at=now()
           WHERE tenant_id=$1 AND integration_id=$2 AND archived_at IS NULL
             AND NOT (external_id=ANY($3::text[]))`,
          [job.tenantId,job.integrationId,[...seen]],
        );
        await db.query(
          `UPDATE seller.variants v SET archived_at=now() FROM seller.products p
           WHERE p.tenant_id=v.tenant_id AND p.id=v.product_id
             AND p.tenant_id=$1 AND p.integration_id=$2 AND p.archived_at IS NOT NULL
             AND v.archived_at IS NULL`,
          [job.tenantId,job.integrationId],
        );
      });
    }
  }
  await withWorkerTenant(pool, job.tenantId, async db => {
    if (job.resource === 'products' || job.resource === 'orders') {
      await db.query(
        `INSERT INTO seller.sync_cursors(tenant_id,integration_id,resource,cursor)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (tenant_id,integration_id,resource) DO UPDATE
         SET cursor=excluded.cursor,updated_at=now()`,
        [job.tenantId,job.integrationId,job.resource,{updatedThrough:syncStartedAt.toISOString()}],
      );
    }
    await db.query(
      `UPDATE seller.integrations i SET
         status=CASE WHEN i.suspended_at IS NOT NULL THEN 'error' WHEN EXISTS (
           SELECT 1 FROM seller.integration_webhooks w
           WHERE w.tenant_id=i.tenant_id AND w.integration_id=i.id AND w.status='error'
         ) THEN 'error' ELSE 'active' END,
         last_sync_at=now(),
         last_error=CASE WHEN i.suspended_at IS NOT NULL THEN i.last_error WHEN EXISTS (
           SELECT 1 FROM seller.integration_webhooks w
           WHERE w.tenant_id=i.tenant_id AND w.integration_id=i.id AND w.status='error'
         ) THEN i.last_error ELSE NULL END
       WHERE i.tenant_id=$1 AND i.id=$2 AND i.disconnected_at IS NULL`,
      [job.tenantId, job.integrationId],
    );
  });
  if (registrationFailures > 0) throw new Error(`${registrationFailures} webhook(s) ainda não puderam ser registrados.`);
}

async function retryWebhookRegistrations(
  pool: Pool, job: NuvemshopJob, client: NuvemshopClient, signal: AbortSignal,
): Promise<number> {
  const config = nuvemshopConfig();
  const failed = await withWorkerTenant(pool, job.tenantId, db =>
    db.query<{ topic:string }>(
      `SELECT topic FROM seller.integration_webhooks
       WHERE tenant_id=$1 AND integration_id=$2 AND status='error' ORDER BY topic`,
      [job.tenantId, job.integrationId],
    ));
  let failures = 0;
  for (const { topic } of failed.rows) {
    const webhookToken = randomBytes(32).toString('base64url');
    try {
      const created = await client.post<{ id?:string|number }>('/webhooks', {
        event: topic, url: `${config.publicUrl}/api/webhooks/nuvemshop?hook=${encodeURIComponent(webhookToken)}`,
      }, signal);
      await withWorkerTenant(pool, job.tenantId, db => db.query(
          `UPDATE seller.integration_webhooks SET external_id=$4,token_hash=$3,status='active',last_error=NULL
           WHERE tenant_id=$1 AND integration_id=$2 AND topic=$5`,
          [job.tenantId, job.integrationId, createHash('sha256').update(webhookToken).digest(),
            created.id == null ? null : String(created.id), topic],
        ).then(() => undefined));
    } catch (error) {
      failures++;
      await withWorkerTenant(pool, job.tenantId, db => db.query(
          `UPDATE seller.integration_webhooks SET last_error=$4
           WHERE tenant_id=$1 AND integration_id=$2 AND topic=$3`,
          [job.tenantId, job.integrationId, topic, safeError(error)],
        ).then(() => undefined));
    }
  }
  return failures;
}

async function handleWebhook(
  db: PoolClient, job: NuvemshopJob, topic: string, payload: Record<string,unknown>,
  resourcePayload: Record<string,unknown>|null,
) {
  if (topic === 'app/uninstalled') {
    await db.query(`DELETE FROM seller.oauth_credentials WHERE tenant_id=$1 AND integration_id=$2`, [job.tenantId, job.integrationId]);
    await db.query(`UPDATE seller.integrations SET status='revoked',disconnected_at=now() WHERE tenant_id=$1 AND id=$2`, [job.tenantId, job.integrationId]);
    return;
  }
  if (topic === 'app/suspended' || topic === 'app/resumed') {
    await db.query(
      `UPDATE seller.integrations SET status=$3,suspended_at=$4 WHERE tenant_id=$1 AND id=$2`,
      [job.tenantId, job.integrationId, topic.endsWith('suspended') ? 'error' : 'active', topic.endsWith('suspended') ? new Date() : null],
    );
    return;
  }
  if (topic === 'store/redact') {
    await db.query(`UPDATE seller.products SET source_payload=NULL,source_hash=NULL WHERE tenant_id=$1 AND integration_id=$2`, [job.tenantId, job.integrationId]);
    await db.query(`UPDATE seller.orders SET source_payload=NULL,source_hash=NULL WHERE tenant_id=$1 AND integration_id=$2`, [job.tenantId, job.integrationId]);
    await db.query(`DELETE FROM seller.oauth_credentials WHERE tenant_id=$1 AND integration_id=$2`, [job.tenantId, job.integrationId]);
    await db.query(`UPDATE seller.integrations SET status='revoked',disconnected_at=now() WHERE tenant_id=$1 AND id=$2`, [job.tenantId, job.integrationId]);
    if (job.inboxId) await db.query(
      `UPDATE seller.webhook_inbox SET payload='{"redacted":true}',raw_body=NULL WHERE tenant_id=$1 AND id=$2`,
      [job.tenantId, job.inboxId],
    );
    return;
  }
  if (topic === 'customer/redact') {
    const customerId = String(payload.customer_id ?? (payload.customer as Record<string,unknown>|undefined)?.id ?? '');
    if (customerId) await db.query(
      `UPDATE seller.orders SET source_payload='{"redacted":true}',source_hash=NULL
       WHERE tenant_id=$1 AND integration_id=$2
         AND (source_payload->'customer'->>'id'=$3 OR source_payload->>'customer_id'=$3)`,
      [job.tenantId, job.integrationId, customerId],
    );
    if (job.inboxId) await db.query(
      `UPDATE seller.webhook_inbox SET payload='{"redacted":true}',raw_body=NULL WHERE tenant_id=$1 AND id=$2`,
      [job.tenantId, job.inboxId],
    );
    return;
  }
  if (topic === 'customer/data_request') {
    await db.query(
      `INSERT INTO seller.audit_log(tenant_id,action,resource_type,resource_id,metadata)
       VALUES($1,'privacy.customer_data_requested','nuvemshop_customer',$2,$3)`,
      [job.tenantId, String(payload.customer_id ?? 'unknown'), { inboxId: job.inboxId }],
    );
    return;
  }
  const id = String(payload.id ?? payload.product_id ?? payload.order_id ?? '');
  if (!id) throw new Error('Webhook sem identificador de recurso.');
  if (topic.startsWith('product/')) {
    if (topic.endsWith('/deleted')) {
      await db.query(`UPDATE seller.products SET archived_at=now() WHERE tenant_id=$1 AND integration_id=$2 AND external_id=$3`, [job.tenantId, job.integrationId, id]);
    } else if (resourcePayload) await upsertProduct(db, job, resourcePayload);
  } else if (topic.startsWith('order/')) {
    if (resourcePayload) await upsertOrder(db, job, resourcePayload);
  }
}

async function upsertProduct(db: Queryable, job: NuvemshopJob, payload: Record<string,unknown>) {
  const product = mapProduct(payload);
  const result = await db.query<{ id:string }>(
    `INSERT INTO seller.products(tenant_id,integration_id,external_id,name,source_updated_at,source_payload,source_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id,integration_id,external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       name=excluded.name,source_updated_at=excluded.source_updated_at,source_payload=excluded.source_payload,
       source_hash=excluded.source_hash,archived_at=NULL
     WHERE seller.products.source_updated_at IS NULL
       OR excluded.source_updated_at>=seller.products.source_updated_at
     RETURNING id`,
    [job.tenantId, job.integrationId, product.externalId, product.name, product.sourceUpdatedAt, product.payload, product.provenance.hash],
  );
  if (!result.rows[0]) return;
  for (const variant of product.variants) {
    await db.query(
      `INSERT INTO seller.variants(tenant_id,product_id,external_id,sku,attributes,price_cents,stock,source_payload,source_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id,product_id,external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         sku=excluded.sku,attributes=excluded.attributes,price_cents=excluded.price_cents,
         stock=excluded.stock,source_payload=excluded.source_payload,source_hash=excluded.source_hash,archived_at=NULL`,
      [job.tenantId, result.rows[0]!.id, variant.externalId, variant.sku, variant.attributes,
        variant.priceCents.toString(), variant.stock?.toString() ?? null, payload, product.provenance.hash],
    );
  }
  await db.query(
    `UPDATE seller.variants SET archived_at=now()
     WHERE tenant_id=$1 AND product_id=$2 AND archived_at IS NULL
       AND NOT (external_id=ANY($3::text[]))`,
    [job.tenantId,result.rows[0]!.id,product.variants.map(variant=>variant.externalId)],
  );
}
async function upsertOrder(db: Queryable, job: NuvemshopJob, payload: Record<string,unknown>) {
  const order = mapOrder(payload);
  const result = await db.query<{ id:string }>(
    `INSERT INTO seller.orders(tenant_id,integration_id,external_id,status,placed_at,currency,source_updated_at,source_payload,source_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id,integration_id,external_id) DO UPDATE SET
       status=CASE WHEN seller.orders.status='refunded' AND excluded.status='pending'
         THEN seller.orders.status ELSE excluded.status END,
       placed_at=excluded.placed_at,currency=excluded.currency,
       source_updated_at=excluded.source_updated_at,source_payload=excluded.source_payload,source_hash=excluded.source_hash
     WHERE seller.orders.source_updated_at IS NULL
       OR excluded.source_updated_at>=seller.orders.source_updated_at
     RETURNING id`,
    [job.tenantId, job.integrationId, order.externalId, order.status, order.placedAt, order.currency,
      order.sourceUpdatedAt, order.payload, order.provenance.hash],
  );
  if (!result.rows[0]) return;
  for (const line of order.lines) {
    const variant = line.variantExternalId
      ? await db.query<{ id:string }>(
        `SELECT v.id FROM seller.variants v JOIN seller.products p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         WHERE v.tenant_id=$1 AND p.integration_id=$2 AND v.external_id=$3`, [job.tenantId, job.integrationId, line.variantExternalId],
      ) : { rows: [] };
    await db.query(
      `INSERT INTO seller.order_lines
        (tenant_id,order_id,variant_id,external_line_id,sku_snapshot,quantity,unit_price_cents,
         discount_cents,returned_quantity,restocked_quantity)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id,order_id,external_line_id) DO UPDATE SET
         variant_id=excluded.variant_id,sku_snapshot=excluded.sku_snapshot,quantity=excluded.quantity,
         unit_price_cents=excluded.unit_price_cents,discount_cents=excluded.discount_cents,
         returned_quantity=excluded.returned_quantity,restocked_quantity=excluded.restocked_quantity`,
      [job.tenantId, result.rows[0]!.id, variant.rows[0]?.id ?? null, line.externalId, line.sku,
        line.quantity, line.unitPriceCents.toString(), line.discountCents.toString(),
        line.returnedQuantity,line.restockedQuantity],
    );
  }
  await db.query(
    `DELETE FROM seller.order_lines
     WHERE tenant_id=$1 AND order_id=$2 AND NOT (external_line_id = ANY($3::text[]))`,
    [job.tenantId, result.rows[0]!.id, order.lines.map(line => line.externalId)],
  );
  for (const event of order.financialEvents) {
    await db.query(
      `INSERT INTO seller.order_events
        (tenant_id,order_id,source_key,kind,amount_cents,direction,payload,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,order_id,source_key) DO UPDATE SET
         kind=excluded.kind,amount_cents=excluded.amount_cents,direction=excluded.direction,
         payload=excluded.payload,occurred_at=excluded.occurred_at`,
      [job.tenantId,result.rows[0]!.id,event.sourceKey,event.kind,event.amountCents.toString(),
        event.direction,event.payload,event.occurredAt],
    );
  }
  await db.query(
    `DELETE FROM seller.order_events WHERE tenant_id=$1 AND order_id=$2
       AND NOT (source_key=ANY($3::text[]))`,
    [job.tenantId,result.rows[0]!.id,order.financialEvents.map(event=>event.sourceKey)],
  );
  if (order.returnAllocationKnown) {
    await db.query(
      `UPDATE seller.data_quality_issues SET resolved_at=now()
       WHERE tenant_id=$1 AND code='return_allocation_unknown' AND resource_type='order'
         AND resource_id=$2 AND resolved_at IS NULL`,
      [job.tenantId,result.rows[0]!.id],
    );
  } else {
    await db.query(
      `INSERT INTO seller.data_quality_issues
        (tenant_id,code,severity,resource_type,resource_id,details)
       SELECT $1,'return_allocation_unknown','error','order',$2,$3
       WHERE NOT EXISTS (
         SELECT 1 FROM seller.data_quality_issues
         WHERE tenant_id=$1 AND code='return_allocation_unknown' AND resource_type='order'
           AND resource_id=$2 AND resolved_at IS NULL
       )`,
      [job.tenantId,result.rows[0]!.id,{
        externalOrderId:order.externalId,
        reason:'A origem não informou alocação por linha e/ou reposição das unidades devolvidas.',
        financialImpact:'contribution_unknown',
      }],
    );
  }
  await attributeOrderFromEvidence(db, job.tenantId, result.rows[0]!.id, payload);
}
export function safeError(error: unknown): string {
  return redactSecrets(error);
}
