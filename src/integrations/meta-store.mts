import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  audit, decryptCredential, encryptCredential, ForbiddenError, redactSecrets, withTenant, type Queryable, type Role,
} from '@/src/server/core.mjs';
import { enqueueMeta, type MetaJob } from '@/src/server/queue.mjs';
import {
  breakdownHash, createMetaOAuthState, decimalToMetaCents, exchangeMetaAuthorizationCode,
  insightConfigurationHash, META_API_VERSION, META_REQUIRED_SCOPE, MetaClient, metaAuthorizationUrl,
  metaConfig, metaOAuthStateDigest, normalizeMetaRedirect,
  type MetaAdAccount, type MetaCredential, type MetaEntity, type MetaInsight,
} from '@/src/integrations/meta.mjs';

const credentialSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string(),
  expiresAt: z.string().nullable(),
  scopes: z.array(z.string()),
  metaUserId: z.string().min(1),
});
const accountIdsSchema = z.array(z.string().regex(/^\d+$/)).min(1).max(100);

export function assertMetaManager(role: Role) {
  if (role !== 'owner' && role !== 'admin') {
    throw new ForbiddenError('Somente owner ou admin pode gerenciar integrações.');
  }
}

export async function beginMetaOAuth(tenantId: string, userId: string, redirectPath: string | null) {
  const config = metaConfig();
  const redirect = normalizeMetaRedirect(redirectPath, config.redirectAllowlist);
  return withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    const state = createMetaOAuthState();
    await client.query(
      `INSERT INTO seller.oauth_states(state_hash,tenant_id,user_id,provider,redirect_uri,redirect_path,expires_at)
       VALUES($1,$2,$3,'meta',$4,$5,now()+interval '10 minutes')`,
      [state.digest, tenantId, userId, config.redirectUri, redirect],
    );
    await client.query(
      `DELETE FROM seller.oauth_states WHERE tenant_id=$1 AND (expires_at<now() OR used_at IS NOT NULL)`,
      [tenantId],
    );
    return metaAuthorizationUrl(state.raw);
  });
}

export async function finishMetaOAuth(
  tenantId: string, userId: string, state: string, code: string, fetcher: typeof fetch = fetch,
) {
  const config = metaConfig();
  const redirectPath = await withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    const consumed = await client.query<{ redirect_path: string }>(
      `UPDATE seller.oauth_states SET used_at=now()
       WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND provider='meta'
         AND redirect_uri=$4 AND used_at IS NULL AND expires_at>now()
       RETURNING redirect_path`,
      [metaOAuthStateDigest(state), tenantId, userId, config.redirectUri],
    );
    if (!consumed.rows[0]) throw new ForbiddenError('State OAuth inválido, expirado ou já utilizado.');
    return consumed.rows[0].redirect_path;
  });
  const token = await exchangeMetaAuthorizationCode(code, fetcher);
  const graph = new MetaClient({
    accessToken: token.accessToken, appSecret: config.appSecret, fetcher, timeoutMs: config.timeoutMs,
  });
  const [profile, permissionPages, accountPages] = await Promise.all([
    graph.request<{ id: string; name?: string }>('/me', { fields: 'id,name' }),
    collectPages(graph.paginate<{ permission: string; status: string }>('/me/permissions')),
    collectPages(graph.paginate<MetaAdAccount>('/me/adaccounts', {
      fields: 'id,account_id,name,currency,timezone_name,account_status',
      limit: '100',
    })),
  ]);
  const scopes = permissionPages.flat().filter(item => item.status === 'granted').map(item => item.permission);
  if (!scopes.includes(META_REQUIRED_SCOPE)) throw new ForbiddenError('A permissão ads_read não foi concedida.');
  const credential: MetaCredential = { ...token, scopes, metaUserId: profile.id };
  const accounts = accountPages.flat();
  const installation = await withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    const integration = await client.query<{ id: string }>(
      `INSERT INTO seller.integrations
        (tenant_id,provider,kind,external_account_id,display_name,status,metadata,disconnected_at,last_error)
       VALUES($1,'meta','ads',$2,$3,'pending',$4,NULL,NULL)
       ON CONFLICT (tenant_id,provider,external_account_id) DO UPDATE SET
         display_name=excluded.display_name,status='pending',metadata=excluded.metadata,
         disconnected_at=NULL,suspended_at=NULL,last_error=NULL
       RETURNING id`,
      [tenantId, profile.id, profile.name ?? `Meta ${profile.id}`, {
        apiVersion: META_API_VERSION, scopes, configId: config.configId,
      }],
    );
    const integrationId = integration.rows[0]!.id;
    const encrypted = encryptCredential(credential, { tenantId, provider:'meta', integrationId });
    await client.query(
      `INSERT INTO seller.oauth_credentials(tenant_id,integration_id,key_version,iv,auth_tag,ciphertext,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,integration_id) DO UPDATE SET
         key_version=excluded.key_version,iv=excluded.iv,auth_tag=excluded.auth_tag,
         ciphertext=excluded.ciphertext,aad_version=excluded.aad_version,updated_at=now()`,
      [tenantId, integrationId, encrypted.keyVersion, encrypted.iv, encrypted.authTag, encrypted.ciphertext, encrypted.aadVersion],
    );
    await client.query(`DELETE FROM seller.meta_account_candidates WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]);
    for (const account of accounts) {
      await client.query(
        `INSERT INTO seller.meta_account_candidates
          (tenant_id,integration_id,external_id,name,currency,timezone,account_status,discovered_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
        [tenantId, integrationId, account.account_id, account.name, account.currency, account.timezone_name, account.account_status],
      );
    }
    await client.query(
      `UPDATE seller.ad_accounts SET selected=false,archived_at=now()
       WHERE tenant_id=$1 AND integration_id=$2 AND archived_at IS NULL
         AND NOT (external_id=ANY($3::text[]))`,
      [tenantId,integrationId,accounts.map(account=>account.account_id)],
    );
    await audit(client, context, 'integration.meta_authorized', 'integration', integrationId, {
      metaUserId: profile.id, availableAccounts: accounts.length,
    });
    return integrationId;
  });
  return { integrationId: installation, redirectPath, accounts };
}

