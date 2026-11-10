import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

const configuredConnectionString = process.env.DATABASE_ADMIN_URL
  ?? process.env.DATABASE_URL
  ?? process.env.WORKER_DATABASE_URL;
if (!configuredConnectionString) {
  throw new Error('DATABASE_ADMIN_URL, DATABASE_URL ou WORKER_DATABASE_URL é obrigatória para migrate.');
}
const connectionString: string = configuredConnectionString;
const pool = new Pool({ connectionString, max: 1, application_name: 'controle-seller-migrate' });
const migrateSource = process.env.DATABASE_ADMIN_URL
  ? 'DATABASE_ADMIN_URL'
  : process.env.DATABASE_URL
    ? 'DATABASE_URL'
    : 'WORKER_DATABASE_URL';
console.info(JSON.stringify({
  event: 'migrate.boot',
  source: migrateSource,
  hasAdminUrl: Boolean(process.env.DATABASE_ADMIN_URL),
  migrationsDir: path.resolve('migrations'),
}));
if (!process.env.DATABASE_ADMIN_URL) {
  console.warn(JSON.stringify({
    event: 'migrate.warning',
    message: 'DATABASE_ADMIN_URL ausente. Sem ela o migrate usa a role da app/worker e pode falhar em DDL (schema public/seller).',
  }));
}

function permissionDeniedMessage(error: unknown): string {
  const err = error as { code?: string; message?: string };
  if (err?.code !== '42501') return err?.message ?? String(error);
  return [
    'Permissão insuficiente para migrar o banco.',
    'No EasyPanel, defina DATABASE_ADMIN_URL com a connection string do usuário dono do Postgres',
    '(o usuário root/admin do serviço de banco, não a role APP_DATABASE_ROLE/WORKER_DATABASE_ROLE).',
    `Detalhe: ${err.message ?? 'permission denied'}`,
  ].join(' ');
}

