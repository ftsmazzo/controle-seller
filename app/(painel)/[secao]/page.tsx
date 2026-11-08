import { notFound } from 'next/navigation';
import { periodSchema } from '@/src/decision-product.mjs';
import { readDecisionData } from '@/src/server/decision.mjs';
import { requireReadySession } from '@/src/server/session.mjs';
import { PriceSimulator } from '@/app/components/decision-tools';

const sections = ['pedidos','produtos','marketing','estoque','recebimentos','qualidade','acoes','integracoes'] as const;
type Section = typeof sections[number];
const titles: Record<Section,string> = {
  pedidos:'Pedidos', produtos:'Produtos e SKUs', marketing:'Marketing', estoque:'Estoque',
  recebimentos:'Recebimentos', qualidade:'Qualidade dos dados', acoes:'Ações', integracoes:'Integrações',
};
const brl = (value:unknown) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value)/100);
const date = (value:unknown) => value ? new Date(String(value)).toLocaleString('pt-BR') : '—';

function Empty({ children }:{ children:React.ReactNode }) {
  return <div className="empty"><strong>Nada para mostrar neste período.</strong><p>{children}</p></div>;
}
function Filters({ values }:{ values:Record<string,string|undefined> }) {
  return <form className="filters" method="get">
    <label>De<input type="date" name="from" defaultValue={values.from}/></label>
    <label>Até<input type="date" name="to" defaultValue={values.to}/></label>
    <label>Canal<select name="channel" defaultValue={values.channel ?? ''}><option value="">Todos</option><option value="nuvemshop">Nuvemshop</option><option value="manual">Manual</option></select></label>
    <label>Status<select name="status" defaultValue={values.status ?? ''}><option value="">Todos</option><option value="paid">Pago</option><option value="pending">Pendente</option><option value="refunded">Estornado</option><option value="cancelled">Cancelado</option></select></label>
    <label className="search">Busca<input name="q" defaultValue={values.q} placeholder="Pedido, produto ou SKU"/></label>
    <button className="button" type="submit">Aplicar</button>
  </form>;
}

