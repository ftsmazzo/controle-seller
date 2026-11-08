import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { z } from 'zod';

const scrypt = promisify(nodeScrypt);
export type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
export type Permission = 'tenant:manage' | 'members:read' | 'members:write' | 'catalog:read' | 'catalog:write' | 'finance:read';
const permissions: Record<Role, readonly Permission[]> = {
  owner: ['tenant:manage', 'members:read', 'members:write', 'catalog:read', 'catalog:write', 'finance:read'],
  admin: ['members:read', 'members:write', 'catalog:read', 'catalog:write', 'finance:read'],
  analyst: ['members:read', 'catalog:read', 'catalog:write', 'finance:read'],
  viewer: ['members:read', 'catalog:read', 'finance:read'],
};
export function can(role: Role, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
export function assertPermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError();
}
export class ForbiddenError extends Error {
  constructor(message = 'Você não tem permissão para realizar esta ação.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

const mutationWindows = new Map<string, { count: number; resetAt: number }>();
export function guardMutation(request: Request, key: string, limit = 30): void {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) {
    throw new ForbiddenError('Origem da solicitação inválida.');
  }
  const declared = request.headers.get('content-length');
  const length = declared === null ? 0 : Number(declared);
  if (!Number.isFinite(length) || length < 0 || length > 64_000) throw new ForbiddenError('Solicitação acima do limite.');
  const now = Date.now();
  const current = mutationWindows.get(key);
  const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
  window.count += 1;
  mutationWindows.set(key, window);
  if (mutationWindows.size > 10_000) {
    for (const [storedKey,stored] of mutationWindows) {
      if (stored.resetAt <= now) mutationWindows.delete(storedKey);
    }
    if (mutationWindows.size > 10_000) throw new ForbiddenError('Limite global de solicitações atingido.');
  }
  if (window.count > limit) throw new ForbiddenError('Muitas solicitações. Aguarde um minuto.');
}
export async function readLimitedBody(request: Request, maxBytes = 64_000): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) throw new ForbiddenError('Solicitação acima do limite.');
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ForbiddenError('Solicitação acima do limite.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}
export async function readLimitedFormData(request:Request,maxBytes=64_000):Promise<FormData> {
  const raw = await readLimitedBody(request,maxBytes);
  const contentType = request.headers.get('content-type');
  return new Request('http://local.invalid',{
    method:'POST',...(contentType ? {headers:{'content-type':contentType}} : {}),body:new Uint8Array(raw),
  }).formData();
}
export async function readLimitedJson(request:Request,maxBytes=64_000):Promise<unknown> {
  const raw = await readLimitedBody(request,maxBytes);
  return JSON.parse(raw.toString('utf8')) as unknown;
}
export function requestIp(request: Request): string {
  if (process.env.TRUST_PROXY !== 'true') return 'untrusted-proxy';
  return (request.headers.get('x-forwarded-for')?.split(',')[0] ?? request.headers.get('x-real-ip') ?? 'unknown').trim();
}

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(200)
  .regex(/[a-z]/, 'Inclua uma letra minúscula.')
  .regex(/[A-Z]/, 'Inclua uma letra maiúscula.')
  .regex(/[0-9]/, 'Inclua um número.');
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) }).strict();
export const tenantSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
export const productSchema = z.object({
  name: z.string().trim().min(2).max(180),
  sku: z.string().trim().min(1).max(100),
}).strict();

