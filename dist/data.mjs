// Catalog names/prices are references from uzemy.com.br. Every sale, cost,
// inventory count and settlement below is fictional; no store API is connected.
export const channels = ['Nuvemshop', 'Mercado Livre', 'Shopee', 'SHEIN'];
export const productsSeed = [
  { sku: 'TEE-SIG-PRE-M', name: 'T-shirt Oversized Signature', variant: 'Preta · M', priceCents: 7990, costCents: 2850, stock: 12, minStock: 6, color: '#c5b3dd' },
  { sku: 'TEE-BRA-AZU-P', name: 'Tee Brasil Sunset', variant: 'Azul · P', priceCents: 5990, costCents: 2100, stock: 4, minStock: 8, color: '#c6dce4' },
  { sku: 'MOL-BRO-CIN-M', name: 'Moletom Crop Over Brooklyn', variant: 'Cinza · M', priceCents: 9990, costCents: 4200, stock: 8, minStock: 4, color: '#d5d7d4' },
  { sku: 'TEE-BLE-OFF-G', name: 'Tee Blessed Minimal', variant: 'Off-white · G', priceCents: 4790, costCents: 1950, stock: 3, minStock: 6, color: '#ede4d2' },
  { sku: 'SHO-COM-PRE-M', name: 'Short Comfy', variant: 'Preto · M', priceCents: 7990, costCents: 3100, stock: 16, minStock: 5, color: '#b8babf' },
  { sku: 'ECO-MY-CRU-U', name: 'Ecobag My', variant: 'Cru · Único', priceCents: 4990, costCents: null, stock: 7, minStock: 3, color: '#d9cbb4' }
];
export function makeSeed() {
  const orders = [];
  for (let i = 0; i < 60; i++) {
    const product = productsSeed[i % productsSeed.length];
    const channel = channels[Math.floor(i / 15)];
    const day = i % 5 + 1;
    const status = i % 17 === 0 ? 'cancelled' : i % 13 === 0 ? 'refunded' : i % 11 === 0 ? 'pending' : 'paid';
    const quantity = i % 4 === 0 ? 2 : 1;
    const discountCents = status === 'cancelled' ? 0 : i % 7 === 0 ? 500 : 0;
    const gross = quantity * product.priceCents;
    const shippingRevenueCents = gross >= 14900 ? 0 : 1290;
    const received = gross - discountCents + shippingRevenueCents;
    orders.push({ id: 'DEMO-' + (1040 + i), date: '2026-11-0' + day, channel, status,
      items: [{ sku: product.sku, quantity, unitPriceCents: product.priceCents, restocked: status === 'refunded' ? quantity : 0 }],
      discountCents, shippingRevenueCents, refundCents: status === 'refunded' ? received : 0,
      feesCents: status === 'cancelled' ? 0 : Math.round(received * [0.045, 0.16, 0.19, 0.18][Math.floor(i / 15)]),
      shippingCostCents: status === 'cancelled' ? 0 : 1850,
      taxCents: ['cancelled', 'refunded'].includes(status) ? 0 : Math.round((gross - discountCents) * 0.04),
      packagingCents: status === 'cancelled' ? 0 : 180, cashbackCents: 0 });
  }
  const expenses = channels.flatMap((channel, i) => [
    { id: 'ads-' + i, date: '2026-11-03', channel, category: 'ads', description: 'Publicidade · ' + channel, amountCents: [8500, 4500, 4000, 3200][i] },
    { id: 'op-' + i, date: '2026-11-01', channel, category: 'operating', description: 'Despesas operacionais alocadas · ' + channel, amountCents: 3500 }
  ]);
  return { version: 1, products: structuredClone(productsSeed), orders, expenses };
}
