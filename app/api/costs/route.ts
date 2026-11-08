import { NextResponse } from 'next/server';
import { costVersionSchema } from '@/src/decision-product.mjs';
import { assertPermission, audit, guardMutation, readLimitedFormData, withTenant } from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { enqueueCostRecalculation } from '@/src/server/queue.mjs';
import { readSession } from '@/src/server/session.mjs';

export async function GET() {
  const session=await readSession();
  if(!session?.activeTenantId||session.mustChangePassword) return NextResponse.json({error:'Não autorizado.'},{status:401});
  const data=await withTenant(session.activeTenantId,session.userId,async(client,ctx)=>{
    assertPermission(ctx.role,'catalog:read');
    return (await client.query(`SELECT c.id,c.variant_id,c.integration_id,c.effective_at,c.unit_cost_cents::text,c.source,c.note,c.created_at,v.sku
      FROM seller.cost_channel_versions c JOIN seller.variants v ON v.tenant_id=c.tenant_id AND v.id=c.variant_id
      ORDER BY c.effective_at DESC LIMIT 500`)).rows;
  });
  return NextResponse.json({data});
}

export async function POST(request:Request) {
  const session=await readSession();
  if(!session?.activeTenantId||session.mustChangePassword) return NextResponse.json({error:'Não autorizado.'},{status:401});
  try{
    guardMutation(request,`cost:${session.userId}`,20);
    const form=await readLimitedFormData(request);
    const parsed=costVersionSchema.safeParse({
      variantId:form.get('variantId'),integrationId:form.get('integrationId')||null,
      effectiveAt:form.get('effectiveAt'),unitCostCents:form.get('unitCostCents'),note:form.get('note')||undefined,
    });
    if(!parsed.success) return NextResponse.json({error:parsed.error.flatten()},{status:400});
    const created=await withTenant(session.activeTenantId,session.userId,async(client,ctx)=>{
      assertPermission(ctx.role,'catalog:write');
      const variant=await client.query<{sku:string}>(
        `SELECT sku FROM seller.variants WHERE tenant_id=$1 AND id=$2`,
        [ctx.tenantId,parsed.data.variantId],
      );
      if(!variant.rows[0]) throw new Error('SKU não encontrado.');
      const result=await client.query<{id:string}>(`INSERT INTO seller.cost_channel_versions
        (tenant_id,variant_id,integration_id,effective_at,unit_cost_cents,source,note,created_by)
        VALUES($1,$2,$3,$4,$5,'manual',$6,$7) RETURNING id`,
      [ctx.tenantId,parsed.data.variantId,parsed.data.integrationId??null,parsed.data.effectiveAt,
        parsed.data.unitCostCents,parsed.data.note??null,ctx.userId]);
      await audit(client,ctx,'cost.version_created','cost_version',result.rows[0]!.id,{
        variantId:parsed.data.variantId,effectiveAt:parsed.data.effectiveAt.toISOString(),
      });
      const job = {
        tenantId:ctx.tenantId,variantId:parsed.data.variantId,sku:variant.rows[0].sku,
        costVersionId:result.rows[0]!.id,effectiveAt:parsed.data.effectiveAt.toISOString(),
        integrationId:parsed.data.integrationId??null,
      };
      await client.query(
        `INSERT INTO seller.cost_recalculation_outbox(tenant_id,cost_version_id,payload)
         VALUES($1,$2,$3)`,
        [ctx.tenantId,result.rows[0]!.id,job],
      );
      return job;
    });
    const queueJobId=await enqueueCostRecalculation(created);
    await withTenant(session.activeTenantId,session.userId,async client=>{
      await client.query(
        `UPDATE seller.cost_recalculation_outbox
         SET enqueued_at=now(),queue_job_id=$3,attempts=attempts+1,last_error=NULL
         WHERE tenant_id=$1 AND cost_version_id=$2 AND enqueued_at IS NULL`,
        [created.tenantId,created.costVersionId,queueJobId],
      );
    });
    return NextResponse.redirect(publicUrl('/produtos',request),303);
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:'Falha ao registrar custo.'},{status:403});
  }
}
