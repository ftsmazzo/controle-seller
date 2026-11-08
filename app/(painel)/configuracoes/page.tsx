import type { ReactNode } from 'react';
import { listPlatformAppStatuses, type PlatformProvider } from '@/src/integrations/platform-apps.mjs';
import { getMetaMetricSummary, getMetaStatus } from '@/src/integrations/meta-store.mjs';
import { getNuvemshopStatus } from '@/src/integrations/nuvemshop-store.mjs';
import { assertPermission, withTenant } from '@/src/server/core.mjs';
import { activeMembership, requireReadySession } from '@/src/server/session.mjs';

const money = (cents: bigint, currency: string) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency,
}).format(Number(cents) / 100);

function AppForm({
  provider, title, configured, callbackUrl, children, fields,
}: {
  provider: PlatformProvider;
  title: string;
  configured: boolean;
  callbackUrl: string;
  children?: ReactNode;
  fields: ReactNode;
}) {
  return (
    <details className="app-config" open={!configured}>
      <summary>
        <span>
          <b>{title}</b>
          <small>{configured ? 'Aplicativo cadastrado no painel' : 'Cadastre App ID e Secret aqui'}</small>
        </span>
        <span className={`status ${configured ? 'ok' : 'warn'}`}>
          {configured ? 'Pronto' : 'Pendente'}
        </span>
      </summary>
      <div className="app-config-body">
        <p className="callback">Callback para colar no painel do provedor: <code>{callbackUrl}</code></p>
        <form action="/api/platform-apps" method="post" className="stack compact">
          <input type="hidden" name="provider" value={provider} />
          {fields}
          <button className="button" type="submit">Salvar aplicativo {title}</button>
        </form>
        {children}
      </div>
    </details>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireReadySession();
  const params = (await searchParams) ?? {};
  const flashError = typeof params.error === 'string' ? params.error
    : typeof params.message === 'string' ? params.message : null;
  const flashOk = params.apps === 'saved' || params.nuvemshop === 'connected'
    || params.meta === 'connected' || params.shopify === 'connected'
    || params.mercado_livre === 'connected' || params.shopee === 'connected';

  const context = await activeMembership(session);
  const members = await withTenant(session.activeTenantId, session.userId, async (client, ctx) => {
    assertPermission(ctx.role, 'members:read');
    const result = await client.query<{ name: string; email: string; role: string }>(
      `SELECT u.name, u.email, m.role FROM seller.memberships m
       JOIN seller.users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name`, [ctx.tenantId],
    );
    return result.rows;
  });
  const integrations = await withTenant(session.activeTenantId, session.userId, async client => {
    const result = await client.query<{
      id: string; provider: string; status: string; display_name: string; last_sync_at: Date | null; last_error: string | null;
    }>(
      `SELECT id,provider,status,display_name,last_sync_at,last_error
       FROM seller.integrations WHERE disconnected_at IS NULL ORDER BY provider, created_at DESC`,
    );
    return result.rows;
  });

  const canManage = context.role === 'owner' || context.role === 'admin';
  const isOwner = context.role === 'owner';
  const apps = await listPlatformAppStatuses();
  const byProvider = Object.fromEntries(apps.map(app => [app.provider, app])) as Record<PlatformProvider, (typeof apps)[number]>;
  const nuvemshop = canManage ? await getNuvemshopStatus(session.activeTenantId, session.userId) : null;
  const meta = canManage ? await getMetaStatus(session.activeTenantId, session.userId) : null;
  const metaMetrics = meta?.status === 'active'
    ? await getMetaMetricSummary(session.activeTenantId, session.userId) : null;

  return (
    <div className="settings">
      <div className="dash-toolbar">
        <div>
          <span className="kicker">Configurações</span>
          <h2>Conexões sem depender do EasyPanel</h2>
          <p className="muted">Cadastre os apps no painel e autorize lojas e contas de ads nesta empresa.</p>
        </div>
      </div>

      {flashOk && <p className="notice success">Configuração salva com sucesso.</p>}
      {flashError && <p className="error" role="alert">{flashError}</p>}

      {isOwner && (
        <section className="panel-card">
          <div className="panel-card-head">
            <h3>1. Aplicativos da plataforma</h3>
            <span className="pill">{apps.filter(a => a.configured).length}/{apps.length}</span>
          </div>
          <p className="muted">
            Estes dados ficam criptografados no banco. O owner cadastra uma vez; depois qualquer empresa do tenant conecta a loja.
          </p>

          <AppForm
            provider="nuvemshop"
            title="Nuvemshop"
            configured={byProvider.nuvemshop.configured}
            callbackUrl={byProvider.nuvemshop.callbackUrl}
            fields={(
              <>
                <label>App ID<input name="appId" required placeholder="ID do app Nuvemshop" /></label>
                <label>Client Secret<input name="clientSecret" type="password" required placeholder="Segredo do app" /></label>
                <label>User-Agent<input name="userAgent" required placeholder="ControleSeller/1.0 suporte@suaempresa.com" /></label>
              </>
            )}
          />

          <AppForm
            provider="meta"
            title="Meta Ads"
            configured={byProvider.meta.configured}
            callbackUrl={byProvider.meta.callbackUrl}
            fields={(
              <>
                <label>App ID<input name="appId" required placeholder="Meta App ID" /></label>
                <label>App Secret<input name="clientSecret" type="password" required placeholder="Meta App Secret" /></label>
                <label>Login Config ID<input name="loginConfigId" required placeholder="Facebook Login for Business config" /></label>
                <label className="row"><input type="checkbox" name="includeBusinessManagement" /> Incluir business_management</label>
              </>
            )}
          />

          <AppForm
            provider="shopify"
            title="Shopify"
            configured={byProvider.shopify.configured}
            callbackUrl={byProvider.shopify.callbackUrl}
            fields={(
              <>
                <label>API Key / Client ID<input name="appId" required /></label>
                <label>API Secret Key<input name="clientSecret" type="password" required /></label>
                <label>Scopes<input name="scopes" defaultValue="read_products,read_orders" /></label>
              </>
            )}
          />

          <AppForm
            provider="mercado_livre"
            title="Mercado Livre"
            configured={byProvider.mercado_livre.configured}
            callbackUrl={byProvider.mercado_livre.callbackUrl}
            fields={(
              <>
                <label>App ID<input name="appId" required /></label>
                <label>Secret Key<input name="clientSecret" type="password" required /></label>
              </>
            )}
          />

          <AppForm
            provider="shopee"
            title="Shopee"
            configured={byProvider.shopee.configured}
            callbackUrl={byProvider.shopee.callbackUrl}
            fields={(
              <>
                <label>App ID / Partner App<input name="appId" required /></label>
                <label>Partner ID<input name="partnerId" required /></label>
                <label>Partner Key<input name="clientSecret" type="password" required /></label>
                <label>Região<input name="region" defaultValue="BR" /></label>
              </>
            )}
          />
        </section>
      )}

      <section className="panel-card">
        <div className="panel-card-head">
          <h3>2. Conectar lojas e anúncios desta empresa</h3>
        </div>
        {!canManage ? (
          <p className="muted">Somente owner ou admin pode conectar canais.</p>
        ) : (
          <div className="connect-grid">
            <article className="connect-card">
              <header><h4>Nuvemshop</h4><span className={`status ${nuvemshop ? 'ok' : 'warn'}`}>{nuvemshop?.status ?? 'livre'}</span></header>
              {nuvemshop ? (
                <>
                  <p>Loja {nuvemshop.storeId}</p>
                  <p className="muted">Última sync: {nuvemshop.lastSyncAt?.toLocaleString('pt-BR') ?? 'aguardando'}</p>
                  {nuvemshop.lastError && <p className="error">{nuvemshop.lastError}</p>}
                  <form action="/api/integrations/nuvemshop/disconnect" method="post">
                    <input type="hidden" name="integrationId" value={nuvemshop.id} />
                    <button className="button danger" type="submit">Desconectar</button>
                  </form>
                </>
              ) : (
                <>
                  <p className="muted">Importe produtos e pedidos em modo seguro.</p>
                  {!byProvider.nuvemshop.configured && <p className="notice">Cadastre o app Nuvemshop acima antes de conectar.</p>}
                  <form action="/api/integrations/nuvemshop/start" method="post">
                    <input type="hidden" name="redirect" value="/configuracoes" />
                    <button className="button" type="submit" disabled={!byProvider.nuvemshop.configured}>Conectar Nuvemshop</button>
                  </form>
                </>
              )}
            </article>

            <article className="connect-card">
              <header><h4>Meta Ads</h4><span className={`status ${meta ? 'ok' : 'warn'}`}>{meta?.status ?? 'livre'}</span></header>
              {!meta ? (
                <>
                  <p className="muted">Contas, campanhas e insights diários em leitura.</p>
                  {!byProvider.meta.configured && <p className="notice">Cadastre o app Meta acima antes de conectar.</p>}
                  <form action="/api/integrations/meta/start" method="post">
                    <input type="hidden" name="redirect" value="/configuracoes" />
                    <button className="button" type="submit" disabled={!byProvider.meta.configured}>Conectar Meta Ads</button>
                  </form>
                </>
              ) : (
                <>
                  <p>{meta.accounts.filter(a => a.selected).length} conta(s) selecionada(s)</p>
                  {meta.lastError && <p className="error">{meta.lastError}</p>}
                  {meta.candidates.length > 0 && (
                    <form action="/api/integrations/meta/select" method="post" className="stack compact">
                      <input type="hidden" name="integrationId" value={meta.id} />
                      <fieldset>
                        <legend>Contas autorizadas</legend>
                        {meta.candidates.map(account => (
                          <label key={account.externalId} className="row">
                            <input
                              type="checkbox"
                              name="accountIds"
                              value={account.externalId}
                              defaultChecked={meta.accounts.some(stored => stored.externalId === account.externalId && stored.selected)}
                            />
                            <span>{account.name} · {account.externalId}</span>
                          </label>
                        ))}
                      </fieldset>
                      <button className="button" type="submit">Salvar contas</button>
                    </form>
                  )}
                  {metaMetrics?.map(metric => (
                    <div key={metric.currency}>
                      <p>Investimento: <strong>{money(metric.spendCents, metric.currency)}</strong></p>
                      <p className="notice">{metric.warning}</p>
                    </div>
                  ))}
                  <form action="/api/integrations/meta/disconnect" method="post">
                    <input type="hidden" name="integrationId" value={meta.id} />
                    <button className="button danger" type="submit">Desconectar Meta</button>
                  </form>
                </>
              )}
            </article>

            <article className="connect-card">
              <header><h4>Shopify</h4><span className="status warn">conectar</span></header>
              <p className="muted">Informe o domínio da loja para autorizar.</p>
              {!byProvider.shopify.configured && <p className="notice">Cadastre o app Shopify acima.</p>}
              <form action="/api/integrations/shopify/start" method="post" className="stack compact">
                <label>Loja<input name="shop" required placeholder="minhaloja.myshopify.com" disabled={!byProvider.shopify.configured} /></label>
                <button className="button" type="submit" disabled={!byProvider.shopify.configured}>Conectar Shopify</button>
              </form>
            </article>

            <article className="connect-card">
              <header><h4>Mercado Livre</h4><span className="status warn">conectar</span></header>
              <p className="muted">Autorize a conta do vendedor para importar operação.</p>
              {!byProvider.mercado_livre.configured && <p className="notice">Cadastre o app Mercado Livre acima.</p>}
              <form action="/api/integrations/mercado-livre/start" method="post">
                <button className="button" type="submit" disabled={!byProvider.mercado_livre.configured}>Conectar Mercado Livre</button>
              </form>
            </article>

            <article className="connect-card">
              <header><h4>Shopee</h4><span className="status warn">conectar</span></header>
              <p className="muted">Fluxo partner auth da Shopee Open Platform.</p>
              {!byProvider.shopee.configured && <p className="notice">Cadastre Partner ID e Key acima.</p>}
              <form action="/api/integrations/shopee/start" method="post">
                <button className="button" type="submit" disabled={!byProvider.shopee.configured}>Conectar Shopee</button>
              </form>
            </article>
          </div>
        )}

        {integrations.length > 0 && (
          <div className="table-scroll" role="region" aria-label="Integrações ativas" tabIndex={0}>
            <table className="table">
              <thead>
                <tr><th>Canal</th><th>Nome</th><th>Status</th><th>Última sync</th><th>Erro</th></tr>
              </thead>
              <tbody>
                {integrations.map(item => (
                  <tr key={item.id}>
                    <td>{item.provider}</td>
                    <td>{item.display_name}</td>
                    <td><span className={`status ${item.status === 'active' ? 'ok' : 'warn'}`}>{item.status}</span></td>
                    <td>{item.last_sync_at ? item.last_sync_at.toLocaleString('pt-BR') : '—'}</td>
                    <td>{item.last_error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <h3>Acessos da empresa</h3>
          <span className="pill">{context.role}</span>
        </div>
        <div className="table-scroll" role="region" aria-label="Acessos" tabIndex={0}>
          <table className="table">
            <thead><tr><th>Pessoa</th><th>E-mail</th><th>Papel</th></tr></thead>
            <tbody>
              {members.map(member => (
                <tr key={member.email}><td>{member.name}</td><td>{member.email}</td><td>{member.role}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
