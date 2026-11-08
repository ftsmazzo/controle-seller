import { z } from 'zod';
import {
  databasePool, decryptCredential, encryptCredential, type Ciphertext, type Queryable,
} from '@/src/server/core.mjs';

export const PLATFORM_PROVIDERS = [
  'nuvemshop', 'meta', 'shopify', 'mercado_livre', 'shopee',
] as const;
export type PlatformProvider = (typeof PLATFORM_PROVIDERS)[number];

export const providerLabels: Record<PlatformProvider, string> = {
  nuvemshop: 'Nuvemshop',
  meta: 'Meta Ads',
  shopify: 'Shopify',
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
};

const settingsSchema = z.record(z.string(), z.unknown()).default({});

export interface PlatformAppRecord {
  provider: PlatformProvider;
  appId: string;
  clientSecret: string;
  settings: Record<string, unknown>;
  updatedAt: Date | null;
  configured: true;
}

export interface PlatformAppStatus {
  provider: PlatformProvider;
  label: string;
  configured: boolean;
  appIdMasked: string | null;
  settings: Record<string, unknown>;
  updatedAt: Date | null;
  callbackUrl: string;
  missing: string[];
}

function publicOrigin(): string {
  const value = process.env.APP_PUBLIC_URL;
  if (!value) throw new Error('APP_PUBLIC_URL é obrigatória.');
  return new URL(value).origin;
}

function platformContext(provider: PlatformProvider) {
  return { tenantId: 'platform', provider, integrationId: 'oauth-app' };
}

function packSecret(secret: string, provider: PlatformProvider): Ciphertext {
  return encryptCredential({ clientSecret: secret }, platformContext(provider));
}

function unpackSecret(row: {
  client_secret_cipher: Buffer; client_secret_iv: Buffer; client_secret_tag: Buffer; key_version: string;
}, provider: PlatformProvider): string {
  const payload = decryptCredential({
    keyVersion: row.key_version,
    iv: row.client_secret_iv,
    authTag: row.client_secret_tag,
    ciphertext: row.client_secret_cipher,
    aadVersion: 2,
  }, platformContext(provider)) as { clientSecret?: string };
  if (!payload?.clientSecret) throw new Error(`Segredo inválido para ${provider}.`);
  return payload.clientSecret;
}

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

async function queryApps(client?: Queryable) {
  const db = client ?? databasePool();
  return db.query<{
    provider: PlatformProvider; app_id: string; client_secret_cipher: Buffer;
    client_secret_iv: Buffer; client_secret_tag: Buffer; key_version: string;
    settings: Record<string, unknown>; updated_at: Date;
  }>(`SELECT provider,app_id,client_secret_cipher,client_secret_iv,client_secret_tag,
      key_version,settings,updated_at FROM seller.platform_oauth_apps`);
}

export async function listPlatformAppStatuses(client?: Queryable): Promise<PlatformAppStatus[]> {
  const rows = await queryApps(client);
  const byProvider = new Map(rows.rows.map(row => [row.provider, row]));
  return PLATFORM_PROVIDERS.map(provider => {
    const row = byProvider.get(provider);
    const settings = settingsSchema.parse(row?.settings ?? {});
    const missing = requiredFields(provider, row?.app_id ?? null, settings, Boolean(row));
    return {
      provider,
      label: providerLabels[provider],
      configured: Boolean(row) && missing.length === 0,
      appIdMasked: mask(row?.app_id),
      settings: publicSettings(provider, settings),
      updatedAt: row?.updated_at ?? null,
      callbackUrl: callbackFor(provider),
      missing,
    };
  });
}

function callbackFor(provider: PlatformProvider): string {
  const origin = publicOrigin();
  if (provider === 'meta') return `${origin}/api/integrations/meta/callback`;
  if (provider === 'nuvemshop') return `${origin}/api/integrations/nuvemshop/callback`;
  if (provider === 'shopify') return `${origin}/api/integrations/shopify/callback`;
  if (provider === 'mercado_livre') return `${origin}/api/integrations/mercado-livre/callback`;
  return `${origin}/api/integrations/shopee/callback`;
}