export default async function SectionPage({ params, searchParams }:{
  params:Promise<{secao:string}>; searchParams:Promise<Record<string,string|undefined>>;
}) {
  const { secao:raw } = await params;
  if (!sections.includes(raw as Section)) notFound();
  const secao = raw as Section;
  const query = await searchParams;
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate()-29);
  const defaults = { from:start.toISOString().slice(0,10), to:today.toISOString().slice(0,10) };
  const parsed = periodSchema.safeParse({ ...defaults, ...query, channel:query.channel||undefined, status:query.status||undefined, q:query.q||undefined });
  const filter = parsed.success ? parsed.data : { from:start,to:today };
  const session = await requireReadySession();
  const data = await readDecisionData(session.activeTenantId,session.userId,filter);
  const values = { ...query, from:query.from??defaults.from, to:query.to??defaults.to };
  return <div className="decision-page">
    <header className="page-head"><div><span className="kicker">Mesa de controle</span><h2>{titles[secao]}</h2></div>
      <a className="text-link" href={`/api/exports/${secao}?${new URLSearchParams(values as Record<string,string>)}`}>Exportar CSV</a></header>
    <Filters values={values}/>
    {secao==='pedidos' && <section className="ledger">
      <div className="section-title"><h3>Memória de cálculo por pedido</h3><p>Valores importados e custos vigentes na data da venda.</p></div>
      {!data.orders.length ? <Empty>Conecte um canal ou amplie o período. Nenhum pedido de exemplo é criado.</Empty> :
      data.orders.map((order:any)=><details className="ledger-row" key={order.id}>
        <summary><span><b>#{order.external_id}</b><small>{date(order.placed_at)} · {order.provider??'sem canal'}</small></span>
          <span>{brl(order.revenue_cents)}<small>Contribuição {order.contribution_cents==null?'não calculável':brl(order.contribution_cents)}</small></span></summary>
        <div className="calculation">
          {(order.lines as any[]).map(line=><div key={line.id}><span>{line.quantity} × {line.sku||'SKU não informado'}</span>
            <span>{brl(Number(line.unitPriceCents)*line.quantity-Number(line.discountCents))} − {line.unitCostCents==null?'custo ausente':brl(Number(line.unitCostCents)*line.quantity)}</span></div>)}
          <p className="formula">Contribuição conhecida = venda dos itens − descontos − custo vigente. Taxas, frete pago, impostos e embalagem não são presumidos quando a fonte não os informa.</p>
        </div>
      </details>)}
    </section>}
    {secao==='produtos' && <div className="split">
      <section className="ledger"><div className="section-title"><h3 id="custos-title">Custos vigentes</h3><p>Versões são append-only e respeitam a data da venda.</p></div>
        {!data.products.length?<Empty>Os produtos aparecerão após uma integração ou cadastro autorizado.</Empty>:
        <><p className="scroll-hint">Deslize horizontalmente para ver todas as colunas.</p><div className="table-scroll" role="region" aria-labelledby="custos-title" tabIndex={0}><table className="table"><caption className="sr-only">Custos vigentes por produto e SKU</caption><thead><tr><th scope="col">Produto / SKU</th><th scope="col">Canal</th><th scope="col">Preço</th><th scope="col">Custo</th><th scope="col">Vigência</th></tr></thead><tbody>
          {data.products.map((item:any)=><tr key={item.variant_id}><td><b>{item.name}</b><small>{item.sku}</small></td><td>{item.provider??'Geral'}</td><td>{item.price_cents==null?'—':brl(item.price_cents)}</td><td>{item.cost_cents==null?<span className="status warn">Ausente</span>:brl(item.cost_cents)}</td><td>{date(item.cost_effective_at)}</td></tr>)}
        </tbody></table></div></>}
      </section><aside className="action-rail"><h3>Novo custo</h3><form className="stack compact" action="/api/costs" method="post">
        <label>SKU<select name="variantId" required><option value="">Selecione</option>{data.products.map((p:any)=><option key={p.variant_id} value={p.variant_id}>{p.sku} · {p.name}</option>)}</select></label>
        <label>Vigência<input type="datetime-local" name="effectiveAt" required/></label><label>Custo (centavos)<input type="number" min="0" name="unitCostCents" required/></label>
        <label>Nota<input name="note" maxLength={500}/></label><button className="button">Registrar versão</button></form><PriceSimulator/></aside>
    </div>}
    {secao==='marketing' && <section className="ledger"><div className="section-title"><h3 id="marketing-title">Plataforma × resultado observado</h3><p>Janela de 28 dias · evidence-last-touch-v1. Associação observacional, não demonstra causalidade ou incrementalidade.</p></div>
      {!data.marketing.length?<Empty>Não há insights de mídia no período. ROAS não é estimado sem dados da plataforma.</Empty>:
      <><p className="scroll-hint">Deslize horizontalmente para ver todas as colunas.</p><div className="table-scroll" role="region" aria-labelledby="marketing-title" tabIndex={0}><table className="table"><caption className="sr-only">Resultado observado por campanha</caption><thead><tr><th scope="col">Campanha</th><th scope="col">Gasto</th><th scope="col">ROAS declarado</th><th scope="col">Receita atribuída</th><th scope="col">Margem após mídia</th><th scope="col">Pedidos vinculados</th></tr></thead><tbody>
        {data.marketing.map((row:any)=><tr key={row.id}><td>{row.name}</td><td>{brl(row.spend)}</td><td>{Number(row.spend)>0?(Number(row.declared)/Number(row.spend)).toFixed(2):'—'}</td><td>{brl(row.attributed_revenue)}</td><td>{brl(Number(row.attributed_margin)-Number(row.spend))}</td><td>{row.attributed_orders}</td></tr>)}
      </tbody></table></div></>}
    </section>}
    {secao==='estoque' && <section className="ledger"><div className="section-title"><h3>Saldo informado pelo canal</h3><p>Sem previsão ou reposição presumida.</p></div>
      {!data.products.some((p:any)=>p.stock!=null)?<Empty>Nenhuma integração forneceu saldo de estoque.</Empty>:
      <div className="stock-list">{data.products.filter((p:any)=>p.stock!=null).map((p:any)=>{
        const critical = Number(p.stock) <= 3;
        return <div key={p.variant_id}><span><b>{p.sku}</b><small>{p.name}</small></span><strong className={`stock-value${critical?' negative':''}`}>{critical?'Estoque crítico: ':''}{p.stock} un.</strong></div>;
      })}</div>}
    </section>}
    {secao==='recebimentos' && <section className="ledger"><div className="section-title"><h3 id="recebimentos-title">Vendas pagas</h3><p>Valores de pedidos pagos; liquidação bancária só será exibida quando houver fonte de pagamentos.</p></div>
      {!data.receipts.length?<Empty>Nenhum pedido pago no período.</Empty>:<><p className="scroll-hint">Deslize horizontalmente para ver todas as colunas.</p><div className="table-scroll" role="region" aria-labelledby="recebimentos-title" tabIndex={0}><table className="table"><caption className="sr-only">Vendas pagas no período</caption><thead><tr><th scope="col">Pedido</th><th scope="col">Data</th><th scope="col">Canal</th><th scope="col">Valor</th><th scope="col">Conciliação</th></tr></thead><tbody>
        {data.receipts.map((r:any)=><tr key={r.id}><td>#{r.external_id}</td><td>{date(r.placed_at)}</td><td>{r.provider??'—'}</td><td>{brl(r.amount_cents)}</td><td><span className="status warn">Sem fonte bancária</span></td></tr>)}
      </tbody></table></div></>}
    </section>}
    {secao==='qualidade' && <div className="split"><section className="ledger"><div className="section-title"><h3>Cobertura auditável</h3><p>Estado por métrica, fonte e atualização.</p></div>
      <div className="quality-list"><div><span>Receita de pedidos</span><b className="status ok">{data.summary.orders?'Confirmada':'Ausente'}</b><small>Pedidos importados · {date(data.summary.updatedAt)}</small></div>
        <div><span>Custos dos itens</span><b className={data.summary.coverage===1?'status ok':'status warn'}>{data.summary.coverage==null?'Ausente':data.summary.coverage===1?'Confirmada':'Incompleta'}</b><small>{data.summary.coverage==null?'Sem pedidos':`${(data.summary.coverage*100).toFixed(1)}% dos pedidos`}</small></div>
        <div><span>Taxas, frete e impostos</span><b className="status warn">Ausente</b><small>O conector atual não fornece esses campos normalizados</small></div></div>
      {!data.quality.length?<Empty>Nenhuma ocorrência adicional de qualidade foi detectada no período.</Empty>:data.quality.map((issue:any)=><div className="issue" key={issue.id}><b>{issue.code}</b><span>{issue.resource_type} · {date(issue.detected_at)}</span></div>)}
    </section><aside className="coverage-ruler"><span>Cobertura de custos</span><div className="ruler" role="progressbar" aria-label="Cobertura de custos" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((data.summary.coverage??0)*100)}><i style={{height:`${(data.summary.coverage??0)*100}%`}}/></div><strong>{data.summary.coverage==null?'—':`${(data.summary.coverage*100).toFixed(0)}%`}</strong></aside></div>}
    {secao==='acoes' && <section className="ledger"><div className="section-title"><h3>Fila de decisões</h3><p>Regras determinísticas; nenhuma ação é executada automaticamente.</p></div>
      {!data.generatedRecommendations.length?<Empty>Nenhuma regra encontrou evidência no período.</Empty>:data.generatedRecommendations.map(item=><article className="recommendation" key={item.fingerprint}>
        <div><span className={`status ${item.severity==='critical'?'bad':'warn'}`}>{item.severity==='critical'?'Crítica':'Atenção'}</span><h3>{item.title}</h3><p>{item.suggestedAction}</p>
          <small>Regra {item.rule} · confiança {item.confidence==null?'—':`${item.confidence*100}%`} · cobertura {item.coverage==null?'—':`${(item.coverage*100).toFixed(0)}%`}</small></div>
        <pre>{JSON.stringify(item.evidence,null,2)}</pre></article>)}
      <form action="/api/recommendations/refresh" method="post"><input type="hidden" name="from" value={values.from}/><input type="hidden" name="to" value={values.to}/><button className="button">Persistir diagnóstico atual</button></form>
    </section>}
    {secao==='integracoes' && <section className="ledger"><div className="section-title"><h3>Fontes conectadas</h3><p>Saúde, escopo e última atualização.</p></div>
      {!data.integrations.length?<Empty>Nenhuma fonte conectada. Configure Nuvemshop ou Meta para começar.</Empty>:data.integrations.map((item:any)=><div className="integration-row" key={item.id}><div><b>{item.display_name}</b><small>{item.provider}</small></div><span className={`status ${item.status==='active'?'ok':'bad'}`}>{item.status}</span><span>Atualizado {date(item.last_sync_at)}</span>{item.last_error&&<small className="negative">{item.last_error}</small>}</div>)}
      <a className="button inline" href="/configuracoes">Gerenciar conexões</a>
    </section>}
  </div>;
}