async function collectPages<T>(generator: AsyncGenerator<T[]>): Promise<T[][]> {
  const pages: T[][] = [];
  for await (const page of generator) pages.push(page);
  return pages;
}

export async function selectMetaAccounts(
  tenantId: string, userId: string, integrationId: string, requestedAccountIds: unknown,
) {
  const accountIds = accountIdsSchema.parse(requestedAccountIds);
  await withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    const candidates = await client.query<{
      external_id:string; name:string; currency:string; timezone:string; account_status:number;
    }>(
      `SELECT external_id,name,currency,timezone,account_status
       FROM seller.meta_account_candidates
       WHERE tenant_id=$1 AND integration_id=$2 AND external_id=ANY($3::text[])`,
      [tenantId, integrationId, accountIds],
    );
    if (candidates.rows.length !== new Set(accountIds).size) {
      throw new ForbiddenError('Seleção contém conta não retornada pelo token Meta.');
    }
    await client.query(
      `UPDATE seller.ad_accounts SET selected=false,archived_at=now()
       WHERE tenant_id=$1 AND integration_id=$2 AND NOT (external_id=ANY($3::text[]))`,
      [tenantId, integrationId, accountIds],
    );
    for (const account of candidates.rows) {
      await client.query(
        `INSERT INTO seller.ad_accounts
          (tenant_id,integration_id,external_id,name,currency,timezone,account_status,selected,archived_at,source_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,true,NULL,$8)
         ON CONFLICT (tenant_id,integration_id,external_id) DO UPDATE SET
           name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,
           account_status=excluded.account_status,selected=true,archived_at=NULL,source_payload=excluded.source_payload`,
        [tenantId, integrationId, account.external_id, account.name, account.currency,
          account.timezone, account.account_status, account],
      );
    }
    await client.query(
      `UPDATE seller.integrations SET status='active',last_error=NULL WHERE tenant_id=$1 AND id=$2 AND provider='meta'`,
      [tenantId, integrationId],
    );
    await audit(client, context, 'integration.meta_accounts_selected', 'integration', integrationId, { accountIds });
  });
  await enqueueMeta({ tenantId, integrationId, mode: 'backfill' });
}

