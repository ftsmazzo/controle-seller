export interface DecisionOrderFact {
  id: string;
  status: 'paid' | 'pending' | 'cancelled' | 'refunded';
  grossCents: number;
  lineDiscountCents: number;
  orderDiscountCents: number;
  shippingRevenueCents: number;
  refundCents: number;
  cogsCents: number | null;
  feesCents: number | null;
  shippingCostCents: number | null;
  taxCents: number | null;
  packagingCents: number | null;
  cashbackCents: number | null;
}

export interface DecisionExpenseFact {
  category: 'ads' | 'operating';
  amountCents: number;
}

export interface CalculatedDecisionOrder extends DecisionOrderFact {
  revenueCents: number;
  contributionCents: number | null;
  complete: boolean;
}

function safeSum(values: number[], label: string): number {
  const value = values.reduce((total, item) => total + item, 0);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} excede o limite monetário seguro.`);
  return value;
}

export function calculateDecisionOrder(fact: DecisionOrderFact): CalculatedDecisionOrder {
  const revenueCents = fact.status === 'pending' || fact.status === 'cancelled'
    ? 0
    : Math.max(0, safeSum([
      fact.grossCents,
      -fact.lineDiscountCents,
      -fact.orderDiscountCents,
      fact.shippingRevenueCents,
      -fact.refundCents,
    ], 'Receita líquida'));
  const costs = [
    fact.cogsCents,
    fact.feesCents,
    fact.shippingCostCents,
    fact.taxCents,
    fact.packagingCents,
    fact.cashbackCents,
  ];
  const complete = costs.every(value => value !== null);
  const contributionCents = fact.status === 'pending' || !complete
    ? null
    : safeSum([revenueCents, ...costs.map(value => -(value ?? 0))], 'Contribuição');
  return { ...fact, revenueCents, contributionCents, complete };
}

export function summarizeDecisionFacts(
  facts: DecisionOrderFact[],
  expenses: DecisionExpenseFact[],
) {
  const orders = facts.map(calculateDecisionOrder);
  const realized = orders.filter(order => order.status !== 'pending');
  const complete = realized.filter(order => order.complete);
  const revenueCents = safeSum(realized.map(order => order.revenueCents), 'Receita líquida');
  const knownContributionCents = safeSum(
    complete.map(order => order.contributionCents ?? 0),
    'Contribuição conhecida',
  );
  const adSpendCents = safeSum(
    expenses.filter(item => item.category === 'ads').map(item => item.amountCents),
    'Investimento em anúncios',
  );
  const operatingExpenseCents = safeSum(
    expenses.filter(item => item.category === 'operating').map(item => item.amountCents),
    'Despesas operacionais',
  );
  const contributionCents = complete.length === realized.length ? knownContributionCents : null;
  return {
    orders,
    orderCount: realized.length,
    revenueCents,
    knownContributionCents,
    contributionCents,
    managerialResultCents: contributionCents === null
      ? null
      : safeSum(
        [contributionCents, -adSpendCents, -operatingExpenseCents],
        'Resultado gerencial',
      ),
    coverage: realized.length ? complete.length / realized.length : null,
    adSpendCents,
    operatingExpenseCents,
  };
}
