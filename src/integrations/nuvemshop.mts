import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const NUVEMSHOP_API_VERSION = '2025-03';
export const NUVEMSHOP_SCOPES = ['read_products', 'read_orders'] as const;
export const NUVEMSHOP_TOPICS = [
  'app/uninstalled', 'app/suspended', 'app/resumed',
  'product/created', 'product/updated', 'product/deleted',
  'order/created', 'order/updated', 'order/paid', 'order/cancelled',
  'customer/data_request', 'customer/redact', 'store/redact',
] as const;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
};
export function nuvemshopConfig() {
  return {
    appId: required('NUVEMSHOP_APP_ID'),
    clientSecret: required('NUVEMSHOP_CLIENT_SECRET'),
    userAgent: required('NUVEMSHOP_USER_AGENT'),
    publicUrl: new URL(required('APP_PUBLIC_URL')).origin,
    redirectAllowlist: new Set((process.env.NUVEMSHOP_REDIRECT_ALLOWLIST ?? '/configuracoes')
      .split(',').map(value => value.trim()).filter(Boolean)),
    timeoutMs: Math.max(1_000, Number(process.env.NUVEMSHOP_TIMEOUT_MS ?? 10_000)),
  };
}

export function createOAuthState(): { raw: string; digest: Buffer } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: createHash('sha256').update(raw).digest() };
}
export function oauthStateDigest(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}
export function normalizeRedirect(value: string | null, allowlist: Set<string>): string {
  const candidate = value || '/configuracoes';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || !allowlist.has(candidate)) return '/configuracoes';
  return candidate;
}
export function authorizationUrl(state: string): string {
  const { appId } = nuvemshopConfig();
  return `https://www.nuvemshop.com.br/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).transform(String),
});
export type NuvemshopCredential = { accessToken: string; storeId: string; scopes: string[] };
export async function exchangeAuthorizationCode(code: string, fetcher: typeof fetch = fetch): Promise<NuvemshopCredential> {
  const config = nuvemshopConfig();
  const response = await fetcher('https://www.nuvemshop.com.br/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
    body: JSON.stringify({ client_id: config.appId, client_secret: config.clientSecret, grant_type: 'authorization_code', code }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new NuvemshopHttpError(response.status, `Falha ao autorizar loja (${response.status}).`);
  const value = tokenSchema.parse(await response.json());
  const scopes = (value.scope ?? NUVEMSHOP_SCOPES.join(',')).split(/[\s,]+/).filter(Boolean);
  for (const scope of NUVEMSHOP_SCOPES) if (!scopes.includes(scope)) throw new Error(`Escopo obrigatório ausente: ${scope}.`);
  return { accessToken: value.access_token, storeId: value.user_id, scopes };
}

export function verifyWebhookHmac(rawBody: Buffer, received: string | null, secret = nuvemshopConfig().clientSecret): boolean {
  if (!received) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(received.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class NuvemshopHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'NuvemshopHttpError';
  }
}
export interface NuvemshopClientOptions {
  storeId: string;
  accessToken: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  random?: () => number;
}
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
function retryAfter(response: Response, attempt: number, random: () => number): number {
  const explicit = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-rate-limit-reset'));
  if (Number.isFinite(explicit) && explicit >= 0) return explicit * 1_000;
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - Date.now());
  return Math.min(8_000, 250 * 2 ** attempt) + Math.floor(random() * 250);
}
function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match?.[1]) return match[1];
  }
  return null;
}
export class NuvemshopClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly random: () => number;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimes: number[] = [];
  private blockedUntil = 0;
  constructor(options: NuvemshopClientOptions) {
    const config = nuvemshopConfig();
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.random = options.random ?? Math.random;
    this.base = `https://api.nuvemshop.com.br/${NUVEMSHOP_API_VERSION}/${encodeURIComponent(options.storeId)}`;
    this.headers = { Authorization: `Bearer ${options.accessToken}`, 'User-Agent': config.userAgent, Accept: 'application/json' };
  }
  async request<T>(pathOrUrl: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ data: T; next: string | null }> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${this.base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    if (!url.startsWith(`${this.base}/`)) throw new Error('URL de paginação fora da API Nuvemshop.');
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.throttle(signal);
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetcher(url, { ...init, headers: { ...this.headers, ...init.headers }, signal: combined });
      const remaining = Number(response.headers.get('x-rate-limit-remaining'));
      const reset = Number(response.headers.get('x-rate-limit-reset'));
      if (remaining === 0 && Number.isFinite(reset)) this.blockedUntil = Math.max(this.blockedUntil, reset * 1_000);
      if (response.ok) {
        const data = response.status === 204 ? undefined as T : await response.json() as T;
        return { data, next: nextLink(response.headers.get('link')) };
      }
      if (response.status !== 429 && response.status < 500) throw new NuvemshopHttpError(response.status, `Nuvemshop rejeitou a requisição (${response.status}).`);
      const wait = retryAfter(response, attempt, this.random);
      if (attempt === 4) throw new NuvemshopHttpError(response.status, `Nuvemshop indisponível após tentativas (${response.status}).`, wait);
      await delay(wait, signal);
    }
    throw new Error('Tentativas esgotadas.');
  }
  private async throttle(signal?: AbortSignal) {
    const now = Date.now();
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= now - 2_000) this.requestTimes.shift();
    const bucketWait = this.requestTimes.length >= 40 ? this.requestTimes[0]! + 2_000 - now : 0;
    const wait = Math.max(0, bucketWait, this.blockedUntil - now);
    if (wait > 0) await delay(wait + Math.floor(this.random() * 100), signal);
    this.requestTimes.push(Date.now());
  }
  async *paginate<T>(path: string, signal?: AbortSignal): AsyncGenerator<T[]> {
    let next: string | null = path;
    while (next) {
      const page: { data: T[]; next: string | null } = await this.request<T[]>(next, {}, signal);
      yield page.data;
      next = page.next;
    }
  }
  get<T>(path: string, signal?: AbortSignal) { return this.request<T>(path, {}, signal).then(value => value.data); }
  post<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)
      .then(value => value.data);
  }
  delete(path: string, signal?: AbortSignal) {
    return this.request<unknown>(path, { method: 'DELETE' }, signal).then(() => undefined);
  }
}

