import test from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS_VERSION,
  METRIC_DICTIONARY,
  calculateOrder,
  summarize,
} from '../src/finance.mts';

const products = [{ sku: 'P', costCents: 3000 }];
const order = (overrides = {}) => ({
  id: '1',
  status: 'paid',
  items: [{ sku: 'P', quantity: 2, unitPriceCents: 10000 }],
  discountCents: 1000,
  shippingRevenueCents: 1000,
  refundCents: 0,
  feesCents: 1000,
  shippingCostCents: 1500,
  taxCents: 800,
  packagingCents: 200,
  cashbackCents: 500,
  ...overrides,
});

test('desconto por linha reduz a receita uma vez e se soma ao desconto do pedido', () => {
  const result = calculateOrder(order({
    items: [
      { sku: 'P', quantity: 1, unitPriceCents: 10000, discountCents: 500 },
      { sku: 'P', quantity: 1, unitPriceCents: 10000 },
    ],
  }), products);

  assert.equal(result.gross, 20000);
  assert.equal(result.discount, 1500);
  assert.equal(result.revenue, 19500);
  assert.equal(result.contribution, 9500);
});

test('devolução parcial reverte somente o custo do item que voltou ao estoque', () => {
  const result = calculateOrder(order({
    refundCents: 10000,
    items: [{ sku: 'P', quantity: 2, unitPriceCents: 10000, restocked: 1 }],
  }), products);

  assert.equal(result.cogs, 3000);
  assert.equal(result.revenue, 10000);
  assert.equal(result.contribution, 3000);
});

test('múltiplos estornos são acumulados sem permitir dupla representação', () => {
  const result = calculateOrder(order({
    refundCents: undefined,
    refunds: [{ amountCents: 3000 }, { amountCents: 2500 }],
  }), products);

  assert.equal(result.refund, 5500);
  assert.equal(result.revenue, 14500);
  assert.throws(() => calculateOrder(order({
    refundCents: 100,
    refunds: [{ amountCents: 100 }],
  }), products), /uma única forma/i);
});

test('reversão de taxa reduz o custo variável e é limitada à taxa cobrada', () => {
  const result = calculateOrder(order({
    refundCents: undefined,
    refunds: [{ amountCents: 5000, feeReversalCents: 400 }],
  }), products);

  assert.equal(result.fees, 600);
  assert.equal(result.variable, 9600);
  assert.equal(result.contribution, 5400);
  assert.throws(() => calculateOrder(order({
    refundCents: undefined,
    refunds: [{ amountCents: 100, feeReversalCents: 1001 }],
  }), products), /reversão de taxas/i);
  assert.throws(() => calculateOrder(order({
    refundCents: undefined,
    refunds: [{ amountCents: 0, feeReversalCents: 1000 }],
  }), products), /estorno positivo/i);
});

test('arredondamento monetário permanece inteiro e conservador', () => {
  const result = calculateOrder(order({
    items: [{ sku: 'P', quantity: 3, unitPriceCents: 3333, discountCents: 1 }],
    discountCents: 0,
    shippingRevenueCents: 0,
    refundCents: undefined,
    refunds: [{ amountCents: 1, feeReversalCents: 1 }],
  }), products);

  assert.equal(result.gross, 9999);
  assert.equal(result.revenue, 9997);
  assert.ok(Number.isSafeInteger(result.contribution));
});

test('qualidade distingue cobertura de custos e cobertura de atribuição', () => {
  const complete = order({ id: 'complete', attribution: { source: 'meta' } });
  const incomplete = order({ id: 'incomplete', feesCents: null });
  const summary = summarize([complete, incomplete], products, []);

  assert.deepEqual(summary.quality, {
    realizedOrders: 2,
    completeCostOrders: 1,
    attributionEligibleOrders: 2,
    attributedOrders: 1,
    costCoverage: 0.5,
    attributionCoverage: 0.5,
  });
  assert.equal(summary.metrics.coverage.value, 0.5);
});

test('métricas têm versão, fórmulas auditáveis e atribuição sem arredondar centavos', () => {
  const attributed = order({ attribution: { source: 'meta' } });
  const expenses = [
    { category: 'ads', amountCents: 3000, declaredRevenueCents: 10000 },
    { category: 'operating', amountCents: 1000 },
  ];
  const summary = summarize([attributed], products, expenses);

  assert.equal(METRICS_VERSION, '1.0.0');
  assert.deepEqual(Object.keys(METRIC_DICTIONARY), [
    'netRevenue',
    'contribution',
    'managerialResult',
    'declaredRoas',
    'attributedMargin',
    'coverage',
  ]);
  assert.ok(Object.values(METRIC_DICTIONARY).every(metric =>
    metric.version === METRICS_VERSION && metric.formula && metric.unit));
  assert.equal(summary.metrics.netRevenue.value, 20000);
  assert.equal(summary.metrics.contribution.value, 10000);
  assert.equal(summary.metrics.managerialResult.value, 6000);
  assert.equal(summary.metrics.declaredRoas.value, 10 / 3);
  assert.equal(summary.metrics.attributedMargin.value, 7000);
  assert.equal(summary.metrics.coverage.value, 1);
});

test('despesas rejeitam categorias desconhecidas e totais monetários inseguros', () => {
  assert.throws(() => summarize([order()], products, [
    { category: 'ad', amountCents: 100 },
  ]), /categoria de despesa/i);
  assert.throws(() => summarize([], products, [
    { category: 'ads', amountCents: Number.MAX_SAFE_INTEGER },
    { category: 'ads', amountCents: 1 },
  ]), /investimento em anúncios/i);
});
