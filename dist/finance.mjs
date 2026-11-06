// Monetary values are integer BRL cents. Null means unknown, never zero.
export function money(value, name = 'valor') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(name + ' deve ser um inteiro não negativo em centavos.');
  return value;
}
export function parseBRL(value) {
  const raw = String(value).trim();
  if (!/^(?:\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})(?:,\d{1,2})?$/.test(raw)) throw new Error('Use um valor como 32,90, sem símbolo de moeda.');
  const [whole, fraction = ''] = raw.replaceAll('.', '').split(',');
  return money(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
export function calculateOrder(order, products) {
  const valid = ['paid', 'pending', 'cancelled', 'refunded'];
  if (!valid.includes(order.status)) throw new Error('Situação inválida.');
  if (!Array.isArray(order.items) || !order.items.length) throw new Error('Pedido sem itens.');
  let gross = 0, cogs = 0;
  const missing = [];
  for (const line of order.items) {
    const quantity = money(line.quantity, 'quantidade');
    if (!quantity) throw new Error('Quantidade deve ser maior que zero.');
    const restocked = money(line.restocked ?? 0, 'quantidade devolvida ao estoque');
    if (restocked > quantity) throw new Error('Devolução excede a quantidade vendida.');
    gross += money(line.unitPriceCents) * quantity;
    const unitCost = products.find(p => p.sku === line.sku)?.costCents;
    const consumed = order.status === 'cancelled' ? 0 : quantity - restocked;
    if (consumed > 0 && unitCost == null) missing.push('Custo de ' + line.sku);
    else if (consumed > 0) cogs += money(unitCost) * consumed;
  }
  money(gross); money(cogs);
  const discount = money(order.discountCents ?? 0);
  if (discount > gross) throw new Error('Desconto excede o valor dos produtos.');
  const shippingRevenue = money(order.shippingRevenueCents ?? 0);
  const refund = money(order.refundCents ?? 0);
  if (refund > gross - discount + shippingRevenue) throw new Error('Estorno excede o valor recebido.');
  const revenue = order.status === 'cancelled' ? 0 : gross - discount + shippingRevenue - refund;
  const costs = ['feesCents', 'shippingCostCents', 'taxCents', 'packagingCents', 'cashbackCents'];
  const labels = ['Taxas', 'Frete pago', 'Impostos', 'Embalagem', 'Cashback provisionado'];
  let variable = cogs;
  costs.forEach((key, index) => {
    if (order[key] == null) missing.push(labels[index]);
    else variable += money(order[key]);
  });
  money(variable);
  const pending = order.status === 'pending';
  const contribution = pending || missing.length ? null : revenue - variable;
  return { gross, revenue: pending ? 0 : revenue, cogs: missing.some(s => s.startsWith('Custo de ')) ? null : cogs,
    variable, contribution, missing: [...new Set(missing)], pending,
    margin: contribution == null || revenue <= 0 ? null : contribution / revenue };
}
export function summarize(orders, products, expenses) {
  const rows = orders.map(order => ({ order, ...calculateOrder(order, products) }));
  const realized = rows.filter(r => !r.pending);
  const missingCount = realized.filter(r => r.missing.length).length;
  const revenue = realized.reduce((sum, r) => sum + r.revenue, 0);
  const knownContribution = realized.reduce((sum, r) => sum + (r.contribution ?? 0), 0);
  const adSpend = expenses.filter(e => e.category === 'ads').reduce((s, e) => s + money(e.amountCents), 0);
  const operating = expenses.filter(e => e.category !== 'ads').reduce((s, e) => s + money(e.amountCents), 0);
  const contribution = missingCount ? null : knownContribution;
  return { rows, revenue, knownContribution, contribution, adSpend, operating, missingCount,
    paidCount: realized.filter(r => r.order.status !== 'cancelled').length,
    result: contribution == null ? null : contribution - adSpend - operating,
    margin: contribution == null || revenue <= 0 ? null : contribution / revenue };
}
export function priceFloor({ costCents, shippingCents, packagingCents, feesBps, taxBps, targetBps }) {
  [costCents, shippingCents, packagingCents, feesBps, taxBps, targetBps].forEach(v => money(v));
  const denominator = 10000 - feesBps - taxBps - targetBps;
  if (denominator <= 0) throw new Error('A soma de taxas, impostos e margem precisa ser menor que 100%.');
  const numerator = (costCents + shippingCents + packagingCents) * 10000;
  if (!Number.isSafeInteger(numerator)) throw new Error('Valor acima do limite.');
  return Math.ceil(numerator / denominator);
}
