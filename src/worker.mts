import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { processNuvemshopJob, safeError } from './integrations/nuvemshop-store.mjs';
import { processMetaJob, safeMetaError } from './integrations/meta-store.mjs';
import { recalculateAttributionsForVariantPage } from './integrations/attribution.mjs';
import type { CostRecalculationJob, MetaJob, NuvemshopJob } from './server/queue.mjs';

const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL é obrigatória para isolar o papel do worker.');
if (process.env.NODE_ENV === 'production') {
  const expected = process.env.WORKER_DATABASE_ROLE;
  if (!expected) throw new Error('WORKER_DATABASE_ROLE é obrigatória em produção.');
  if (decodeURIComponent(new URL(connectionString).username) !== expected) {
    throw new Error('WORKER_DATABASE_URL deve autenticar exatamente como WORKER_DATABASE_ROLE.');
  }
  if (expected === process.env.APP_DATABASE_ROLE) throw new Error('Roles de app e worker devem ser distintas.');
}
const workerPool = new Pool({
  connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  application_name: 'controle-seller-worker-data',
});
const workerName = process.env.WORKER_NAME ?? `worker-${process.pid}`;
const intervalMs = Math.max(5, Number(process.env.WORKER_HEARTBEAT_SECONDS ?? 15)) * 1000;
const boss = new PgBoss({
  connectionString,
  schema: 'pgboss',
  createSchema: false,
  migrate: false,
  application_name: 'controle-seller-worker',
  instanceName: workerName,
});
let heartbeat: NodeJS.Timeout | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let metaTimer: NodeJS.Timeout | undefined;

