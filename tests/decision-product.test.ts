import { describe,expect,it } from 'vitest';
import { costVersionSchema,csvCell,generateRecommendations,toCsv } from '../src/decision-product.mts';

describe('motor determinístico de recomendações',()=>{
  it('gera somente regras sustentadas por evidência e sem ação automática',()=>{
    const result=generateRecommendations({
      negativeMarginOrders:[{id:'o1',contributionCents:-1200}],
      missingCostSkus:[{sku:'=RISCO',orders:2}],
      criticalStock:[{sku:'A',stock:1}],
      marginDrainingCampaigns:[{id:'c1',name:'Busca',marginAfterMediaCents:-300}],
      integrations:[
        {id:'i1',provider:'meta',status:'revoked',lastSyncAt:null},
        {id:'i2',provider:'nuvemshop',status:'active',lastSyncAt:new Date('2026-01-01T00:00:00Z')},
      ],
      divergences:[{id:'d1',description:'Totais diferentes'}],costCoverage:.5,
      now:new Date('2026-01-03T00:00:00Z'),
    });
    expect(result.map(item=>item.rule)).toEqual(expect.arrayContaining([
      'negative_margin','missing_cost','critical_stock','campaign_margin_drain',
      'revoked_token','stale_sync','divergence',
    ]));
    expect(result.every(item=>item.suggestedAction.length>0)).toBe(true);
  });
  it('não inventa recomendações em estado vazio',()=>{
    expect(generateRecommendations({
      negativeMarginOrders:[],missingCostSkus:[],criticalStock:[],marginDrainingCampaigns:[],
      integrations:[],divergences:[],costCoverage:null,
    })).toEqual([]);
  });
});

describe('exportação e validação',()=>{
  it('neutraliza fórmulas em CSV',()=>{
    expect(csvCell('=2+2')).toBe('"\'=2+2"');
    expect(toCsv(['nome'],[['@SUM(A1)']])).toContain('"\'@SUM(A1)"');
  });
  it('valida custo versionado',()=>{
    expect(costVersionSchema.safeParse({
      variantId:'7a2f2bb0-8427-4ad0-bf61-6fbd8ae5a923',
      effectiveAt:'2026-11-01T10:00:00Z',unitCostCents:1250,
    }).success).toBe(true);
    expect(costVersionSchema.safeParse({
      variantId:'inválido',effectiveAt:'hoje',unitCostCents:-1,
    }).success).toBe(false);
  });
});
