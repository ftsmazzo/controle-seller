import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('bloqueadores finais de produção', () => {
  it('enfileira cada versão de custo sem colisão e torna recusa visível', async () => {
    const [queue,route,migrate] = await Promise.all([
      source('src/server/queue.mts'),
      source('app/api/costs/route.ts'),
      source('scripts/migrate.mts'),
    ]);
    expect(queue).toContain('costVersionId: string');
    expect(route).toContain('cost_recalculation_outbox');
    expect(route).toContain('queueJobId=await enqueueCostRecalculation(created)');
    expect(queue).toContain("singletonKey: `${job.costVersionId}:${job.effectiveAt}`");
    expect(queue).not.toContain('singletonSeconds: 60');
    expect(queue).toContain('if (!id) throw new Error');
    expect(queue).toContain('Fila recusou o recálculo');
    expect(migrate).toContain("policy: 'key_strict_fifo'");
    expect(migrate).toContain('pending_cost_recalculations(integer)');
  });

  it('persiste alocação de devolução e invalida margem quando desconhecida', async () => {
    const [migration,store,decision,attribution] = await Promise.all([
      source('migrations/006_final_blockers.sql'),
      source('src/integrations/nuvemshop-store.mts'),
      source('src/server/decision.mts'),
      source('src/integrations/attribution.mts'),
    ]);
    expect(migration).toContain('returned_quantity integer');
    expect(migration).toContain('restocked_quantity integer');
    expect(store).toContain("'return_allocation_unknown'");
    expect(store).toContain("financialImpact:'contribution_unknown'");
    expect(decision).toContain('(ol.quantity-ol.restocked_quantity)');
    expect(attribution).toContain('(ol.quantity-ol.restocked_quantity)');
    expect(decision).toContain('ol.restocked_quantity IS NOT NULL');
  });

  it('não mantém transação ou advisory lock durante rede de sincronização', async () => {
    const [nuvemshop,meta,worker] = await Promise.all([
      source('src/integrations/nuvemshop-store.mts'),
      source('src/integrations/meta-store.mts'),
      source('src/worker.mts'),
    ]);
    expect(nuvemshop).not.toContain('pg_advisory');
    expect(meta).not.toContain('pg_advisory');
    expect(nuvemshop).toContain('processNuvemshopJob(pool: Pool');
    expect(meta).toContain('processMetaJob(pool: Pool');
    expect(nuvemshop).toContain('seller.sync_cursors');
    expect(nuvemshop).toContain('i.disconnected_at IS NULL');
    expect(worker).toContain('processNuvemshopJob(workerPool');
    expect(worker).toContain('processMetaJob(workerPool');
  });

  it('aplica privilégio mínimo, índices de FK e marca webhook por tenant', async () => {
    const [migration,runner,worker,webhook] = await Promise.all([
      source('migrations/006_final_blockers.sql'),
      source('scripts/migrate.mts'),
      source('src/worker.mts'),
      source('app/api/webhooks/nuvemshop/route.ts'),
    ]);
    expect(runner).toContain('GRANT SELECT,INSERT,DELETE ON seller.meta_account_candidates');
    expect(migration).toContain('oauth_states_user_fk_idx');
    expect(migration).toContain('oauth_states_tenant_expiry_idx');
    expect(migration).toContain('WHERE tenant_id=p_tenant_id AND id=p_inbox_id');
    expect(worker).toContain('mark_nuvemshop_webhook_enqueued($1,$2)');
    expect(webhook).toContain('mark_nuvemshop_webhook_enqueued($1,$2)');
  });

  it('mantém autenticação na interface com alerta, foco e loading', async () => {
    const [component,login,password,passwordRoute] = await Promise.all([
      source('app/components/auth-form.tsx'),
      source('app/login/page.tsx'),
      source('app/trocar-senha/page.tsx'),
      source('app/api/auth/password/route.ts'),
    ]);
    expect(component).toContain("role=\"alert\"");
    expect(component).toContain('alertRef.current?.focus()');
    expect(component).toContain("await fetch(form.action");
    expect(component).toContain('aria-busy={loading}');
    expect(component).toContain('window.location.assign(response.url)');
    expect(login).toContain('<AuthForm kind="login" />');
    expect(password).toContain('<AuthForm kind="password" />');
    expect(passwordRoute).toContain('if (!session.mustChangePassword)');
  });
});
