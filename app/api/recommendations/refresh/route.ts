import { NextResponse } from 'next/server';
import { periodSchema } from '@/src/decision-product.mjs';
import { persistRecommendations, readDecisionData } from '@/src/server/decision.mjs';
import { assertPermission, audit, guardMutation, readLimitedFormData, withTenant } from '@/src/server/core.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function POST(request:Request) {
  const session=await readSession();
  if(!session?.activeTenantId||session.mustChangePassword) return NextResponse.json({error:'Não autorizado.'},{status:401});
  try{
    guardMutation(request,`recommendations:${session.userId}`,10);
    const form=await readLimitedFormData(request);
    const parsed=periodSchema.safeParse({from:form.get('from'),to:form.get('to')});
    if(!parsed.success) return NextResponse.json({error:parsed.error.flatten()},{status:400});
    const data=await readDecisionData(session.activeTenantId,session.userId,parsed.data);
    await withTenant(session.activeTenantId,session.userId,async(client,ctx)=>{
      assertPermission(ctx.role,'finance:read');
      if(ctx.role==='viewer') throw new Error('Somente analyst, admin ou owner pode atualizar recomendações.');
      await persistRecommendations(client,ctx.tenantId,parsed.data,data.generatedRecommendations);
      await audit(client,ctx,'recommendations.refreshed','recommendation',undefined,{
        from:parsed.data.from.toISOString(),to:parsed.data.to.toISOString(),count:data.generatedRecommendations.length,
      });
    });
    return NextResponse.redirect(new URL('/acoes',request.url),303);
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:'Falha ao atualizar diagnóstico.'},{status:403});
  }
}
