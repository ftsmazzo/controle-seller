import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  audit, encryptCredential, ForbiddenError, withTenant, type Role,
} from '@/src/server/core.mjs';
import {
  resolveMercadoLivreApp, resolveShopifyApp, resolveShopeeApp,
} from '@/src/integrations/platform-apps.mjs';

function assertManager(role: Role) {
  if (role !== 'owner' && role !== 'admin') {
    throw new ForbiddenError('Somente owner ou admin pode gerenciar integrações.');
  }
}

function statePair() {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: createHash('sha256').update(raw).digest() };
}

export async function beginShopifyOAuth(
  tenantId: string, userId: string, shopDomain: string,
) {
  const shop = z.string().trim().toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'Informe a loja no formato loja.myshopify.com')
    .parse(shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  const app = await resolveShopifyApp();
  const state = statePair();
  return withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    await client.query(
      `INSERT INTO seller.oauth_states(state_hash,tenant_id,user_id,provider,redirect_uri,redirect_path,expires_at)
       VALUES($1,$2,$3,'shopify',$4,$5,now()+interval '10 minutes')`,
      [state.digest, tenantId, userId, app.redirectUri, `/configuracoes?shop=${encodeURIComponent(shop)}`],
    );
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set('client_id', app.appId);
    url.searchParams.set('scope', app.scopes);
    url.searchParams.set('redirect_uri', app.redirectUri);
    url.searchParams.set('state', state.raw);
    return url.toString();
  });
}

export async function finishShopifyOAuth(
  tenantId: string, userId: string, state: string, code: string, shop: string,
) {
  const app = await resolveShopifyApp();
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const consumed = await client.query<{ redirect_path: string }>(
      `UPDATE seller.oauth_states SET used_at=now()
       WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND provider='shopify'
         AND redirect_uri=$4 AND used_at IS NULL AND expires_at>now()
       RETURNING redirect_path`,
      [createHash('sha256').update(state).digest(), tenantId, userId, app.redirectUri],
    );
    if (!consumed.rows[0]) throw new ForbiddenError('State OAuth Shopify inválido.');
  });
  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: app.appId, client_secret: app.clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error(`Shopify recusou o token (${tokenResponse.status}).`);
  const token = z.object({
    access_token: z.string().min(1), scope: z.string().optional(),
  }).parse(await tokenResponse.json());
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const integration = await client.query<{ id: string }>(
      `INSERT INTO seller.integrations
        (tenant_id,provider,kind,external_account_id,display_name,status,metadata,disconnected_at,last_error)
       VALUES($1,'shopify','commerce',$2,$3,'active',$4,NULL,NULL)
       ON CONFLICT (tenant_id,provider,external_account_id) DO UPDATE SET
         status='active',display_name=excluded.display_name,metadata=excluded.metadata,
         disconnected_at=NULL,last_error=NULL
       RETURNING id`,
      [tenantId, shop, `Shopify ${shop}`, { scopes: token.scope ?? app.scopes }],
    );
    const integrationId = integration.rows[0]!.id;
    const encrypted = encryptCredential(
      { accessToken: token.access_token, shop },
      { tenantId, provider: 'shopify', integrationId },
    );
    await client.query(
      `INSERT INTO seller.oauth_credentials(tenant_id,integration_id,key_version,iv,auth_tag,ciphertext,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,integration_id) DO UPDATE SET
         key_version=excluded.key_version,iv=excluded.iv,auth_tag=excluded.auth_tag,
         ciphertext=excluded.ciphertext,aad_version=excluded.aad_version,updated_at=now()`,
      [tenantId, integrationId, encrypted.keyVersion, encrypted.iv, encrypted.authTag, encrypted.ciphertext, encrypted.aadVersion],
    );
    await audit(client, context, 'integration.shopify_connected', 'integration', integrationId, { shop });
  });
  return { redirectPath: '/configuracoes?shopify=connected' };
}

export async function beginMercadoLivreOAuth(tenantId: string, userId: string) {
  const app = await resolveMercadoLivreApp();
  const state = statePair();
  return withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    await client.query(
      `INSERT INTO seller.oauth_states(state_hash,tenant_id,user_id,provider,redirect_uri,redirect_path,expires_at)
       VALUES($1,$2,$3,'mercado_livre',$4,'/configuracoes',now()+interval '10 minutes')`,
      [state.digest, tenantId, userId, app.redirectUri],
    );
    const url = new URL('https://auth.mercadolivre.com.br/authorization');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.appId);
    url.searchParams.set('redirect_uri', app.redirectUri);
    url.searchParams.set('state', state.raw);
    return url.toString();
  });
}

