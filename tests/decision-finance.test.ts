import { describe,expect,it } from 'vitest';
import {
  calculateDecisionOrder,
  summarizeDecisionFacts,
  type DecisionOrderFact,
} from '../src/server/decision-finance.mts';

const completeOrder: DecisionOrderFact = {
  id:'complete',status:'paid',grossCents:20_000,lineDiscountCents:500,
  orderDiscountCents:1_000,shippingRevenueCents:1_000,refundCents:3_000,
  cogsCents:6_000,feesCents:600,shippingCostCents:1_500,taxCents:600,
  packagingCents:200,cashbackCents:500,
};

describe('agregação financeira da decisão',()=>{
  it('calcula pedido completo sem duplicar descontos, estornos, custos ou reversões',()=>{
    const result=calculateDecisionOrder(completeOrder);
    expect(result.revenueCents).toBe(16_500);
    expect(result.contributionCents).toBe(7_100);
    expect(result.complete).toBe(true);
  });

  it('mantém contribuição e resultado gerencial nulos com pedido incompleto',()=>{
    const result=summarizeDecisionFacts([
      completeOrder,
      {...completeOrder,id:'incomplete',feesCents:null},
    ],[]);
    expect(result.coverage).toBe(0.5);
    expect(result.knownContributionCents).toBe(7_100);
    expect(result.contributionCents).toBeNull();
    expect(result.managerialResultCents).toBeNull();
  });

  it('deduz anúncios e despesas operacionais somente após cobertura completa',()=>{
    const result=summarizeDecisionFacts([completeOrder],[
      {category:'ads',amountCents:3_000},
      {category:'operating',amountCents:1_000},
    ]);
    expect(result.contributionCents).toBe(7_100);
    expect(result.adSpendCents).toBe(3_000);
    expect(result.operatingExpenseCents).toBe(1_000);
    expect(result.managerialResultCents).toBe(3_100);
  });
});