export interface CanonicalVariant {
  externalId: string; sku: string; priceCents: bigint; stock: bigint | null; attributes: Record<string, string>;
}
export interface CanonicalProduct {
  externalId: string; name: string; sourceUpdatedAt: Date; variants: CanonicalVariant[];
  payload: unknown; provenance: { provider: 'nuvemshop'; apiVersion: string; hash: string };
}
export interface CanonicalOrderLine {
  externalId: string; variantExternalId: string | null; sku: string | null; quantity: number;
  unitPriceCents: bigint; discountCents: bigint;
  returnedQuantity: number | null; restockedQuantity: number | null;
}
export interface CanonicalOrder {
  externalId: string; status: 'paid'|'pending'|'cancelled'|'refunded'; placedAt: Date; sourceUpdatedAt: Date;
  currency: string; lines: CanonicalOrderLine[]; financialEvents: CanonicalFinancialEvent[]; payload: unknown;
  returnAllocationKnown: boolean;
  provenance: { provider: 'nuvemshop'; apiVersion: string; hash: string };
}
export interface CanonicalFinancialEvent {
  sourceKey: string;
  kind: 'order_discount'|'shipping'|'refund'|'payment_fee'|'tax'|'packaging'|'cashback'|'other';
  amountCents: bigint;
  direction: -1|1;
  occurredAt: Date;
  payload: unknown;
}
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function decimalToCents(value: unknown): bigint {
  const text = typeof value === 'number' ? String(value) : String(value ?? '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Valor monetário inválido: ${text}`);
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}
const localized = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return String(item.pt ?? item['pt-BR'] ?? item.en ?? Object.values(item)[0] ?? '');
  }
  return '';
};
export function mapProduct(payload: Record<string, unknown>): CanonicalProduct {
  const variants = Array.isArray(payload.variants) ? payload.variants as Array<Record<string, unknown>> : [];
  const updated = String(payload.updated_at ?? payload.created_at);
  return {
    externalId: String(payload.id), name: localized(payload.name), sourceUpdatedAt: new Date(updated), payload,
    variants: variants.map(variant => ({
      externalId: String(variant.id), sku: String(variant.sku ?? `nuvemshop-${variant.id}`),
      priceCents: decimalToCents(variant.price), stock: variant.stock === null || variant.stock === undefined ? null : BigInt(String(variant.stock)),
      attributes: Object.fromEntries((Array.isArray(variant.values) ? variant.values : []).map((item, index) => [String(index), localized(item)])),
    })),
    provenance: { provider: 'nuvemshop', apiVersion: NUVEMSHOP_API_VERSION, hash: hashPayload(payload) },
  };
}
export function mapOrder(payload: Record<string, unknown>): CanonicalOrder {
  const products = Array.isArray(payload.products) ? payload.products as Array<Record<string, unknown>> : [];
  const financial = String(payload.payment_status ?? payload.status ?? '').toLowerCase();
  const status = String(payload.status ?? '').toLowerCase();
  const canonicalStatus = status.includes('refund') || financial.includes('refund')
    ? 'refunded' : status.includes('cancel') ? 'cancelled' : financial === 'paid' ? 'paid' : 'pending';
  const occurredAt = new Date(String(payload.updated_at ?? payload.created_at));
  const financialEvents: CanonicalFinancialEvent[] = [];
  const add = (
    sourceKey:string, kind:CanonicalFinancialEvent['kind'], value:unknown, direction:-1|1, eventPayload:unknown = value,
  ) => {
    if (value === null || value === undefined || value === '') return;
    const amountCents = decimalToCents(value);
    if (amountCents === 0n) return;
    financialEvents.push({ sourceKey, kind, amountCents: amountCents < 0n ? -amountCents : amountCents,
      direction, occurredAt, payload:eventPayload });
  };
  add('order:discount','order_discount',payload.discount ?? payload.total_discount,-1);
  add('order:shipping:customer','shipping',payload.shipping_cost_customer ?? payload.shipping_cost,1);
  add('order:payment_fee','payment_fee',payload.payment_fee ?? payload.gateway_fee,-1);
  add('order:tax','tax',payload.tax ?? payload.tax_amount,-1);
  add('order:packaging','packaging',payload.packaging_cost,-1);
  add('order:cashback','cashback',payload.cashback_amount,-1);
  const refunds = Array.isArray(payload.refunds) ? payload.refunds as Array<Record<string,unknown>> : [];
  refunds.forEach((refund,index) => add(
    `refund:${String(refund.id ?? index)}`,'refund',refund.amount ?? refund.value,-1,refund,
  ));
  const allocation = mapReturnAllocation(products, refunds);
  return {
    externalId: String(payload.id), status: canonicalStatus, placedAt: new Date(String(payload.created_at)),
    sourceUpdatedAt: new Date(String(payload.updated_at ?? payload.created_at)), currency: String(payload.currency ?? 'BRL'),
    lines: products.map((line, index) => ({
      externalId: String(line.id), variantExternalId: line.variant_id == null ? null : String(line.variant_id),
      sku: line.sku == null ? null : String(line.sku), quantity: Number(line.quantity),
      unitPriceCents: decimalToCents(line.price), discountCents: decimalToCents(line.discount ?? '0'),
      returnedQuantity: allocation.lines[index]?.returnedQuantity ?? null,
      restockedQuantity: allocation.lines[index]?.restockedQuantity ?? null,
    })),
    financialEvents, payload, returnAllocationKnown: allocation.known,
    provenance: { provider: 'nuvemshop', apiVersion: NUVEMSHOP_API_VERSION, hash: hashPayload(payload) },
  };
}