export async function finishMercadoLivreOAuth(
  tenantId: string, userId: string, state: string, code: string,
) {
  const app = await resolveMercadoLivreApp();
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const consumed = await client.query(
      `UPDATE seller.oauth_states SET used_at=now()
       WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND provider='mercado_livre'
         AND redirect_uri=$4 AND used_at IS NULL AND expires_at>now()
       RETURNING redirect_path`,
      [createHash('sha256').update(state).digest(), tenantId, userId, app.redirectUri],
    );
    if (!consumed.rows[0]) throw new ForbiddenError('State OAuth Mercado Livre inválido.');
  });
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: app.appId,
    client_secret: app.clientSecret,
    code,
    redirect_uri: app.redirectUri,
  });
  const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error(`Mercado Livre recusou o token (${tokenResponse.status}).`);
  const token = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    user_id: z.union([z.string(), z.number()]).transform(String),
    expires_in: z.number().optional(),
  }).parse(await tokenResponse.json());
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const integration = await client.query<{ id: string }>(
      `INSERT INTO seller.integrations
        (tenant_id,provider,kind,external_account_id,display_name,status,metadata,disconnected_at,last_error)
       VALUES($1,'mercado_livre','commerce',$2,$3,'active',$4,NULL,NULL)
       ON CONFLICT (tenant_id,provider,external_account_id) DO UPDATE SET
         status='active',display_name=excluded.display_name,metadata=excluded.metadata,
         disconnected_at=NULL,last_error=NULL
       RETURNING id`,
      [tenantId, token.user_id, `Mercado Livre ${token.user_id}`, { expiresIn: token.expires_in ?? null }],
    );
    const integrationId = integration.rows[0]!.id;
    const encrypted = encryptCredential({
      accessToken: token.access_token, refreshToken: token.refresh_token ?? null, userId: token.user_id,
    }, { tenantId, provider: 'mercado_livre', integrationId });
    await client.query(
      `INSERT INTO seller.oauth_credentials(tenant_id,integration_id,key_version,iv,auth_tag,ciphertext,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,integration_id) DO UPDATE SET
         key_version=excluded.key_version,iv=excluded.iv,auth_tag=excluded.auth_tag,
         ciphertext=excluded.ciphertext,aad_version=excluded.aad_version,updated_at=now()`,
      [tenantId, integrationId, encrypted.keyVersion, encrypted.iv, encrypted.authTag, encrypted.ciphertext, encrypted.aadVersion],
    );
    await audit(client, context, 'integration.mercado_livre_connected', 'integration', integrationId, {
      userId: token.user_id,
    });
  });
  return { redirectPath: '/configuracoes?mercado_livre=connected' };
}

export async function beginShopeeOAuth(tenantId: string, userId: string) {
  const app = await resolveShopeeApp();
  const state = statePair();
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  const base = `${app.partnerId}${path}${timestamp}`;
  const sign = createHmac('sha256', app.partnerKey).update(base).digest('hex');
  return withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    await client.query(
      `INSERT INTO seller.oauth_states(state_hash,tenant_id,user_id,provider,redirect_uri,redirect_path,expires_at)
       VALUES($1,$2,$3,'shopee',$4,'/configuracoes',now()+interval '10 minutes')`,
      [state.digest, tenantId, userId, app.redirectUri],
    );
    const host = app.region === 'BR'
      ? 'https://partner.shopeemobile.com'
      : 'https://partner.shopeemobile.com';
    const url = new URL(`${host}${path}`);
    url.searchParams.set('partner_id', String(app.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    url.searchParams.set('redirect', app.redirectUri);
    url.searchParams.set('state', state.raw);
    return url.toString();
  });
}

export async function finishShopeeOAuth(
  tenantId: string, userId: string, state: string, code: string, shopId: string,
) {
  const app = await resolveShopeeApp();
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const consumed = await client.query(
      `UPDATE seller.oauth_states SET used_at=now()
       WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND provider='shopee'
         AND redirect_uri=$4 AND used_at IS NULL AND expires_at>now()
       RETURNING redirect_path`,
      [createHash('sha256').update(state).digest(), tenantId, userId, app.redirectUri],
    );
    if (!consumed.rows[0]) throw new ForbiddenError('State OAuth Shopee inválido.');
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/token/get';
  const base = `${app.partnerId}${path}${timestamp}`;
  const sign = createHmac('sha256', app.partnerKey).update(base).digest('hex');
  const tokenResponse = await fetch(`https://partner.shopeemobile.com${path}?partner_id=${app.partnerId}&timestamp=${timestamp}&sign=${sign}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code, shop_id: Number(shopId), partner_id: Number(app.partnerId),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error(`Shopee recusou o token (${tokenResponse.status}).`);
  const token = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expire_in: z.number().optional(),
  }).parse(await tokenResponse.json());
  await withTenant(tenantId, userId, async (client, context) => {
    assertManager(context.role);
    const integration = await client.query<{ id: string }>(
      `INSERT INTO seller.integrations
        (tenant_id,provider,kind,external_account_id,display_name,status,metadata,disconnected_at,last_error)
       VALUES($1,'shopee','commerce',$2,$3,'active',$4,NULL,NULL)
       ON CONFLICT (tenant_id,provider,external_account_id) DO UPDATE SET
         status='active',display_name=excluded.display_name,metadata=excluded.metadata,
         disconnected_at=NULL,last_error=NULL
       RETURNING id`,
      [tenantId, shopId, `Shopee ${shopId}`, { expireIn: token.expire_in ?? null }],
    );
    const integrationId = integration.rows[0]!.id;
    const encrypted = encryptCredential({
      accessToken: token.access_token, refreshToken: token.refresh_token ?? null, shopId,
    }, { tenantId, provider: 'shopee', integrationId });
    await client.query(
      `INSERT INTO seller.oauth_credentials(tenant_id,integration_id,key_version,iv,auth_tag,ciphertext,aad_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,integration_id) DO UPDATE SET
         key_version=excluded.key_version,iv=excluded.iv,auth_tag=excluded.auth_tag,
         ciphertext=excluded.ciphertext,aad_version=excluded.aad_version,updated_at=now()`,
      [tenantId, integrationId, encrypted.keyVersion, encrypted.iv, encrypted.authTag, encrypted.ciphertext, encrypted.aadVersion],
    );
    await audit(client, context, 'integration.shopee_connected', 'integration', integrationId, { shopId });
  });
  return { redirectPath: '/configuracoes?shopee=connected' };
}
