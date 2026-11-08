import { NextResponse } from 'next/server';
import { periodSchema, toCsv } from '@/src/decision-product.mjs';
import { readDecisionData } from '@/src/server/decision.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET(request:Request,{params}:{params:Promise<{secao:string}>}) {
  const session=await readSession();
  if(!session?.activeTenantId||session.mustChangePassword) return NextResponse.json({error:'Não autorizado.'},{status:401});
  const url=new URL(request.url),today=new Date(),start=new Date(today);start.setDate(today.getDate()-29);
  const parsed=periodSchema.safeParse({
    from:url.searchParams.get('from')??start,to:url.searchParams.get('to')??today,
    channel:url.searchParams.get('channel')||undefined,status:url.searchParams.get('status')||undefined,
    q:url.searchParams.get('q')||undefined,
  });
  if(!parsed.success) return NextResponse.json({error:parsed.error.flatten()},{status:400});
  const data=await readDecisionData(session.activeTenantId,session.userId,parsed.data);
  const {secao}=await params;
  let headers:string[],rows:unknown[][];
  if(secao==='pedidos'){
    headers=['Pedido','Status','Data','Canal','Receita (centavos)','Contribuição (centavos)'];
    rows=data.orders.map((r:any)=>[r.external_id,r.status,new Date(r.placed_at).toISOString(),r.provider,r.revenue_cents,r.contribution_cents]);
  }else if(secao==='produtos'||secao==='estoque'){
    headers=['Produto','SKU','Canal','Preço (centavos)','Custo (centavos)','Estoque'];
    rows=data.products.map((r:any)=>[r.name,r.sku,r.provider,r.price_cents,r.cost_cents,r.stock]);
  }else if(secao==='marketing'){
    headers=['Campanha','Moeda','Gasto (centavos)','Receita declarada (centavos)','Receita atribuída (centavos)','Margem atribuída (centavos)','Pedidos vinculados'];
    rows=data.marketing.map((r:any)=>[r.name,r.currency,r.spend,r.declared,r.attributed_revenue,r.attributed_margin,r.attributed_orders]);
  }else if(secao==='recebimentos'){
    headers=['Pedido','Data','Canal','Moeda','Valor (centavos)','Conciliação'];
    rows=data.receipts.map((r:any)=>[r.external_id,new Date(r.placed_at).toISOString(),r.provider,r.currency,r.amount_cents,'Fonte bancária ausente']);
  }else if(secao==='integracoes'){
    headers=['Provedor','Nome','Status','Última sincronização','Erro'];
    rows=data.integrations.map((r:any)=>[r.provider,r.display_name,r.status,r.last_sync_at?new Date(r.last_sync_at).toISOString():'',r.last_error]);
  }else if(secao==='acoes'){
    headers=['Regra','Título','Severidade','Cobertura','Confiança','Ação sugerida','Evidências'];
    rows=data.generatedRecommendations.map(r=>[r.rule,r.title,r.severity,r.coverage,r.confidence,r.suggestedAction,JSON.stringify(r.evidence)]);
  }else if(secao==='qualidade'){
    headers=['Código','Severidade','Recurso','Detectado em','Detalhes'];
    rows=data.quality.map((r:any)=>[r.code,r.severity,r.resource_type,new Date(r.detected_at).toISOString(),JSON.stringify(r.details)]);
  }else return NextResponse.json({error:'Exportação inexistente.'},{status:404});
  return new NextResponse(toCsv(headers,rows),{headers:{
    'Content-Type':'text/csv; charset=utf-8',
    'Content-Disposition':`attachment; filename="controle-seller-${secao}.csv"`,
    'X-Content-Type-Options':'nosniff',
  }});
}