const databaseUrl = process.env.DATABASE_URL;
const isProductionBuild = process.env.NEXT_PHASE === 'phase-production-build';
if (process.env.NODE_ENV === 'production' && !isProductionBuild) {
  if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória em produção.');
  const expectedRole = process.env.APP_DATABASE_ROLE;
  if (!expectedRole) throw new Error('APP_DATABASE_ROLE é obrigatória em produção.');
  if (process.env.TRUST_PROXY !== 'true') {
    throw new Error('TRUST_PROXY=true é obrigatório em produção para rate limit por IP.');
  }
  const configuredRole = decodeURIComponent(new URL(databaseUrl).username);
  if (!configuredRole || configuredRole !== expectedRole) {
    throw new Error('DATABASE_URL deve autenticar exatamente como APP_DATABASE_ROLE.');
  }
}
const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  application_name: 'controle-seller-app',
});
export function databasePool(): Pool { return pool; }
let databaseSafety: Promise<void> | undefined;
export function ensureSafeDatabaseRole(): Promise<void> {
  if (!databaseSafety) databaseSafety = pool.query<{
    rolname:string; rolsuper:boolean; rolbypassrls:boolean;
  }>(`SELECT r.rolname,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`).then(result => {
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error('Conexão da aplicação recusada: role superuser/BYPASSRLS.');
    }
    if (process.env.NODE_ENV === 'production' && role.rolname !== process.env.APP_DATABASE_ROLE) {
      throw new Error('Role efetiva diverge de APP_DATABASE_ROLE.');
    }
  }).catch(error => {
    databaseSafety = undefined;
    throw error;
  });
  return databaseSafety;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
}
export async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSafeDatabaseRole();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function withTenant<T>(
  tenantId: string,
  userId: string,
  fn: (client: PoolClient, context: TenantContext) => Promise<T>,
): Promise<T> {
  return inTransaction(async client => {
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenantId, userId]);
    const result = await client.query<{ role: Role }>(
      'SELECT role FROM seller.memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    const membership = result.rows[0];
    if (!membership) throw new ForbiddenError('Acesso à empresa não autorizado.');
    return fn(client, { tenantId, userId, role: membership.role });
  });
}
export async function audit(
  client: Queryable,
  context: TenantContext,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO seller.audit_log
      (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [context.tenantId, context.userId, action, resourceType, resourceId ?? null, metadata],
  );
}

export async function hashPassword(password: string): Promise<string> {
  passwordSchema.parse(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$v1$${salt.toString('base64')}$${derived.toString('base64')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, salt64, hash64] = encoded.split('$');
  if (algorithm !== 'scrypt' || version !== 'v1' || !salt64 || !hash64) return false;
  const expected = Buffer.from(hash64, 'base64');
  const actual = await scrypt(password, Buffer.from(salt64, 'base64'), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function sessionToken(): { raw: string; hash: Buffer } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: createHash('sha256').update(raw).digest() };
}
export function sessionHash(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export interface Ciphertext {
  keyVersion: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  aadVersion?: 1 | 2;
}
export interface CredentialContext {
  tenantId: string;
  provider: string;
  integrationId: string;
}
function keyring(): Record<string, Buffer> {
  const parsed = z.record(z.string(), z.string()).parse(JSON.parse(process.env.CREDENTIAL_KEYS ?? '{}'));
  return Object.fromEntries(Object.entries(parsed).map(([version, value]) => {
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`Chave ${version} deve ter 32 bytes.`);
    return [version, key];
  }));
}
function credentialAad(context: CredentialContext, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify({
    tenant: context.tenantId, provider: context.provider, integration: context.integrationId,
    envelope: 2, key: keyVersion,
  }), 'utf8');
}
export function encryptCredential(value: unknown, context?: CredentialContext): Ciphertext {
  const keyVersion = process.env.ACTIVE_CREDENTIAL_KEY_VERSION;
  if (!keyVersion) throw new Error('ACTIVE_CREDENTIAL_KEY_VERSION não configurada.');
  const key = keyring()[keyVersion];
  if (!key) throw new Error(`Chave ativa ${keyVersion} não encontrada.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (context) cipher.setAAD(credentialAad(context, keyVersion));
  else if (process.env.NODE_ENV === 'production') throw new Error('Contexto AAD da credencial é obrigatório.');
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { keyVersion, iv, authTag: cipher.getAuthTag(), ciphertext, aadVersion: context ? 2 : 1 };
}
export function decryptCredential(value: Ciphertext, context?: CredentialContext): unknown {
  const key = keyring()[value.keyVersion];
  if (!key) throw new Error(`Chave histórica ${value.keyVersion} não encontrada.`);
  const decipher = createDecipheriv('aes-256-gcm', key, value.iv);
  const aadVersion = value.aadVersion ?? 1;
  if (aadVersion === 2) {
    if (!context) throw new Error('Contexto AAD ausente para envelope v2.');
    decipher.setAAD(credentialAad(context, value.keyVersion));
  } else if (process.env.ALLOW_LEGACY_CREDENTIAL_ENVELOPES !== 'true' && process.env.NODE_ENV === 'production') {
    throw new Error('Envelope legado de credencial recusado.');
  }
  decipher.setAuthTag(value.authTag);
  return JSON.parse(Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8'));
}

export function redactSecrets(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? 'Erro desconhecido');
  return message
    .replace(/([?&](?:access_token|appsecret_proof|client_secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Authorization\s*:\s*(?:Bearer|OAuth2?)\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(?:Bearer|OAuth2?)\s+\S+/gi, match => `${match.split(/\s/, 1)[0]} [redacted]`)
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 1000);
}
