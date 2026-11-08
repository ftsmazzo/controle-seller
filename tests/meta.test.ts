import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appSecretProof, decimalToMetaCents, META_API_VERSION, MetaClient, metaAuthorizationUrl,
} from '../src/integrations/meta.mjs';
import { extractAttributionEvidence } from '../src/integrations/attribution.mjs';

beforeEach(() => {
  process.env.APP_PUBLIC_URL = 'https://seller.example.test';
  process.env.META_APP_ID = '123456';
  process.env.META_APP_SECRET = 'fixture-secret';
  process.env.META_LOGIN_CONFIG_ID = '987654';
  process.env.META_REDIRECT_ALLOWLIST = '/configuracoes';
});

describe('Meta Graph/Marketing API v27.0', () => {
  it('usa Facebook Login for Business com redirect exato e config_id', () => {
    const url = new URL(metaAuthorizationUrl('state fixture'));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('123456');
    expect(url.searchParams.get('config_id')).toBe('987654');
    expect(url.searchParams.get('redirect_uri')).toBe('https://seller.example.test/api/integrations/meta/callback');
    expect(url.searchParams.get('state')).toBe('state fixture');
  });

  it('calcula appsecret_proof HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'fixture-secret').update('fixture-token').digest('hex');
    expect(appSecretProof('fixture-token')).toBe(expected);
  });

  it('converte valores declarados para centavos com arredondamento', () => {
    expect(decimalToMetaCents('12.34')).toBe(1234n);
    expect(decimalToMetaCents('12.345')).toBe(1235n);
  });

  it('segue paging.next opaco e envia token somente no Authorization', async () => {
    const next = 'https://graph.facebook.com/v27.0/me/adaccounts?after=opaque-cursor';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: '1' }], paging: { next } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: '2' }] }), { status: 200 }));
    const client = new MetaClient({ accessToken: 'fixture-token', fetcher });
    const ids: string[] = [];
    for await (const page of client.paginate<{ id:string }>('/me/adaccounts')) ids.push(...page.map(item => item.id));
    expect(ids).toEqual(['1', '2']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [input,init] of fetcher.mock.calls) {
      const url = input as URL;
      expect(url.pathname.startsWith(`/${META_API_VERSION}/`)).toBe(true);
      expect(url.searchParams.get('appsecret_proof')).toBe(appSecretProof('fixture-token'));
      expect(url.searchParams.has('access_token')).toBe(false);
      expect((init as RequestInit).headers).toMatchObject({Authorization:'Bearer fixture-token'});
    }
  });

  it('aplica retry/backoff para erro Graph 4 sem chamada real', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 4, message: 'rate limit' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'me' }), { status: 200 }));
    const client = new MetaClient({ accessToken: 'fixture-token', fetcher, sleep, random: () => 0 });
    await expect(client.request('/me')).resolves.toEqual({ id: 'me' });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('atribui somente quando existe evidência explícita', () => {
    expect(extractAttributionEvidence({ landing_url: 'https://loja.test/?utm_source=facebook&utm_campaign=x' }))
      .toMatchObject({ type: 'utm', source: 'facebook' });
    expect(extractAttributionEvidence({ landing_url: 'https://loja.test/?fbclid=abc' }))
      .toMatchObject({ type: 'click_identifier', clickId: 'abc' });
    expect(extractAttributionEvidence({ landing_url: 'https://loja.test/' })).toBeNull();
  });
});
