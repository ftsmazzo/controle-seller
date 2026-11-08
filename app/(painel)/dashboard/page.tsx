import Link from 'next/link';
import { readDecisionData } from '@/src/server/decision.mjs';
import { requireReadySession } from '@/src/server/session.mjs';
const brl=(value:number|null)=>value==null?'—':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
export default async function DashboardPage() {
  const session=await requireReadySession();
  const to=new Date(),from=new Date();from.setDate(to.getDate()-29);
  const data=await readDecisionData(session.activeTenantId,session.userId,{from,to});
  const s=data.summary;
  return <div className="overview">
    <div className="overview-head"><div><span className="kicker">Últimos 30 dias</span><h2>O dinheiro, do pedido ao que sobra.</h2></div>
      <p>Atualizado {s.updatedAt?new Date(s.updatedAt).toLocaleString('pt-BR'):'—'}</p></div>
    <div className="diagnostic-layout"><section className="statement">
      <div className="statement-row primary"><span>Receita líquida<small>Itens − descontos e estornos disponíveis</small></span><strong>{brl(s.revenueCents)}</strong></div>
      <div className="statement-row"><span>Contribuição<small>Receita − custos de produto conhecidos</small></span><strong>{brl(s.contributionCents)}</strong></div>
      <div className="statement-row result"><span>Resultado gerencial<small>Contribuição − mídia − despesas operacionais</small></span><strong>{brl(s.managerialResultCents)}</strong></div>
      {s.orders===0?<div className="empty"><strong>O extrato está vazio.</strong><p>Conecte uma fonte ou aguarde a primeira sincronização. Não carregamos números fictícios.</p></div>:
      s.coverage!==1&&<p className="notice">A contribuição permanece em aberto: faltam custos em {((1-(s.coverage??0))*100).toFixed(0)}% dos pedidos.</p>}
      <details className="formula-box"><summary>Como calculamos</summary><p>Receita líquida = produtos − descontos de linha − desconto do pedido + frete cobrado − estornos. Contribuição = receita líquida − CMV − taxas − frete pago − impostos − embalagem − cashback. Resultado gerencial = contribuição − mídia − despesas operacionais. Um valor fica “—” quando a fonte não cobre seus componentes.</p></details>
    </section><aside className="action-rail" aria-label="Prioridades e cobertura"><div className="coverage-mini"><span>Cobertura dos custos</span><strong>{s.coverage==null?'—':`${(s.coverage*100).toFixed(0)}%`}</strong><div role="progressbar" aria-label="Cobertura dos custos" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((s.coverage??0)*100)}><i style={{height:`${(s.coverage??0)*100}%`}}/></div></div>
      <h3>Prioridades</h3>{!data.generatedRecommendations.length?<p className="muted">Nenhuma regra encontrou evidência agora.</p>:data.generatedRecommendations.slice(0,5).map(item=><Link className="priority" href="/acoes" key={item.fingerprint}><b>{item.title}</b><small>{item.suggestedAction}</small></Link>)}
      <Link className="text-link" href="/acoes">Ver todas as ações →</Link></aside></div>
  </div>;
}
