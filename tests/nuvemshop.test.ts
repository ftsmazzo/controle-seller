import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationUrl, decimalToCents, mapOrder, mapProduct, normalizeRedirect,
  NUVEMSHOP_API_VERSION, NuvemshopClient, verifyWebhookHmac,
} from '../src/integrations/nuvemshop.mjs';

beforeEach(() => {
  process.env.NUVEMSHOP_APP_ID = '1234';
  process.env.NUVEMSHOP_CLIENT_SECRET = 'fixture-secret';
  process.env.NUVEMSHOP_USER_AGENT = 'ControleSeller/0.3 suporte@example.test';
  process.env.APP_PUBLIC_URL = 'https://seller.example.test';
  process.env.NUVEMSHOP_REDIRECT_ALLOWLIST = '/configuracoes';
});
const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

describe('contrato Nuvemshop 2025-03', () => {
  it('gera autorização oficial e restringe redirecionamento', async () => {
    expect(await authorizationUrl('estado +')).toBe('https://www.nuvemshop.com.br/apps/1234/authorize?state=estado%20%2B');
    const allowlist = new Set(['/configuracoes']);
    expect(normalizeRedirect('/configuracoes', allowlist)).toBe('/configuracoes');
    expect(normalizeRedirect('https://evil.test', allowlist)).toBe('/configuracoes');
    expect(normalizeRedirect('//evil.test', allowlist)).toBe('/configuracoes');
  });
  it('valida HMAC SHA-256 em base64 sobre o corpo bruto', async () => {
    const raw = Buffer.from('{"id":1, "preserva":"espaços"}');
    const signature = createHmac('sha256', 'fixture-secret').update(raw).digest('base64');
    expect(await verifyWebhookHmac(raw, signature)).toBe(true);
    expect(await verifyWebhookHmac(Buffer.from('{}'), signature)).toBe(false);
  });
  it('converte dinheiro sem float e rejeita precisão silenciosa', () => {
    expect(decimalToCents('129.90')).toBe(12990n);
    expect(decimalToCents('0.1')).toBe(10n);
    expect(() => decimalToCents('1.999')).toThrow('Valor monetário inválido');
  });
  it('mapeia produto, variantes e pedido preservando payload e hash', async () => {
    const product = mapProduct(await fixture('nuvemshop-product.json'));
    const order = mapOrder(await fixture('nuvemshop-order.json'));
    expect(product.externalId).toBe('101');
    expect(product.variants[0]?.priceCents).toBe(12990n);
    expect(product.provenance.apiVersion).toBe(NUVEMSHOP_API_VERSION);
    expect(product.provenance.hash).toHaveLength(64);
    expect(order.status).toBe('paid');
    expect(order.lines[0]?.discountCents).toBe(1000n);
    expect(order.payload).toMatchObject({ id: 301 });
  });
  it('nunca rebaixa estornado a pendente e preserva componentes financeiros observados', () => {
    const order = mapOrder({
      id:302,status:'open',payment_status:'refunded',currency:'BRL',
      created_at:'2026-11-02T13:00:00Z',updated_at:'2026-11-03T13:00:00Z',products:[],
      shipping_cost_customer:'15.00',payment_fee:'2.50',refunds:[{id:'r1',amount:'100.00'}],
    });
    expect(order.status).toBe('refunded');
    expect(order.financialEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'shipping',amountCents:1500n,direction:1}),
      expect.objectContaining({kind:'payment_fee',amountCents:250n,direction:-1}),
      expect.objectContaining({kind:'refund',amountCents:10000n,direction:-1}),
    ]));
  });
  it('preserva devolução e reposição por linha quando a origem informa a alocação', async () => {
    const order = mapOrder(await fixture('nuvemshop-refund-allocated.json'));
    expect(order.returnAllocationKnown).toBe(true);
    expect(order.lines[0]).toMatchObject({quantity:3,returnedQuantity:2,restockedQuantity:1});
  });
  it('marca contribuição desconhecida quando o estorno não informa alocação por linha', async () => {
    const order = mapOrder(await fixture('nuvemshop-refund-unallocated.json'));
    expect(order.returnAllocationKnown).toBe(false);
    expect(order.lines[0]).toMatchObject({returnedQuantity:null,restockedQuantity:null});
  });
  it('invalida toda a reposição quando apenas parte das devoluções está alocada', () => {
    const order = mapOrder({
      id:403,status:'closed',payment_status:'refunded',currency:'BRL',
      created_at:'2026-11-02T13:00:00Z',updated_at:'2026-11-03T13:00:00Z',
      products:[{id:9003,variant_id:703,sku:'CAMISETA-C',quantity:3,price:'100.00'}],
      refunds:[
        {id:'refund-allocated',amount:'100.00',products:[
          {order_product_id:9003,quantity:1,restocked_quantity:1},
        ]},
        {id:'refund-unallocated',amount:'100.00'},
      ],
    });
    expect(order.returnAllocationKnown).toBe(false);
    expect(order.lines[0]).toMatchObject({returnedQuantity:null,restockedQuantity:null});
  });
  it('usa Bearer, User-Agent e segue Link rel=next', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), {
        status: 200, headers: { Link: '<https://api.nuvemshop.com.br/2025-03/55/products?page=2>; rel="next"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));
    const client = new NuvemshopClient({
      storeId: '55', accessToken: 'token-fixture', fetcher,
      userAgent: 'ControleSeller/0.3 suporte@example.test', timeoutMs: 10_000,
    });
    const ids: number[] = [];
    for await (const page of client.paginate<{ id:number }>('/products')) ids.push(...page.map(item => item.id));
    expect(ids).toEqual([1, 2]);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-fixture',
      'User-Agent': 'ControleSeller/0.3 suporte@example.test',
    });
  });
  it('faz retry de 429 sem expor o token no erro', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    const client = new NuvemshopClient({
      storeId: '55', accessToken: 'secret-token', fetcher, random: () => 0,
      userAgent: 'ControleSeller/0.3 suporte@example.test', timeoutMs: 10_000,
    });
    await expect(client.get('/products/1')).resolves.toEqual({ id: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