function publicSettings(provider: PlatformProvider, settings: Record<string, unknown>) {
  if (provider === 'meta') {
    return {
      loginConfigId: typeof settings.loginConfigId === 'string' ? mask(settings.loginConfigId) : null,
      includeBusinessManagement: settings.includeBusinessManagement === true,
    };
  }
  if (provider === 'nuvemshop') {
    return { userAgent: typeof settings.userAgent === 'string' ? settings.userAgent : null };
  }
  if (provider === 'shopify') {
    return { scopes: typeof settings.scopes === 'string' ? settings.scopes : 'read_products,read_orders' };
  }
  if (provider === 'mercado_livre') {
    return { redirectPath: '/configuracoes' };
  }
  if (provider === 'shopee') {
    return {
      partnerId: typeof settings.partnerId === 'string' ? mask(settings.partnerId) : null,
      region: typeof settings.region === 'string' ? settings.region : 'BR',
    };
  }
  return {};
}

function requiredFields(
  provider: PlatformProvider,
  appId: string | null,
  settings: Record<string, unknown>,
  hasSecret: boolean,
): string[] {
  const missing: string[] = [];
  if (!appId) missing.push('App ID');
  if (!hasSecret) missing.push('Client Secret');
  if (provider === 'meta' && typeof settings.loginConfigId !== 'string') missing.push('Login Config ID');
  if (provider === 'nuvemshop' && typeof settings.userAgent !== 'string') missing.push('User-Agent');
  if (provider === 'shopee' && typeof settings.partnerId !== 'string') missing.push('Partner ID');
  return missing;
}

export async function loadPlatformApp(
  provider: PlatformProvider, client?: Queryable,
): Promise<PlatformAppRecord | null> {
  const db = client ?? databasePool();
  const result = await db.query<{
    provider: PlatformProvider; app_id: string; client_secret_cipher: Buffer;
    client_secret_iv: Buffer; client_secret_tag: Buffer; key_version: string;
    settings: Record<string, unknown>; updated_at: Date;
  }>(`SELECT provider,app_id,client_secret_cipher,client_secret_iv,client_secret_tag,
      key_version,settings,updated_at FROM seller.platform_oauth_apps WHERE provider=$1`, [provider]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    provider,
    appId: row.app_id,
    clientSecret: unpackSecret(row, provider),
    settings: settingsSchema.parse(row.settings ?? {}),
    updatedAt: row.updated_at,
    configured: true,
  };
}