export interface MetaIntegrationStatus {
  id: string;
  status: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  accounts: Array<{ id:string; externalId:string; name:string; currency:string; timezone:string; selected:boolean }>;
  candidates: Array<{ externalId:string; name:string; currency:string; timezone:string }>;
}
export async function getMetaStatus(tenantId: string, userId: string): Promise<MetaIntegrationStatus | null> {
  return withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    const integration = await client.query<{ id:string; status:string; last_sync_at:Date|null; last_error:string|null }>(
      `SELECT id,status,last_sync_at,last_error FROM seller.integrations
       WHERE tenant_id=$1 AND provider='meta' AND disconnected_at IS NULL
       ORDER BY created_at DESC LIMIT 1`, [tenantId],
    );
    const row = integration.rows[0];
    if (!row) return null;
    const [accounts, candidates] = await Promise.all([
      client.query<{ id:string; external_id:string; name:string; currency:string; timezone:string; selected:boolean }>(
        `SELECT id,external_id,name,currency,timezone,selected FROM seller.ad_accounts
         WHERE tenant_id=$1 AND integration_id=$2 ORDER BY name`, [tenantId, row.id],
      ),
      client.query<{ external_id:string; name:string; currency:string; timezone:string }>(
        `SELECT external_id,name,currency,timezone FROM seller.meta_account_candidates
         WHERE tenant_id=$1 AND integration_id=$2 ORDER BY name`, [tenantId, row.id],
      ),
    ]);
    return {
      id: row.id, status: row.status, lastSyncAt: row.last_sync_at, lastError: row.last_error,
      accounts: accounts.rows.map(item => ({ id:item.id, externalId:item.external_id, name:item.name,
        currency:item.currency, timezone:item.timezone, selected:item.selected })),
      candidates: candidates.rows.map(item => ({ externalId:item.external_id, name:item.name,
        currency:item.currency, timezone:item.timezone })),
    };
  });
}

export async function disconnectMeta(tenantId: string, userId: string, integrationId: string) {
  await withTenant(tenantId, userId, async (client, context) => {
    assertMetaManager(context.role);
    await client.query(`DELETE FROM seller.oauth_credentials WHERE tenant_id=$1 AND integration_id=$2`, [tenantId, integrationId]);
    await client.query(
      `UPDATE seller.integrations SET status='revoked',disconnected_at=now(),last_error=NULL
       WHERE tenant_id=$1 AND id=$2 AND provider='meta'`,
      [tenantId, integrationId],
    );
    await client.query(
      `UPDATE seller.ad_accounts SET selected=false,archived_at=now() WHERE tenant_id=$1 AND integration_id=$2`,
      [tenantId, integrationId],
    );
    await audit(client, context, 'integration.meta_disconnected', 'integration', integrationId);
  });
}

