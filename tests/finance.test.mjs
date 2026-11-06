import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrder, summarize, parseBRL, priceFloor } from '../dist/finance.mjs';
import { makeSeed } from '../dist/data.mjs';
const products = [{ sku: 'P', costCents: 3000 }];
const order = (overrides = {}) => ({ id: '1', status: 'paid', items: [{ sku: 'P', quantity: 2, unitPriceCents: 10000 }],
  discountCents: 1000, shippingRevenueCents: 1000, refundCents: 0, feesCents: 1000, shippingCostCents: 1500,
  taxCents: 800, packagingCents: 200, cashbackCents: 500, ...overrides });
test('shipping collected, discounts and every cost affect contribution once', () => {
  const result = calculateOrder(order(), products);
  assert.equal(result.revenue, 20000);
  assert.equal(result.contribution, 10000);
  assert.equal(result.margin, 0.5);
});
test('unknown SKU cost blocks profit instead of creating a zero cost', () => {
  const r = calculateOrder(order(), []);
  assert.equal(r.contribution, null);
  assert.equal(r.cogs, null);
  assert.ok(r.missing.includes('Custo de P'));
});
test('explicit zero cost is allowed; a missing marketplace fee is not', () => {
  assert.notEqual(calculateOrder(order(), [{ sku: 'P', costCents: 0 }]).contribution, null);
  assert.equal(calculateOrder(order({ feesCents: null }), products).contribution, null);
});
test('full refund restores only restocked product costs and keeps unrecovered fees', () => {
  const r = calculateOrder(order({ status: 'refunded', refundCents: 20000,
    items: [{ sku: 'P', quantity: 2, unitPriceCents: 10000, restocked: 2 }], taxCents: 0, cashbackCents: 0 }), products);
  assert.equal(r.revenue, 0);
  assert.equal(r.cogs, 0);
  assert.equal(r.contribution, -2700);
});
test('returned but damaged stock does not reverse COGS', () => {
  assert.equal(calculateOrder(order({ status: 'refunded', refundCents: 20000 }), products).cogs, 6000);
});
test('cancellation retains actual unrecovered charges', () => {
  const r = calculateOrder(order({ status: 'cancelled', feesCents: 400, shippingCostCents: 0,
    taxCents: 0, packagingCents: 0, cashbackCents: 0 }), products);
  assert.equal(r.revenue, 0);
  assert.equal(r.contribution, -400);
});
test('pending orders do not enter realized revenue or contribution', () => {
  const s = summarize([order({ status: 'pending' })], products, []);
  assert.equal(s.revenue, 0); assert.equal(s.knownContribution, 0); assert.equal(s.paidCount, 0);
});
test('ads and operating expenses are deducted once, after contribution', () => {
  const s = summarize([order()], products, [{ category: 'ads', amountCents: 2000 }, { category: 'operating', amountCents: 1000 }]);
  assert.equal(s.result, 7000);
});
test('one incomplete realized order blocks the aggregate result', () => {
  const s = summarize([order(), order({ feesCents: null })], products, []);
  assert.equal(s.result, null); assert.equal(s.missingCount, 1); assert.equal(s.knownContribution, 10000);
});
test('invalid amounts, returns and excessive refunds are rejected', () => {
  assert.throws(() => calculateOrder(order({ feesCents: -1 }), products));
  assert.throws(() => calculateOrder(order({ refundCents: 30000 }), products));
  assert.throws(() => calculateOrder(order({ items: [{ sku: 'P', quantity: 1, unitPriceCents: 10000, restocked: 2 }] }), products));
});
test('Brazilian currency parses without rounding ambiguity', () => {
  assert.equal(parseBRL('1.234,56'), 123456); assert.equal(parseBRL('0,01'), 1);
  assert.throws(() => parseBRL('32.90')); assert.throws(() => parseBRL('1e3'));
});
test('price floor covers percentage charges and target margin, rounded upward', () => {
  assert.equal(priceFloor({ costCents: 3000, shippingCents: 1000, packagingCents: 200, feesBps: 1500, taxBps: 500, targetBps: 2000 }), 7000);
  assert.throws(() => priceFloor({ costCents: 100, shippingCents: 0, packagingCents: 0, feesBps: 5000, taxBps: 0, targetBps: 5000 }));
});
test('all synthetic channel data is valid and includes visible unknown costs', () => {
  const seed = makeSeed();
  for (const channel of ['Nuvemshop', 'Mercado Livre', 'Shopee', 'SHEIN']) {
    const s = summarize(seed.orders.filter(o => o.channel === channel), seed.products, []);
    assert.ok(s.revenue > 0); assert.ok(s.missingCount > 0); assert.equal(s.result, null);
  }
});
