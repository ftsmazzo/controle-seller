import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  can, decryptCredential, encryptCredential, hashPassword, loginSchema,
  productSchema, readLimitedBody, verifyPassword,
} from '../src/server/core.mjs';
import { publicUrl } from '../src/server/http.mjs';

describe('autorização', () => {
  it('mantém viewer somente leitura e restringe gestão ao owner', () => {
    expect(can('viewer', 'catalog:read')).toBe(true);
    expect(can('viewer', 'catalog:write')).toBe(false);
    expect(can('admin', 'members:write')).toBe(true);
    expect(can('admin', 'tenant:manage')).toBe(false);
    expect(can('owner', 'tenant:manage')).toBe(true);
  });
});
describe('autenticação e credenciais', () => {
  it('gera redirecionamentos com a origem pública atrás do proxy', () => {
    process.env.APP_PUBLIC_URL = 'https://seller.example.test/base-ignorada';
    const request = new Request('http://0.0.0.0:3000/api/auth/login');
    expect(publicUrl('/trocar-senha', request).href).toBe('https://seller.example.test/trocar-senha');
    delete process.env.APP_PUBLIC_URL;
    expect(publicUrl('/login', request).href).toBe('http://0.0.0.0:3000/login');
  });
  it('usa scrypt com salt e comparação segura', async () => {
    const first = await hashPassword('SenhaTemporaria123');
    const second = await hashPassword('SenhaTemporaria123');
    expect(first).not.toBe(second);
    expect(await verifyPassword('SenhaTemporaria123', first)).toBe(true);
    expect(await verifyPassword('senha-incorreta', first)).toBe(false);
  });
  it('cifra e autentica credenciais com versão de chave', () => {
    process.env.CREDENTIAL_KEYS = JSON.stringify({ v1: randomBytes(32).toString('base64') });
    process.env.ACTIVE_CREDENTIAL_KEY_VERSION = 'v1';
    const context = {tenantId:'tenant-a',provider:'meta',integrationId:'integration-a'};
    const encrypted = encryptCredential({ accessToken: 'segredo' },context);
    expect(encrypted.keyVersion).toBe('v1');
    expect(encrypted.ciphertext.toString()).not.toContain('segredo');
    expect(decryptCredential(encrypted,context)).toEqual({ accessToken: 'segredo' });
    expect(() => decryptCredential(encrypted,{...context,tenantId:'tenant-b'})).toThrow();
  });
});
describe('schemas e isolamento', () => {
  it('rejeita campos inesperados e entradas inválidas', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x', admin: true }).success).toBe(false);
    expect(productSchema.safeParse({ name: '', sku: '' }).success).toBe(false);
  });
  it('migration força RLS em tabelas tenant e usa contexto server-side', async () => {
    const sql = await readFile(new URL('../migrations/001_saas_foundation.sql', import.meta.url), 'utf8');
    const core = await readFile(new URL('../src/server/core.mts', import.meta.url), 'utf8');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('tenant_id = seller.current_tenant()');
    expect(core).toContain(`set_config('app.tenant_id', $1, true)`);
    expect(core).toContain('SELECT role FROM seller.memberships');
    expect(core).toContain('role.rolsuper || role.rolbypassrls');
  });
  it('runner aplica SQL e registro de migration na mesma transação', async () => {
    const runner = await readFile(new URL('../scripts/migrate.mts', import.meta.url), 'utf8');
    for (const migration of ['001_saas_foundation.sql','002_nuvemshop_connector.sql','003_meta_connector.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url),'utf8');
      expect(sql.trimStart().startsWith('BEGIN;')).toBe(false);
      expect(sql.trimEnd().endsWith('COMMIT;')).toBe(false);
    }
    expect(runner).toContain(`await client.query('BEGIN')`);
    expect(runner).toContain('pg_advisory_xact_lock');
    expect(runner).toContain('INSERT INTO public.schema_migrations');
  });
  it('limita stream mesmo sem Content-Length', async () => {
    const request = new Request('https://seller.test/api/catalog',{
      method:'POST',body:'x'.repeat(101),duplex:'half',
    } as RequestInit & {duplex:'half'});
    await expect(readLimitedBody(request,100)).rejects.toThrow('acima do limite');
  });
  it('revoga PUBLIC de seletores e protege pedidos contra eventos antigos', async () => {
    const foundation = await readFile(new URL('../migrations/001_saas_foundation.sql',import.meta.url),'utf8');
    const store = await readFile(new URL('../src/integrations/nuvemshop-store.mts',import.meta.url),'utf8');
    const attribution = await readFile(new URL('../src/integrations/attribution.mts',import.meta.url),'utf8');
    expect(foundation).toContain('REVOKE ALL ON FUNCTION seller.list_user_tenants() FROM PUBLIC');
    expect(store).toContain('excluded.source_updated_at>=seller.orders.source_updated_at');
    expect(attribution).toContain('seller.cost_channel_versions');
  });
});
