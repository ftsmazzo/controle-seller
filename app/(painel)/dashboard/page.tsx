import Link from 'next/link';
import { listPlatformAppStatuses } from '@/src/integrations/platform-apps.mjs';
import { withTenant } from '@/src/server/core.mjs';
import { readDecisionData } from '@/src/server/decision.mjs';
import { requireReadySession } from '@/src/server/session.mjs';

const brl = (value: number | null) => value == null
  ? '—'
  : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);

export default async function DashboardPage() {
  const session = await requireReadySession();
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 29);
  const data = await readDecisionData(session.activeTenantId, session.userId, { from, to });
  const apps = await listPlatformAppStatuses();
  const connections = await withTenant(session.activeTenantId, session.userId, async client => {
    const result = await client.query<{ provider: string; status: string; display_name: string }>(
      `SELECT provider,status,display_name FROM seller.integrations
       WHERE disconnected_at IS NULL ORDER BY provider`,
    );
    return result.rows;
  });
  const s = data.summary;
  const connectedCount = connections.length;
  const configuredApps = apps.filter(app => app.configured).length;

  return (
    <div className="dash">
      <div className="dash-toolbar">
        <div>
          <span className="kicker">Inteligência de margem</span>
          <h2>Lucro real dos últimos 30 dias</h2>
          <p className="muted">
            Atualizado {s.updatedAt ? new Date(s.updatedAt).toLocaleString('pt-BR') : 'agora'} · sem números inventados
          </p>
        </div>
        <div className="dash-toolbar-actions">
          <Link className="button secondary" href="/configuracoes">Conectar canais</Link>
          <Link className="button" href="/acoes">Ver prioridades</Link>
        </div>
      </div>

      {connectedCount === 0 && (
        <section className="hero-empty">
          <div>
            <span className="eyebrow">Comece por aqui</span>
            <h3>Conecte uma loja para ver o lucro de verdade</h3>
            <p>
              Configure Nuvemshop, Shopify, Mercado Livre, Shopee e Meta Ads no painel.
              Sem EasyPanel. Sem planilha. Em poucos minutos você enxerga margem, custos e ads no mesmo lugar.
            </p>
            <Link className="button" href="/configuracoes">Abrir configurações de conexão</Link>
          </div>
          <ul className="setup-steps">
            <li className={configuredApps > 0 ? 'done' : undefined}>
              <b>1. Cadastre o app</b>
              <span>App ID e Secret no painel administrativo</span>
            </li>
            <li className={connectedCount > 0 ? 'done' : undefined}>
              <b>2. Conecte a loja</b>
              <span>Autorize Nuvemshop, Shopify, ML ou Shopee</span>
            </li>
            <li>
              <b>3. Cruze com Meta Ads</b>
              <span>ROAS e contribuição no mesmo dashboard</span>
            </li>
          </ul>
        </section>
      )}

      <section className="metric-grid" aria-label="Indicadores principais">
        <article className="metric-card accent">
          <span>Lucro gerencial</span>
          <strong>{brl(s.managerialResultCents)}</strong>
          <small>Contribuição − mídia − despesas</small>
        </article>
        <article className="metric-card">
          <span>Faturamento líquido</span>
          <strong>{brl(s.revenueCents)}</strong>
          <small>Após descontos e estornos</small>
        </article>
        <article className="metric-card">
          <span>Contribuição</span>
          <strong>{brl(s.contributionCents)}</strong>
          <small>Receita − custos conhecidos</small>
        </article>
        <article className="metric-card">
          <span>Pedidos no período</span>
          <strong>{s.orders}</strong>
          <small>Cobertura de custos {s.coverage == null ? '—' : `${(s.coverage * 100).toFixed(0)}%`}</small>
        </article>
      </section>

      <div className="dash-split">
        <section className="panel-card">
          <div className="panel-card-head">
            <h3>Extrato da margem</h3>
            <Link className="text-link" href="/pedidos">Ver pedidos →</Link>
          </div>
          <div className="statement-row primary">
            <span>Receita líquida<small>Itens − descontos − estornos + frete cobrado</small></span>
            <strong>{brl(s.revenueCents)}</strong>
          </div>
          <div className="statement-row">
            <span>Contribuição<small>Receita − CMV e taxas conhecidas</small></span>
            <strong>{brl(s.contributionCents)}</strong>
          </div>
          <div className="statement-row result">
            <span>Resultado gerencial<small>Depois de mídia e despesas operacionais</small></span>
            <strong>{brl(s.managerialResultCents)}</strong>
          </div>
          {s.orders === 0 ? (
            <div className="empty soft">
              <strong>Ainda sem pedidos sincronizados.</strong>
              <p>Quando a loja conectar, este extrato passa a mostrar o dinheiro pedido a pedido.</p>
            </div>
          ) : s.coverage !== 1 && (
            <p className="notice">
              A contribuição permanece parcial: faltam custos em {((1 - (s.coverage ?? 0)) * 100).toFixed(0)}% dos pedidos.
            </p>
          )}
        </section>

        <aside className="panel-card side-rail">
          <div className="panel-card-head">
            <h3>Canais</h3>
            <span className="pill">{connectedCount} ativos</span>
          </div>
          {connections.length === 0 ? (
            <p className="muted">Nenhuma loja ou conta de ads conectada nesta empresa.</p>
          ) : connections.map(item => (
            <div className="channel-row" key={`${item.provider}-${item.display_name}`}>
              <div>
                <b>{item.display_name}</b>
                <small>{item.provider.replace('_', ' ')}</small>
              </div>
              <span className={`status ${item.status === 'active' ? 'ok' : 'warn'}`}>{item.status}</span>
            </div>
          ))}
          <div className="panel-card-head tight">
            <h3>Prioridades</h3>
          </div>
          {!data.generatedRecommendations.length ? (
            <p className="muted">Nenhuma regra encontrou evidência agora.</p>
          ) : data.generatedRecommendations.slice(0, 4).map(item => (
            <Link className="priority" href="/acoes" key={item.fingerprint}>
              <b>{item.title}</b>
              <small>{item.suggestedAction}</small>
            </Link>
          ))}
        </aside>
      </div>
    </div>
  );
}