async function beat() {
  await workerPool.query(
    `INSERT INTO seller.worker_heartbeats (worker_name, heartbeat_at, metadata)
     VALUES ($1, now(), $2)
     ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at=excluded.heartbeat_at, metadata=excluded.metadata`,
    [workerName, { pid: process.pid }],
  );
}
async function assertSafeWorkerRole() {
  const result = await workerPool.query<{rolname:string;rolsuper:boolean;rolbypassrls:boolean}>(
    `SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error('Conexão do worker recusada: role superuser/BYPASSRLS.');
  }
  if (process.env.NODE_ENV === 'production' && role.rolname !== process.env.WORKER_DATABASE_ROLE) {
    throw new Error('Role efetiva do worker diverge de WORKER_DATABASE_ROLE.');
  }
}
async function recordJobFailure(
  tenantId:string,integrationId:string,message:string,
) {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id',$1,true)`,[tenantId]);
    await client.query(
      `UPDATE seller.integrations SET status='error',last_error=$3
       WHERE tenant_id=$1 AND id=$2 AND disconnected_at IS NULL`,
      [tenantId,integrationId,message],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function pumpNuvemshopRecovery() {
  const pending = await workerPool.query<{ tenant_id:string; integration_id:string; inbox_id:string }>(
    `SELECT * FROM seller.pending_nuvemshop_webhooks(100)`,
  );
  for (const row of pending.rows) {
    await boss.send('nuvemshop.sync', {
      tenantId: row.tenant_id, integrationId: row.integration_id,
      resource: 'webhook', mode: 'webhook', inboxId: row.inbox_id,
    } satisfies NuvemshopJob, {
      singletonKey: row.integration_id,
      retryLimit: 8, retryBackoff: true, deadLetter: 'nuvemshop.dead-letter',
    });
    await workerPool.query(
      `SELECT seller.mark_nuvemshop_webhook_enqueued($1,$2)`,
      [row.tenant_id,row.inbox_id],
    );
  }
  const retries = await workerPool.query<{ tenant_id:string; integration_id:string }>(
    `SELECT * FROM seller.nuvemshop_webhook_retry_candidates(50)`,
  );
  for (const row of retries.rows) {
    await boss.send('nuvemshop.sync', {
      tenantId: row.tenant_id, integrationId: row.integration_id,
      resource: 'registration', mode: 'incremental',
    } satisfies NuvemshopJob, {
      singletonKey: row.integration_id,
      retryLimit: 8, retryBackoff: true, deadLetter: 'nuvemshop.dead-letter',
    });
  }
}
async function pumpMetaDaily() {
  const pending = await workerPool.query<{ tenant_id:string; integration_id:string }>(
    `SELECT * FROM seller.meta_daily_sync_candidates(100)`,
  );
  for (const row of pending.rows) {
    await boss.send('meta.sync', {
      tenantId: row.tenant_id, integrationId: row.integration_id, mode: 'daily',
    } satisfies MetaJob, {
      singletonKey: row.integration_id,
      retryLimit: 8, retryBackoff: true, deadLetter: 'meta.dead-letter',
    });
  }
}
async function pumpCostRecalculations() {
  const pending = await workerPool.query<{
    tenant_id:string;cost_version_id:string;payload:CostRecalculationJob;
  }>(`SELECT * FROM seller.pending_cost_recalculations(100)`);
  for (const row of pending.rows) {
    const id = await boss.send('cost.recalculate', row.payload, {
      singletonKey: `${row.payload.tenantId}:${row.payload.variantId}`,
      retryLimit: 8,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      deadLetter: 'cost.dead-letter',
    });
    if (!id) throw new Error(`Fila recusou recuperação do custo ${row.cost_version_id}.`);
    await workerPool.query(
      `SELECT seller.mark_cost_recalculation_enqueued($1,$2,$3)`,
      [row.tenant_id,row.cost_version_id,id],
    );
  }
}
async function main() {
  await assertSafeWorkerRole();
  await boss.start();
  await boss.work<Record<string, unknown>>('sync.generic', { batchSize: 1 }, async jobs => {
    for (const job of jobs) {
      console.info(JSON.stringify({ event: 'job.received', id: job.id, name: job.name }));
    }
  });
  await boss.work<NuvemshopJob>('nuvemshop.sync', { batchSize: 1, pollingIntervalSeconds: 1 }, async jobs => {
    for (const job of jobs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Job excedeu 14 minutos.')), 14 * 60_000);
      try {
        await processNuvemshopJob(workerPool, job.data, controller.signal);
        if (job.data.resource === 'products' || job.data.resource === 'orders') {
          await boss.send('nuvemshop.sync', { ...job.data, mode: 'incremental' }, {
            startAfter: new Date(Date.now() + 5 * 60_000),
            singletonKey: job.data.integrationId,
            retryLimit: 8,
            retryBackoff: true,
            deadLetter: 'nuvemshop.dead-letter',
          });
        }
      } catch (error) {
        const message = safeError(error);
        try { await recordJobFailure(job.data.tenantId,job.data.integrationId,message); }
        catch (recordError) { throw new AggregateError([error,recordError],'Falha do job e do registro de falha.'); }
        throw new Error(message);
      } finally {
        clearTimeout(timeout);
      }
    }
  });
  await boss.work<NuvemshopJob>('nuvemshop.dead-letter', { batchSize: 1 }, async jobs => {
    for (const job of jobs) {
      const client = await workerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [job.data.tenantId]);
        await client.query(
          `INSERT INTO seller.dead_letters(tenant_id,kind,payload,error)
           VALUES($1,'nuvemshop.sync',$2,$3)`,
          [job.data.tenantId, job.data, 'Tentativas do job Nuvemshop esgotadas.'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  });
  await boss.work<MetaJob>('meta.sync', { batchSize: 1, pollingIntervalSeconds: 2 }, async jobs => {
    for (const job of jobs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Job Meta excedeu 29 minutos.')), 29 * 60_000);
      try {
        await processMetaJob(workerPool, job.data, controller.signal);
      } catch (error) {
        const message = safeMetaError(error);
        try { await recordJobFailure(job.data.tenantId,job.data.integrationId,message); }
        catch (recordError) { throw new AggregateError([error,recordError],'Falha do job e do registro de falha.'); }
        throw new Error(message);
      } finally {
        clearTimeout(timeout);
      }
    }
  });
  await boss.work<MetaJob>('meta.dead-letter', { batchSize: 1 }, async jobs => {
    for (const job of jobs) {
      const client = await workerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [job.data.tenantId]);
        await client.query(
          `INSERT INTO seller.dead_letters(tenant_id,kind,payload,error)
           VALUES($1,'meta.sync',$2,$3)`,
          [job.data.tenantId, job.data, 'Tentativas do job Meta esgotadas.'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  });
  await boss.work<CostRecalculationJob>(
    'cost.recalculate',
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async jobs => {
      for (const job of jobs) {
        let afterOrderId: string | null = null;
        do {
          if (job.signal.aborted) throw job.signal.reason ?? new Error('Recálculo de custo cancelado.');
          const client = await workerPool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [job.data.tenantId]);
            const page = await recalculateAttributionsForVariantPage(client, {
              ...job.data,
              effectiveAt: new Date(job.data.effectiveAt),
              afterOrderId,
              limit: 100,
            });
            afterOrderId = page.nextOrderId;
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        } while (afterOrderId);
      }
    },
  );
  await boss.work<CostRecalculationJob>('cost.dead-letter', { batchSize: 1 }, async jobs => {
    for (const job of jobs) {
      const client = await workerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [job.data.tenantId]);
        await client.query(
          `INSERT INTO seller.dead_letters(tenant_id,kind,payload,error)
           VALUES($1,'cost.recalculate',$2,$3)`,
          [job.data.tenantId,job.data,'Tentativas do recálculo de custo esgotadas.'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  });
  await beat();
  heartbeat = setInterval(() => void beat().catch(error => console.error('heartbeat', error)), intervalMs);
  await pumpNuvemshopRecovery();
  await pumpMetaDaily();
  await pumpCostRecalculations();
  recoveryTimer = setInterval(
    () => void Promise.all([pumpNuvemshopRecovery(),pumpCostRecalculations()])
      .catch(error => console.error('worker.recovery', safeError(error))),
    30_000,
  );
  metaTimer = setInterval(
    () => void pumpMetaDaily().catch(error => console.error('meta.daily', safeMetaError(error))),
    60 * 60_000,
  );
  console.info(JSON.stringify({ event: 'worker.ready', workerName }));
}
async function stop(signal: string) {
  console.info(JSON.stringify({ event: 'worker.stopping', signal }));
  if (heartbeat) clearInterval(heartbeat);
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (metaTimer) clearInterval(metaTimer);
  await boss.stop({ graceful: true });
  await workerPool.end();
  process.exit(0);
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
main().catch(error => { console.error(error); process.exit(1); });