async function ensureSchemaMigrationsTable(client: import('pg').PoolClient): Promise<void> {
  // CREATE TABLE IF NOT EXISTS exige CREATE no schema mesmo se a tabela já existe (PG 15+).
  const existing = await client.query<{ id: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS id`,
  );
  if (existing.rows[0]?.id) return;
  try {
    await client.query(`CREATE TABLE public.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (error) {
    throw new Error(permissionDeniedMessage(error));
  }
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('APP_DATABASE_ROLE inválida.');
  return `"${value}"`;
}
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

async function configureRole() {
  const name = process.env.APP_DATABASE_ROLE;
  const password = process.env.APP_DATABASE_ROLE_PASSWORD;
  if (!name) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_DATABASE_ROLE é obrigatória em produção.');
    return;
  }
  const role = identifier(name);
  const passwordClause = password ? ` PASSWORD ${literal(password)}` : '';
  await pool.query(`DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(name)}) THEN
      CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS${passwordClause};
    ELSE
      ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS${passwordClause};
    END IF;
  END $do$`);
  await pool.query(`REVOKE ALL ON SCHEMA seller,pgboss FROM ${role};
    REVOKE ALL ON ALL TABLES IN SCHEMA seller,pgboss FROM ${role};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA seller,pgboss FROM ${role};
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA seller,pgboss FROM ${role};
    GRANT USAGE ON SCHEMA seller,pgboss TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON
      seller.users,seller.sessions,seller.login_attempts,seller.tenants,seller.memberships,seller.products,seller.variants,
      seller.cost_versions,seller.cost_channel_versions,seller.integrations,seller.oauth_credentials,
      seller.oauth_states,seller.integration_webhooks,seller.orders,seller.order_lines,seller.order_events,
      seller.expenses,seller.webhook_inbox,seller.ad_accounts,seller.ad_campaigns,seller.ad_sets,seller.ads,
      seller.ad_insight_facts,seller.platform_conversions,seller.attribution_models,
      seller.marketing_touchpoints,seller.attribution_links,seller.data_quality_issues,
      seller.recommendations,seller.calculation_versions,seller.audit_log,seller.platform_oauth_apps,
      seller.daily_store_metrics,seller.forecast_runs,seller.forecast_points,seller.forecast_evals,
      seller.forecast_job_outbox TO ${role};
    GRANT SELECT,INSERT,DELETE ON seller.meta_account_candidates TO ${role};
    GRANT SELECT,INSERT,UPDATE ON seller.cost_recalculation_outbox TO ${role};
    GRANT SELECT ON seller.worker_heartbeats TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA seller TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON pgboss.version,pgboss.queue,pgboss.schedule,
      pgboss.subscription,pgboss.bam,pgboss.warning,pgboss.job_dependency,pgboss.instance,
      pgboss.job,pgboss.job_common,pgboss.queue_stats TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${role};
    GRANT EXECUTE ON FUNCTION seller.current_tenant(),seller.current_user_id(),
      seller.list_user_tenants(),seller.ingest_nuvemshop_webhook(bytea,text,jsonb,jsonb,bytea),
      seller.mark_nuvemshop_webhook_enqueued(uuid,uuid) TO ${role};`);
  await pool.query(`GRANT EXECUTE ON FUNCTION pgboss.job_now() TO ${role}`);
}
async function configureWorkerRole() {
  const name = process.env.WORKER_DATABASE_ROLE;
  const password = process.env.WORKER_DATABASE_ROLE_PASSWORD;
  if (!name) return;
  if (name === process.env.APP_DATABASE_ROLE) throw new Error('WORKER_DATABASE_ROLE deve ser diferente de APP_DATABASE_ROLE.');
  const role = identifier(name);
  const passwordClause = password ? ` PASSWORD ${literal(password)}` : '';
  await pool.query(`DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(name)}) THEN
      CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS${passwordClause};
    ELSE
      ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS${passwordClause};
    END IF;
  END $do$`);
  await pool.query(`REVOKE ALL ON SCHEMA seller,pgboss FROM ${role};
    REVOKE ALL ON ALL TABLES IN SCHEMA seller,pgboss FROM ${role};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA seller,pgboss FROM ${role};
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA seller,pgboss FROM ${role};
    GRANT USAGE ON SCHEMA seller,pgboss TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON
      seller.products,seller.variants,seller.cost_versions,seller.cost_channel_versions,
      seller.cost_recalculation_outbox,
      seller.integrations,seller.oauth_credentials,seller.integration_webhooks,seller.orders,
      seller.order_lines,seller.order_events,seller.webhook_inbox,seller.sync_cursors,
      seller.sync_runs,seller.dead_letters,seller.ad_accounts,seller.ad_campaigns,seller.ad_sets,
      seller.ads,seller.ad_insight_facts,seller.platform_conversions,seller.attribution_models,
      seller.marketing_touchpoints,seller.attribution_links,seller.data_quality_issues,
      seller.recommendations,seller.calculation_versions,seller.audit_log,seller.worker_heartbeats,
      seller.platform_oauth_apps,seller.daily_store_metrics,seller.forecast_runs,
      seller.forecast_points,seller.forecast_evals,seller.forecast_job_outbox TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON pgboss.version,pgboss.queue,pgboss.schedule,
      pgboss.subscription,pgboss.bam,pgboss.warning,pgboss.job_dependency,pgboss.instance,
      pgboss.job,pgboss.job_common,pgboss.queue_stats TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA seller TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${role};
    GRANT EXECUTE ON FUNCTION seller.current_tenant(),seller.current_user_id(),
      seller.pending_nuvemshop_webhooks(integer),seller.nuvemshop_webhook_retry_candidates(integer),
      seller.mark_nuvemshop_webhook_enqueued(uuid,uuid),seller.meta_daily_sync_candidates(integer),
      seller.pending_cost_recalculations(integer),
      seller.mark_cost_recalculation_enqueued(uuid,uuid,uuid),
      seller.pending_forecast_jobs(integer),seller.mark_forecast_job_enqueued(uuid,uuid),
      seller.forecast_weekly_candidates(integer) TO ${role};`);
  await pool.query(`GRANT EXECUTE ON FUNCTION pgboss.job_now() TO ${role}`);
}
async function installQueue() {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'controle-seller-migrate' });
  await boss.start();
  await boss.createQueue('sync.dead-letter');
  await boss.createQueue('sync.generic', { retryLimit: 5, retryBackoff: true, deadLetter: 'sync.dead-letter' });
  await boss.createQueue('nuvemshop.dead-letter');
  await boss.createQueue('nuvemshop.sync', {
    policy: 'key_strict_fifo', retryLimit: 8, retryBackoff: true, deadLetter: 'nuvemshop.dead-letter',
  });
  await boss.createQueue('meta.dead-letter');
  await boss.createQueue('meta.sync', {
    policy: 'key_strict_fifo', retryLimit: 8, retryBackoff: true, deadLetter: 'meta.dead-letter',
  });
  await boss.createQueue('cost.dead-letter');
  await boss.createQueue('cost.recalculate', {
    policy: 'key_strict_fifo', retryLimit: 8, retryBackoff: true, deadLetter: 'cost.dead-letter',
  });
  await boss.createQueue('forecast.dead-letter');
  await boss.createQueue('forecast.compute', {
    policy: 'key_strict_fifo', retryLimit: 5, retryBackoff: true, deadLetter: 'forecast.dead-letter',
  });
  await boss.stop({ graceful: true });
  await pool.query(
    `UPDATE pgboss.queue SET policy='key_strict_fifo',updated_on=now()
     WHERE name=ANY($1::text[]) AND policy<>'key_strict_fifo'`,
    [['nuvemshop.sync','meta.sync','cost.recalculate','forecast.compute']],
  );
}
async function main() {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended('controle-seller:migrations',0))`);
    await ensureSchemaMigrationsTable(client);
    const directory = path.resolve('migrations');
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await client.query('BEGIN');
      try {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('controle-seller:migrations',0))`);
        const existing = await client.query<{ checksum: string }>(
          'SELECT checksum FROM public.schema_migrations WHERE name=$1 FOR UPDATE', [file],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Migração aplicada foi alterada: ${file}`);
          await client.query('COMMIT');
          console.info(`já aplicada: ${file}`);
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations(name, checksum) VALUES ($1,$2)', [file, checksum]);
        await client.query('COMMIT');
        console.info(`aplicada: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${permissionDeniedMessage(error)}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtextextended('controle-seller:migrations',0))`).catch(() => undefined);
    client.release();
  }
  await installQueue();
  await configureRole();
  await configureWorkerRole();
}
main().finally(() => pool.end()).catch(error => {
  console.error(JSON.stringify({
    event: 'migrate.failed',
    message: error instanceof Error ? error.message : String(error),
  }));
  console.error(error);
  process.exitCode = 1;
});
