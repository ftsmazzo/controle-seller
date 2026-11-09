import { PgBoss } from 'pg-boss';

let instance: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function queue(): Promise<PgBoss> {
  if (instance) return instance;
  if (starting) return starting;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória.');
  starting = (async () => {
    const boss = new PgBoss({
      connectionString, schema: 'pgboss', createSchema: false, migrate: false,
      application_name: 'controle-seller-app-queue',
    });
    await boss.start();
    instance = boss;
    return boss;
  })().finally(() => { starting = undefined; });
  return starting;
}

export interface NuvemshopJob {
  tenantId: string;
  integrationId: string;
  resource: 'products' | 'orders' | 'webhook' | 'resource' | 'registration';
  mode: 'backfill' | 'incremental' | 'webhook';
  externalId?: string;
  inboxId?: string;
}
export async function enqueueNuvemshop(job: NuvemshopJob): Promise<string> {
  const id = await (await queue()).send('nuvemshop.sync', job, {
    singletonKey: job.integrationId,
    retryLimit: 8,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    deadLetter: 'nuvemshop.dead-letter',
  });
  if (!id) throw new Error(`Fila Nuvemshop recusou o job da integração ${job.integrationId}.`);
  return id;
}

export interface MetaJob {
  tenantId: string;
  integrationId: string;
  mode: 'backfill' | 'daily';
}
export async function enqueueMeta(job: MetaJob): Promise<string> {
  const id = await (await queue()).send('meta.sync', job, {
    singletonKey: job.integrationId,
    retryLimit: 8,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    deadLetter: 'meta.dead-letter',
  });
  if (!id) throw new Error(`Fila Meta recusou o job da integração ${job.integrationId}.`);
  return id;
}

export interface CostRecalculationJob {
  tenantId: string;
  variantId: string;
  costVersionId: string;
  sku: string;
  effectiveAt: string;
  integrationId: string | null;
}

export async function enqueueCostRecalculation(job: CostRecalculationJob): Promise<string> {
  const id = await (await queue()).send('cost.recalculate', job, {
    singletonKey: `${job.costVersionId}:${job.effectiveAt}`,
    retryLimit: 8,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    deadLetter: 'cost.dead-letter',
  });
  if (!id) throw new Error(`Fila recusou o recálculo do custo ${job.costVersionId}; tente novamente.`);
  return id;
}

export interface ForecastJob {
  tenantId: string;
  horizonDays: 30 | 60 | 90;
  outboxId?: string;
}

export async function enqueueForecast(job: ForecastJob): Promise<string> {
  const id = await (await queue()).send('forecast.compute', job, {
    singletonKey: job.tenantId,
    retryLimit: 5,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
    deadLetter: 'forecast.dead-letter',
  });
  if (!id) throw new Error(`Fila recusou o forecast do tenant ${job.tenantId}.`);
  return id;
}
