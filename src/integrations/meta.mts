import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const META_API_VERSION = 'v27.0';
export const META_REQUIRED_SCOPE = 'ads_read';
const GRAPH_ORIGIN = 'https://graph.facebook.com';
const AUTH_ORIGIN = 'https://www.facebook.com';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
};

export function metaConfig() {
  const publicUrl = new URL(required('APP_PUBLIC_URL')).origin;
  return {
    appId: required('META_APP_ID'),
    appSecret: required('META_APP_SECRET'),
    configId: required('META_LOGIN_CONFIG_ID'),
    publicUrl,
    redirectUri: `${publicUrl}/api/integrations/meta/callback`,
    redirectAllowlist: new Set((process.env.META_REDIRECT_ALLOWLIST ?? '/configuracoes')
      .split(',').map(value => value.trim()).filter(Boolean)),
    timeoutMs: Math.max(1_000, Number(process.env.META_TIMEOUT_MS ?? 15_000)),
    includeBusinessManagement: process.env.META_INCLUDE_BUSINESS_MANAGEMENT === 'true',
  };
}

export function normalizeMetaRedirect(value: string | null, allowlist: Set<string>): string {
  const candidate = value || '/configuracoes';
  return candidate.startsWith('/') && !candidate.startsWith('//') && allowlist.has(candidate)
    ? candidate : '/configuracoes';
}

export function createMetaOAuthState(): { raw: string; digest: Buffer } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: createHash('sha256').update(raw).digest() };
}
export function metaOAuthStateDigest(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export function metaAuthorizationUrl(state: string): string {
  const config = metaConfig();
  const url = new URL(`/${META_API_VERSION}/dialog/oauth`, AUTH_ORIGIN);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('config_id', config.configId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [
    META_REQUIRED_SCOPE,
    ...(config.includeBusinessManagement ? ['business_management'] : []),
  ].join(','));
  return url.toString();
}

export function appSecretProof(accessToken: string, appSecret = metaConfig().appSecret): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('bearer'),
  expires_in: z.number().int().positive().optional(),
});
export interface MetaCredential {
  accessToken: string;
  tokenType: string;
  expiresAt: string | null;
  scopes: string[];
  metaUserId: string;
}

export async function exchangeMetaAuthorizationCode(code: string, fetcher: typeof fetch = fetch) {
  const config = metaConfig();
  const body = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  const response = await fetcher(`${GRAPH_ORIGIN}/${META_API_VERSION}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw MetaGraphError.fromResponse(response.status, payload);
  const token = tokenSchema.parse(payload);
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1_000).toISOString() : null,
  };
}

export interface MetaRateLimit {
  appUsage: Record<string, unknown> | null;
  adAccountUsage: Record<string, unknown> | null;
  businessUseCaseUsage: Record<string, unknown> | null;
}
export interface MetaPage<T> {
  data: T[];
  paging?: { next?: string };
}
interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean };
}
export class MetaGraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    public readonly subcode: number | null,
    public readonly transient: boolean,
    message = 'A API Meta rejeitou a requisição.',
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }
  static fromResponse(status: number, body: unknown): MetaGraphError {
    const graph = body && typeof body === 'object' ? body as GraphErrorBody : {};
    return new MetaGraphError(
      status, graph.error?.code ?? null, graph.error?.error_subcode ?? null,
      graph.error?.is_transient === true,
      graph.error?.message ? `Meta: ${graph.error.message}` : `Meta HTTP ${status}.`,
    );
  }
}

export interface MetaClientOptions {
  accessToken: string;
  appSecret?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRateLimit?: (usage: MetaRateLimit) => void;
}
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
function jsonHeader(response: Response, name: string): Record<string, unknown> | null {
  const value = response.headers.get(name);
  if (!value) return null;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}
function retryDelay(response: Response, attempt: number, random: () => number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000;
  return Math.min(60_000, 500 * 2 ** attempt) + Math.floor(random() * 500);
}
function isRetryable(status: number, error: MetaGraphError): boolean {
  return status === 429 || status >= 500 || error.transient || error.code === 4 || error.code === 613 || error.code === 190;
}

export class MetaClient {
  private readonly accessToken: string;
  private readonly proof: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onRateLimit: ((usage: MetaRateLimit) => void) | undefined;
  constructor(options: MetaClientOptions) {
    this.accessToken = options.accessToken;
    this.proof = appSecretProof(options.accessToken, options.appSecret);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? metaConfig().timeoutMs;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRateLimit = options.onRateLimit;
  }
  async request<T>(pathOrUrl: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    const url = pathOrUrl.startsWith('https://') ? new URL(pathOrUrl) : new URL(
      `/${META_API_VERSION}/${pathOrUrl.replace(/^\/+/, '')}`, GRAPH_ORIGIN,
    );
    if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith(`/${META_API_VERSION}/`)) {
      throw new Error('URL de paginação fora da Graph API v27.0.');
    }
    if (!pathOrUrl.startsWith('https://')) {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    }
    url.searchParams.delete('access_token');
    url.searchParams.set('appsecret_proof', this.proof);
    for (let attempt = 0; attempt < 5; attempt++) {
      const combined = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetcher(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` }, signal: combined,
      });
      this.onRateLimit?.({
        appUsage: jsonHeader(response, 'x-app-usage'),
        adAccountUsage: jsonHeader(response, 'x-ad-account-usage'),
        businessUseCaseUsage: jsonHeader(response, 'x-business-use-case-usage'),
      });
      const body = await response.json().catch(() => ({})) as unknown;
      if (response.ok) return body as T;
      const error = MetaGraphError.fromResponse(response.status, body);
      if (!isRetryable(response.status, error) || attempt === 4 || (error.code === 190 && attempt >= 1)) throw error;
      await this.sleep(retryDelay(response, attempt, this.random), signal);
    }
    throw new Error('Tentativas Meta esgotadas.');
  }
  async *paginate<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): AsyncGenerator<T[]> {
    let next: string | null = path;
    let first = true;
    while (next) {
      const page: MetaPage<T> = await this.request<MetaPage<T>>(next, first ? params : {}, signal);
      yield page.data;
      next = page.paging?.next ?? null;
      first = false;
    }
  }
}

export interface MetaAdAccount {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
}
export interface MetaEntity {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  campaign_id?: string;
  adset_id?: string;
  updated_time?: string;
}
export interface MetaAction {
  action_type: string;
  value: string;
}
export interface MetaInsight {
  account_id: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  [key: string]: unknown;
}

export function decimalToMetaCents(value: unknown): bigint {
  const text = String(value ?? '0');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('Valor monetário Meta inválido.');
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const mills = BigInt(whole) * 1_000n + BigInt((fraction + '000').slice(0, 3));
  const cents = mills / 10n + (mills % 10n >= 5n ? 1n : 0n);
  return negative ? -cents : cents;
}
export function breakdownHash(breakdowns: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(
    Object.fromEntries(Object.entries(breakdowns).sort(([a], [b]) => a.localeCompare(b))),
  )).digest('hex');
}
export function insightConfigurationHash(configuration: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