async function loadMetaCredential(client: Queryable, tenantId: string, integrationId: string): Promise<MetaCredential> {
  const result = await client.query<{ key_version:string;iv:Buffer;auth_tag:Buffer;ciphertext:Buffer;aad_version:1|2 }>(
    `SELECT c.key_version,c.iv,c.auth_tag,c.ciphertext,c.aad_version
     FROM seller.oauth_credentials c JOIN seller.integrations i
       ON i.tenant_id=c.tenant_id AND i.id=c.integration_id
     WHERE c.tenant_id=$1 AND c.integration_id=$2 AND i.provider='meta' AND i.disconnected_at IS NULL`,
    [tenantId, integrationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Credencial Meta não encontrada.');
  return credentialSchema.parse(decryptCredential({
    keyVersion: row.key_version, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext,
    aadVersion: row.aad_version,
  }, { tenantId, provider:'meta', integrationId }));
}

async function withMetaTenant<T>(
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

export async function processMetaJob(pool: Pool, job: MetaJob, signal: AbortSignal) {
  let runId: string | null = null;
  try {
    const loaded = await withMetaTenant(pool, job.tenantId, async db => {
      const run = await db.query<{ id:string }>(
        `INSERT INTO seller.sync_runs(tenant_id,integration_id,resource,status,stats)
         VALUES($1,$2,'meta','running',$3) RETURNING id`,
        [job.tenantId, job.integrationId, { mode: job.mode, apiVersion: META_API_VERSION }],
      );
      const credential = await loadMetaCredential(db, job.tenantId, job.integrationId);
      const accounts = await db.query<{ id:string;external_id:string;currency:string;timezone:string }>(
        `SELECT id,external_id,currency,timezone FROM seller.ad_accounts
         WHERE tenant_id=$1 AND integration_id=$2 AND selected=true AND archived_at IS NULL`,
        [job.tenantId, job.integrationId],
      );
      return { runId:run.rows[0]!.id,credential,accounts:accounts.rows };
    });
    runId = loaded.runId;
    const usage: Array<Record<string, unknown>> = [];
    const graph = new MetaClient({
      accessToken: loaded.credential.accessToken,
      onRateLimit: value => usage.push(value as unknown as Record<string, unknown>),
    });
    let entityCount = 0;
    let factCount = 0;
    for (const account of loaded.accounts) {
      entityCount += await syncEntities(pool, job.tenantId, account.id, account.external_id, graph, signal);
      factCount += await syncInsights(pool, job.tenantId, account, graph, job.mode, signal);
    }
    await withMetaTenant(pool, job.tenantId, async db => {
      await db.query(
        `UPDATE seller.sync_runs SET status='succeeded',finished_at=now(),stats=$3 WHERE tenant_id=$1 AND id=$2`,
        [job.tenantId, runId, { accounts: loaded.accounts.length, entities: entityCount, facts: factCount, rateLimit: usage.at(-1) ?? null }],
      );
      await db.query(
        `UPDATE seller.integrations SET status='active',last_sync_at=now(),last_error=NULL WHERE tenant_id=$1 AND id=$2`,
        [job.tenantId, job.integrationId],
      );
    });
  } catch (error) {
    if (runId) await withMetaTenant(pool, job.tenantId, db => db.query(
      `UPDATE seller.sync_runs SET status='failed',finished_at=now(),error=$3
       WHERE tenant_id=$1 AND id=$2 AND status='running'`,
      [job.tenantId,runId,safeMetaError(error)],
    ).then(() => undefined));
    throw error;
  }
}

async function syncEntities(
  pool: Pool, tenantId: string, accountId: string, externalAccountId: string,
  graph: MetaClient, signal: AbortSignal,
) {
  let count = 0;
  const campaignsSeen = new Set<string>();
  const campaignMap = new Map<string,string>();
  for await (const page of graph.paginate<MetaEntity>(`/act_${externalAccountId}/campaigns`, {
    fields: 'id,name,status,effective_status,updated_time', limit: '100',
  }, signal)) {
    await withMetaTenant(pool, tenantId, async db => {
      for (const entity of page) {
        const stored = await upsertEntity(db, 'ad_campaigns', tenantId, accountId, entity, null, null);
        campaignsSeen.add(entity.id);
        campaignMap.set(entity.id, stored);
        count++;
      }
    });
  }
  await withMetaTenant(pool,tenantId,db =>
    archiveMissingEntities(db,'ad_campaigns',tenantId,accountId,campaignsSeen));
  const adsetsSeen = new Set<string>();
  const adsetMap = new Map<string,string>();
  for await (const page of graph.paginate<MetaEntity>(`/act_${externalAccountId}/adsets`, {
    fields: 'id,name,status,effective_status,campaign_id,updated_time', limit: '100',
  }, signal)) {
    await withMetaTenant(pool, tenantId, async db => {
      for (const entity of page) {
        const campaignId = entity.campaign_id ? campaignMap.get(entity.campaign_id) ?? null : null;
        const stored = await upsertEntity(db, 'ad_sets', tenantId, accountId, entity, campaignId, null);
        adsetsSeen.add(entity.id);
        adsetMap.set(entity.id, stored);
        count++;
      }
    });
  }
  await withMetaTenant(pool,tenantId,db =>
    archiveMissingEntities(db,'ad_sets',tenantId,accountId,adsetsSeen));
  const adsSeen = new Set<string>();
  for await (const page of graph.paginate<MetaEntity>(`/act_${externalAccountId}/ads`, {
    fields: 'id,name,status,effective_status,campaign_id,adset_id,updated_time', limit: '100',
  }, signal)) {
    await withMetaTenant(pool, tenantId, async db => {
      for (const entity of page) {
        await upsertEntity(db, 'ads', tenantId, accountId, entity,
          entity.campaign_id ? campaignMap.get(entity.campaign_id) ?? null : null,
          entity.adset_id ? adsetMap.get(entity.adset_id) ?? null : null);
        adsSeen.add(entity.id);
        count++;
      }
    });
  }
  await withMetaTenant(pool,tenantId,db =>
    archiveMissingEntities(db,'ads',tenantId,accountId,adsSeen));
  return count;
}

async function archiveMissingEntities(
  db:Queryable, table:'ad_campaigns'|'ad_sets'|'ads', tenantId:string, accountId:string, seen:Set<string>,
) {
  await db.query(
    `UPDATE seller.${table} SET archived_at=now()
     WHERE tenant_id=$1 AND ad_account_id=$2 AND archived_at IS NULL
       AND NOT (external_id=ANY($3::text[]))`,
    [tenantId,accountId,[...seen]],
  );
}

async function upsertEntity(
  db: Queryable, table: 'ad_campaigns'|'ad_sets'|'ads', tenantId: string, accountId: string,
  entity: MetaEntity, campaignId: string|null, adsetId: string|null,
): Promise<string> {
  const relationColumns = table === 'ad_campaigns' ? '' : table === 'ad_sets'
    ? ',campaign_id' : ',campaign_id,adset_id';
  const relationValues = table === 'ad_campaigns' ? '' : table === 'ad_sets' ? ',$8' : ',$8,$9';
  const values: unknown[] = [
    tenantId, accountId, entity.id, entity.name, entity.status ?? null, entity.effective_status ?? null,
    entity.updated_time ? new Date(entity.updated_time) : null, campaignId, adsetId,
  ];
  const result = await db.query<{ id:string }>(
    `INSERT INTO seller.${table}
      (tenant_id,ad_account_id,external_id,name,status,effective_status,source_updated_at${relationColumns},
       source_payload,provenance,quality)
     VALUES($1,$2,$3,$4,$5,$6,$7${relationValues},$10,$11,$12)
     ON CONFLICT (tenant_id,ad_account_id,external_id) DO UPDATE SET
       name=excluded.name,status=excluded.status,effective_status=excluded.effective_status,
       source_updated_at=excluded.source_updated_at,source_payload=excluded.source_payload,
       provenance=excluded.provenance,quality=excluded.quality,archived_at=NULL
     RETURNING id`,
    [...values, entity, { provider: 'meta', apiVersion: META_API_VERSION }, { imported: true }],
  );
  return result.rows[0]!.id;
}

async function syncInsights(
  pool: Pool, tenantId: string,
  account: { id:string;external_id:string;currency:string;timezone:string },
  graph: MetaClient, mode: MetaJob['mode'], signal: AbortSignal,
) {
  const until = new Date();
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (mode === 'backfill' ? 89 : 27));
  const timeRange = JSON.stringify({
    since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10),
  });
  let count = 0;
  for (const level of ['campaign', 'adset', 'ad'] as const) {
    const configuration = {
      apiVersion: META_API_VERSION, level, timeIncrement: 1, attribution: 'platform_declared',
      fields: ['account_id','campaign_id','adset_id','ad_id','date_start','date_stop','spend',
        'impressions','clicks','reach','actions','action_values'],
    };
    const configHash = insightConfigurationHash(configuration);
    const seenFactIds = new Set<string>();
    for await (const page of graph.paginate<MetaInsight>(`/act_${account.external_id}/insights`, {
      fields: configuration.fields.join(','), level, time_increment: '1', time_range: timeRange, limit: '100',
    }, signal)) {
      await withMetaTenant(pool,tenantId,async db => {
        for (const insight of page) {
          const factId = await upsertInsight(db, tenantId, account, level, configHash, configuration, insight);
          if (factId) seenFactIds.add(factId);
          count++;
        }
      });
    }
    await withMetaTenant(pool,tenantId,db => db.query(
      `DELETE FROM seller.ad_insight_facts
       WHERE tenant_id=$1 AND ad_account_id=$2 AND object_level=$3
         AND metric_date BETWEEN $4::date AND $5::date AND configuration_hash=$6
         AND NOT (id=ANY($7::uuid[]))`,
      [tenantId, account.id, level, since.toISOString().slice(0, 10),
        until.toISOString().slice(0, 10), configHash,[...seenFactIds]],
    ).then(() => undefined));
  }
  return count;
}

async function upsertInsight(
  db: Queryable, tenantId: string,
  account: { id:string;currency:string;timezone:string },
  level: 'campaign'|'adset'|'ad', configHash: string, configuration: Record<string, unknown>, insight: MetaInsight,
) {
  const externalObjectId = level === 'campaign' ? insight.campaign_id : level === 'adset' ? insight.adset_id : insight.ad_id;
  if (!externalObjectId) return null;
  const table = level === 'campaign' ? 'ad_campaigns' : level === 'adset' ? 'ad_sets' : 'ads';
  const object = await db.query<{ id:string }>(
    `SELECT id FROM seller.${table} WHERE tenant_id=$1 AND ad_account_id=$2 AND external_id=$3`,
    [tenantId, account.id, externalObjectId],
  );
  if (!object.rows[0]) return null;
  const breakdowns: Record<string,string> = {};
  const bHash = breakdownHash(breakdowns);
  const fact = await db.query<{ id:string }>(
    `INSERT INTO seller.ad_insight_facts
      (tenant_id,ad_account_id,object_level,object_id,metric_date,breakdowns,breakdown_hash,
       configuration,configuration_hash,currency,timezone,spend_cents,impressions,clicks,reach,source_payload,quality)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (tenant_id,ad_account_id,object_level,object_id,metric_date,breakdown_hash,configuration_hash)
     DO UPDATE SET spend_cents=excluded.spend_cents,impressions=excluded.impressions,clicks=excluded.clicks,
       reach=excluded.reach,source_payload=excluded.source_payload,quality=excluded.quality,imported_at=now()
     RETURNING id`,
    [tenantId, account.id, level, object.rows[0].id, insight.date_start, breakdowns, bHash,
      configuration, configHash, account.currency, account.timezone, decimalToMetaCents(insight.spend).toString(),
      insight.impressions ?? null, insight.clicks ?? null, insight.reach ?? null, insight,
      { source: 'meta_insights', declared: true, causal: false }],
  );
  const configuredPurchases = new Set(
    (process.env.META_PURCHASE_ACTION_TYPES ?? 'purchase,omni_purchase,offsite_conversion.fb_pixel_purchase')
      .split(',').map(value=>value.trim()).filter(Boolean),
  );
  const values = new Map((insight.action_values ?? [])
    .filter(item=>configuredPurchases.has(item.action_type)).map(item => [item.action_type, item.value]));
  const actionTypes = new Set([
    ...(insight.actions ?? []).map(item => item.action_type).filter(type=>configuredPurchases.has(type)),
    ...values.keys(),
  ]);
  for (const actionType of actionTypes) {
    const count = insight.actions?.find(item => item.action_type === actionType)?.value ?? null;
    await db.query(
      `INSERT INTO seller.platform_conversions
        (tenant_id,insight_fact_id,action_type,conversion_count,declared_value_cents,currency,source_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,insight_fact_id,action_type) DO UPDATE SET
         conversion_count=excluded.conversion_count,declared_value_cents=excluded.declared_value_cents,
         source_payload=excluded.source_payload`,
      [tenantId, fact.rows[0]!.id, actionType, count, values.has(actionType)
        ? decimalToMetaCents(values.get(actionType)).toString() : null, account.currency,
      { action: count, actionValue: values.get(actionType) ?? null }],
    );
  }
  await db.query(
    `DELETE FROM seller.platform_conversions
     WHERE tenant_id=$1 AND insight_fact_id=$2 AND NOT (action_type=ANY($3::text[]))`,
    [tenantId, fact.rows[0]!.id, [...actionTypes]],
  );
  return fact.rows[0]!.id;
}

export interface MetaMetricSummary {
  currency: string;
  spendCents: bigint;
  declaredRevenueCents: bigint;
  declaredRoas: number | null;
  attributedNetRevenueCents: bigint;
  attributedMarginAfterMediaCents: bigint | null;
  coverage: number | null;
  warning: string;
}
export async function getMetaMetricSummary(tenantId: string, userId: string): Promise<MetaMetricSummary[]> {
  return withTenant(tenantId, userId, async client => {
    const result = await client.query<{
      currency:string; spend:string; declared_revenue:string; attributed_revenue:string;
      attributed_margin:string|null; linked_orders:string; eligible_orders:string;
    }>(
      `WITH media AS (
         SELECT f.currency,sum(f.spend_cents) spend FROM seller.ad_insight_facts f
         JOIN seller.ad_accounts aa ON aa.tenant_id=f.tenant_id AND aa.id=f.ad_account_id
         JOIN seller.integrations i ON i.tenant_id=aa.tenant_id AND i.id=aa.integration_id
         WHERE f.tenant_id=$1 AND f.object_level='campaign' AND aa.selected=true
           AND aa.archived_at IS NULL AND i.status='active' AND i.disconnected_at IS NULL
         GROUP BY f.currency
       ), fact_declared AS (
         SELECT f.currency,f.id,
           coalesce(max(c.declared_value_cents) FILTER (WHERE c.action_type=ANY($2::text[])),0)
             declared_revenue
         FROM seller.ad_insight_facts f
         JOIN seller.ad_accounts aa ON aa.tenant_id=f.tenant_id AND aa.id=f.ad_account_id
         JOIN seller.integrations i ON i.tenant_id=aa.tenant_id AND i.id=aa.integration_id
         LEFT JOIN seller.platform_conversions c ON c.tenant_id=f.tenant_id AND c.insight_fact_id=f.id
         WHERE f.tenant_id=$1 AND f.object_level='campaign' AND aa.selected=true
           AND aa.archived_at IS NULL AND i.status='active' AND i.disconnected_at IS NULL
         GROUP BY f.currency,f.id
       ), declared AS (
         SELECT currency,sum(declared_revenue) declared_revenue FROM fact_declared GROUP BY currency
       ), attributed AS (
         SELECT o.currency,coalesce(sum(l.attributed_net_revenue_cents),0) attributed_revenue,
           CASE WHEN bool_and(l.attributed_margin_cents IS NOT NULL)
             THEN sum(l.attributed_margin_cents) END attributed_margin,
           count(DISTINCT l.order_id) linked_orders
         FROM seller.attribution_links l JOIN seller.orders o
           ON o.tenant_id=l.tenant_id AND o.id=l.order_id
         WHERE l.tenant_id=$1 AND o.status='paid' GROUP BY o.currency
       ), eligible AS (
         SELECT currency,count(*) eligible_orders FROM seller.orders
         WHERE tenant_id=$1 AND status='paid' GROUP BY currency
       ), currencies AS (
         SELECT currency FROM media UNION SELECT currency FROM declared
         UNION SELECT currency FROM attributed UNION SELECT currency FROM eligible
       )
       SELECT c.currency,coalesce(m.spend,0)::text spend,
         coalesce(d.declared_revenue,0)::text declared_revenue,
         coalesce(a.attributed_revenue,0)::text attributed_revenue,
         a.attributed_margin::text attributed_margin,
         coalesce(a.linked_orders,0)::text linked_orders,
         coalesce(e.eligible_orders,0)::text eligible_orders
       FROM currencies c LEFT JOIN media m USING(currency) LEFT JOIN declared d USING(currency)
       LEFT JOIN attributed a USING(currency) LEFT JOIN eligible e USING(currency)
       ORDER BY c.currency`, [tenantId,
         (process.env.META_PURCHASE_ACTION_TYPES??'purchase,omni_purchase,offsite_conversion.fb_pixel_purchase')
           .split(',').map(value=>value.trim()).filter(Boolean)],
    );
    return result.rows.map(row => {
      const spend = BigInt(row.spend);
      const declared = BigInt(row.declared_revenue);
      const eligible = Number(row.eligible_orders);
      return {
        currency: row.currency, spendCents: spend, declaredRevenueCents: declared,
        declaredRoas: spend > 0n ? Number(declared) / Number(spend) : null,
        attributedNetRevenueCents: BigInt(row.attributed_revenue),
        attributedMarginAfterMediaCents: row.attributed_margin === null ? null : BigInt(row.attributed_margin) - spend,
        coverage: eligible > 0 ? Number(row.linked_orders) / eligible : null,
        warning: 'Atribuição observacional baseada em evidências disponíveis; não representa causalidade ou incrementalidade.',
      };
    });
  });
}

export function safeMetaError(error: unknown): string {
  return redactSecrets(error);
}
