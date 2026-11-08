import { assertPermission, withTenant } from '@/src/server/core.mjs';
import { activeMembership, requireReadySession } from '@/src/server/session.mjs';
import { getNuvemshopStatus } from '@/src/integrations/nuvemshop-store.mjs';
import { getMetaMetricSummary, getMetaStatus } from '@/src/integrations/meta-store.mjs';
const money = (cents: bigint, currency: string) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency,
}).format(Number(cents) / 100);
export default async function SettingsPage() {
  const session = await requireReadySession();
  const context = await activeMembership(session);
  const members = await withTenant(session.activeTenantId, session.userId, async (client, ctx) => {
    assertPermission(ctx.role, 'members:read');
    const result = await client.query<{ name:string; email:string; role:string }>(
      `SELECT u.name, u.email, m.role FROM seller.memberships m
       JOIN seller.users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name`, [ctx.tenantId],
    );
    return result.rows;
  });
  const canManage = context.role === 'owner' || context.role === 'admin';
  const nuvemshop = canManage ? await getNuvemshopStatus(session.activeTenantId, session.userId) : null;
  const meta = canManage ? await getMetaStatus(session.activeTenantId, session.userId) : null;
  const metaMetrics = meta?.status === 'active'
    ? await getMetaMetricSummary(session.activeTenantId, session.userId) : null;
  return <div className="stack">
    <section className="card">
      <span className="eyebrow">Integrações</span><h2>Nuvemshop</h2>
      {!canManage ? <p className="muted">Somente owner ou admin pode gerenciar conexões.</p> :
        nuvemshop ? <>
          <p><span className="pill">{nuvemshop.status}</span> Loja {nuvemshop.storeId}</p>
          <p className="muted">Última sincronização: {nuvemshop.lastSyncAt ? nuvemshop.lastSyncAt.toLocaleString('pt-BR') : 'aguardando primeiro processamento'}.</p>
          {nuvemshop.suspendedAt && <p className="notice">Aplicativo suspenso desde {nuvemshop.suspendedAt.toLocaleString('pt-BR')}.</p>}
          {nuvemshop.lastError && <p className="error">Erro mais recente: {nuvemshop.lastError}</p>}
          {nuvemshop.webhookErrors > 0 && <p className="error">{nuvemshop.webhookErrors} webhook(s) não registrado(s).</p>}
          <form action="/api/integrations/nuvemshop/disconnect" method="post">
            <input type="hidden" name="integrationId" value={nuvemshop.id}/>
            <button className="button danger" type="submit">Desconectar</button>
          </form>
        </> : <>
          <p className="muted">Importe produtos, variantes e pedidos com sincronização incremental segura.</p>
          <form action="/api/integrations/nuvemshop/start" method="post">
            <input type="hidden" name="redirect" value="/configuracoes"/>
            <button className="button" type="submit">Conectar Nuvemshop</button>
          </form>
        </>}
    </section>
    <section className="card">
      <span className="eyebrow">Integrações</span><h2>Meta Ads</h2>
      {!canManage ? <p className="muted">Somente owner ou admin pode gerenciar conexões.</p> :
        !meta ? <>
          <p className="muted">Importe contas, campanhas, conjuntos, anúncios e insights diários em modo somente leitura.</p>
          <form action="/api/integrations/meta/start" method="post">
            <input type="hidden" name="redirect" value="/configuracoes"/>
            <button className="button" type="submit">Conectar Meta Ads</button>
          </form>
        </> : <>
          <p><span className="pill">{meta.status}</span> {meta.accounts.filter(account => account.selected).length} conta(s) selecionada(s)</p>
          <p className="muted">Última sincronização: {meta.lastSyncAt ? meta.lastSyncAt.toLocaleString('pt-BR') : 'aguardando primeiro processamento'}.</p>
          {meta.lastError && <p className="error">Erro mais recente: {meta.lastError}</p>}
          {meta.candidates.length > 0 && <form action="/api/integrations/meta/select" method="post" className="stack">
            <input type="hidden" name="integrationId" value={meta.id}/>
            <fieldset>
              <legend>Contas de anúncios autorizadas</legend>
              {meta.candidates.map(account => <label key={account.externalId} className="row">
                <input type="checkbox" name="accountIds" value={account.externalId}
                  defaultChecked={meta.accounts.some(stored => stored.externalId === account.externalId && stored.selected)}/>
                <span>{account.name} · {account.externalId} · {account.currency} · {account.timezone}</span>
              </label>)}
            </fieldset>
            <button className="button" type="submit">Salvar contas e sincronizar</button>
          </form>}
          {metaMetrics && metaMetrics.length > 0 && <div className="stack">
            <h3>Validação de métricas</h3>
            {metaMetrics.map(metric => <div key={metric.currency}>
              <h4>{metric.currency}</h4>
              <p>Investimento: <strong>{money(metric.spendCents, metric.currency)}</strong> · ROAS declarado: <strong>{metric.declaredRoas?.toFixed(2) ?? '—'}</strong></p>
              <p>Receita líquida atribuída: <strong>{money(metric.attributedNetRevenueCents, metric.currency)}</strong> · Margem atribuída após mídia: <strong>{metric.attributedMarginAfterMediaCents === null ? 'Custo incompleto' : money(metric.attributedMarginAfterMediaCents, metric.currency)}</strong></p>
              <p>Cobertura: <strong>{metric.coverage === null ? '—' : `${(metric.coverage * 100).toFixed(1)}%`}</strong></p>
              <p className="notice">{metric.warning}</p>
            </div>)}
          </div>}
          <form action="/api/integrations/meta/disconnect" method="post">
            <input type="hidden" name="integrationId" value={meta.id}/>
            <button className="button danger" type="submit">Desconectar Meta</button>
          </form>
        </>}
    </section>
    <section className="card">
      <span className="eyebrow">Configurações</span><h2 id="acessos-title">Acessos da empresa</h2>
      <p className="muted">Seu papel atual é <span className="pill">{context.role}</span>.</p>
      {!members.length ? <div className="empty">Nenhum acesso foi encontrado para esta empresa.</div> : <>
        <p className="scroll-hint">Deslize horizontalmente para ver todas as colunas.</p>
        <div className="table-scroll" role="region" aria-labelledby="acessos-title" tabIndex={0}>
          <table className="table"><caption className="sr-only">Pessoas com acesso à empresa</caption><thead><tr><th scope="col">Pessoa</th><th scope="col">E-mail</th><th scope="col">Papel</th></tr></thead>
            <tbody>{members.map(member=><tr key={member.email}><td>{member.name}</td><td>{member.email}</td><td><span className="pill">{member.role}</span></td></tr>)}</tbody>
          </table>
        </div>
      </>}
    </section>
  </div>;
}