const upsertSchema = z.object({
  provider: z.enum(PLATFORM_PROVIDERS),
  appId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(8).max(500),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export async function upsertPlatformApp(
  input: z.infer<typeof upsertSchema>,
  updatedBy: string,
  client?: Queryable,
): Promise<void> {
  const parsed = upsertSchema.parse(input);
  const encrypted = packSecret(parsed.clientSecret, parsed.provider);
  const db = client ?? databasePool();
  await db.query(
    `INSERT INTO seller.platform_oauth_apps
      (provider,app_id,client_secret_cipher,client_secret_iv,client_secret_tag,key_version,settings,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider) DO UPDATE SET
       app_id=excluded.app_id,
       client_secret_cipher=excluded.client_secret_cipher,
       client_secret_iv=excluded.client_secret_iv,
       client_secret_tag=excluded.client_secret_tag,
       key_version=excluded.key_version,
       settings=excluded.settings,
       updated_by=excluded.updated_by,
       updated_at=now()`,
    [
      parsed.provider, parsed.appId, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
      encrypted.keyVersion, parsed.settings, updatedBy,
    ],
  );
}

export async function resolveNuvemshopApp() {
  const envId = process.env.NUVEMSHOP_APP_ID;
  const envSecret = process.env.NUVEMSHOP_CLIENT_SECRET;
  const envAgent = process.env.NUVEMSHOP_USER_AGENT;
  if (envId && envSecret && envAgent) {
    return {
      appId: envId,
      clientSecret: envSecret,
      userAgent: envAgent,
      publicUrl: publicOrigin(),
      redirectAllowlist: new Set((process.env.NUVEMSHOP_REDIRECT_ALLOWLIST ?? '/configuracoes')
        .split(',').map(value => value.trim()).filter(Boolean)),
      timeoutMs: Math.max(1_000, Number(process.env.NUVEMSHOP_TIMEOUT_MS ?? 10_000)),
      source: 'env' as const,
    };
  }
  const stored = await loadPlatformApp('nuvemshop');
  if (!stored || typeof stored.settings.userAgent !== 'string') {
    throw new Error('Configure o aplicativo Nuvemshop em Configurações antes de conectar.');
  }
  return {
    appId: stored.appId,
    clientSecret: stored.clientSecret,
    userAgent: stored.settings.userAgent,
    publicUrl: publicOrigin(),
    redirectAllowlist: new Set(['/configuracoes']),
    timeoutMs: Math.max(1_000, Number(process.env.NUVEMSHOP_TIMEOUT_MS ?? 10_000)),
    source: 'panel' as const,
  };
}

export async function resolveMetaApp() {
  const envId = process.env.META_APP_ID;
  const envSecret = process.env.META_APP_SECRET;
  const envConfig = process.env.META_LOGIN_CONFIG_ID;
  if (envId && envSecret && envConfig) {
    return {
      appId: envId,
      appSecret: envSecret,
      configId: envConfig,
      publicUrl: publicOrigin(),
      redirectUri: `${publicOrigin()}/api/integrations/meta/callback`,
      redirectAllowlist: new Set((process.env.META_REDIRECT_ALLOWLIST ?? '/configuracoes')
        .split(',').map(value => value.trim()).filter(Boolean)),
      timeoutMs: Math.max(1_000, Number(process.env.META_TIMEOUT_MS ?? 15_000)),
      includeBusinessManagement: process.env.META_INCLUDE_BUSINESS_MANAGEMENT === 'true',
      source: 'env' as const,
    };
  }
  const stored = await loadPlatformApp('meta');
  if (!stored || typeof stored.settings.loginConfigId !== 'string') {
    throw new Error('Configure o aplicativo Meta Ads em Configurações antes de conectar.');
  }
  return {
    appId: stored.appId,
    appSecret: stored.clientSecret,
    configId: stored.settings.loginConfigId,
    publicUrl: publicOrigin(),
    redirectUri: `${publicOrigin()}/api/integrations/meta/callback`,
    redirectAllowlist: new Set(['/configuracoes']),
    timeoutMs: Math.max(1_000, Number(process.env.META_TIMEOUT_MS ?? 15_000)),
    includeBusinessManagement: stored.settings.includeBusinessManagement === true,
    source: 'panel' as const,
  };
}

export async function resolveShopifyApp() {
  const stored = await loadPlatformApp('shopify');
  if (!stored) throw new Error('Configure o aplicativo Shopify em Configurações antes de conectar.');
  return {
    appId: stored.appId,
    clientSecret: stored.clientSecret,
    scopes: typeof stored.settings.scopes === 'string'
      ? stored.settings.scopes : 'read_products,read_orders',
    publicUrl: publicOrigin(),
    redirectUri: `${publicOrigin()}/api/integrations/shopify/callback`,
  };
}

export async function resolveMercadoLivreApp() {
  const stored = await loadPlatformApp('mercado_livre');
  if (!stored) throw new Error('Configure o aplicativo Mercado Livre em Configurações antes de conectar.');
  return {
    appId: stored.appId,
    clientSecret: stored.clientSecret,
    publicUrl: publicOrigin(),
    redirectUri: `${publicOrigin()}/api/integrations/mercado-livre/callback`,
  };
}

export async function resolveShopeeApp() {
  const stored = await loadPlatformApp('shopee');
  if (!stored || typeof stored.settings.partnerId !== 'string') {
    throw new Error('Configure o aplicativo Shopee em Configurações antes de conectar.');
  }
  return {
    partnerId: stored.settings.partnerId,
    partnerKey: stored.clientSecret,
    appId: stored.appId,
    region: typeof stored.settings.region === 'string' ? stored.settings.region : 'BR',
    publicUrl: publicOrigin(),
    redirectUri: `${publicOrigin()}/api/integrations/shopee/callback`,
  };
}