function mapReturnAllocation(
  products: Array<Record<string, unknown>>,
  refunds: Array<Record<string, unknown>>,
): { known: boolean; lines: Array<{ returnedQuantity:number|null; restockedQuantity:number|null }> } {
  if (refunds.length === 0) {
    return { known: true, lines: products.map(() => ({ returnedQuantity: 0, restockedQuantity: 0 })) };
  }
  const result = products.map(() => ({ returnedQuantity: 0 as number|null, restockedQuantity: 0 as number|null }));
  const byLine = new Map(products.map((line, index) => [String(line.id), index]));
  const byVariant = new Map<string, number[]>();
  products.forEach((line, index) => {
    if (line.variant_id == null) return;
    const key = String(line.variant_id);
    byVariant.set(key, [...(byVariant.get(key) ?? []), index]);
  });
  let sawAllocation = false;
  let known = true;
  for (const refund of refunds) {
    const items = ['products', 'items', 'line_items', 'refund_items']
      .map(key => refund[key]).find(Array.isArray) as Array<Record<string,unknown>>|undefined;
    if (!items?.length) {
      known = false;
      continue;
    }
    sawAllocation = true;
    for (const item of items) {
      const identifiers = [item.order_product_id,item.line_item_id,item.product_id,item.id]
        .filter(value => value != null).map(String);
      let index = identifiers.map(value => byLine.get(value)).find(value => value !== undefined);
      if (index === undefined && item.variant_id != null) {
        const matches = byVariant.get(String(item.variant_id)) ?? [];
        if (matches.length === 1) index = matches[0];
      }
      const quantity = Number(item.quantity ?? item.refunded_quantity);
      if (index === undefined || !Number.isInteger(quantity) || quantity < 0) {
        known = false;
        continue;
      }
      result[index]!.returnedQuantity = (result[index]!.returnedQuantity ?? 0) + quantity;
      const explicitRestocked = item.restocked_quantity ?? item.restock_quantity;
      if (explicitRestocked != null) {
        const restocked = Number(explicitRestocked);
        if (!Number.isInteger(restocked) || restocked < 0 || restocked > quantity) {
          known = false;
          result[index]!.restockedQuantity = null;
        } else {
          result[index]!.restockedQuantity = (result[index]!.restockedQuantity ?? 0) + restocked;
        }
      } else if (item.restock === true) {
        result[index]!.restockedQuantity = (result[index]!.restockedQuantity ?? 0) + quantity;
      } else if (item.restock === false) {
        result[index]!.restockedQuantity = result[index]!.restockedQuantity ?? 0;
      } else {
        known = false;
        result[index]!.restockedQuantity = null;
      }
    }
  }
  if (!sawAllocation) known = false;
  if (!known) {
    result.forEach(line => {
      line.returnedQuantity = null;
      line.restockedQuantity = null;
    });
  }
  return { known, lines: result };
}
