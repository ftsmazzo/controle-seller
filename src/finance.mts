export type Cents = number;
export type BasisPoints = number;
export type OrderStatus = 'paid' | 'pending' | 'cancelled' | 'refunded';
export type ExpenseCategory = 'ads' | 'operating';
export type MetricUnit = 'BRL_CENTS' | 'RATIO';

export interface ProductCost {
  sku: string;
  costCents: Cents | null;
}

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: Cents;
  discountCents?: Cents;
  restocked?: number;
}

export interface Refund {
  amountCents: Cents;
  feeReversalCents?: Cents;
  taxReversalCents?: Cents;
}

export interface Attribution {
  source: string;
}

export interface Order {
  id?: string;
  status: OrderStatus;
  items: OrderLine[];
  discountCents?: Cents | null;
  shippingRevenueCents?: Cents | null;
  refundCents?: Cents | null;
  refunds?: Refund[];
  feesCents?: Cents | null;
  shippingCostCents?: Cents | null;
  taxCents?: Cents | null;
  packagingCents?: Cents | null;
  cashbackCents?: Cents | null;
  attribution?: Attribution | null;
  [key: string]: unknown;
}

export interface Expense {
  category: ExpenseCategory;
  amountCents: Cents;
  declaredRevenueCents?: Cents | null;
  [key: string]: unknown;
}

export interface MetricDefinition {
  readonly version: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly formula: string;
  readonly nullWhen: string;
}

export const METRICS_VERSION = '1.0.0' as const;

export const METRIC_DICTIONARY = Object.freeze({
  netRevenue: {
    version: METRICS_VERSION,
    label: 'Receita líquida',
    unit: 'BRL_CENTS',
    formula: 'produtos - descontos de linha - desconto do pedido + frete cobrado - estornos',
    nullWhen: 'Nunca; pedidos pendentes e cancelados contribuem com zero.',
  },
  contribution: {
    version: METRICS_VERSION,
    label: 'Contribuição',
    unit: 'BRL_CENTS',
    formula: 'receita líquida - CMV consumido - taxas líquidas - frete pago - impostos líquidos - embalagem - cashback',
    nullWhen: 'Algum pedido realizado possui custo obrigatório ausente.',
  },
  managerialResult: {
    version: METRICS_VERSION,
    label: 'Resultado gerencial',
    unit: 'BRL_CENTS',
    formula: 'contribuição - investimento em anúncios - despesas operacionais',
    nullWhen: 'A contribuição é desconhecida.',
  },
  declaredRoas: {
    version: METRICS_VERSION,
    label: 'ROAS declarado',
    unit: 'RATIO',
    formula: 'receita atribuída declarada pelas plataformas / investimento em anúncios',
    nullWhen: 'Não há investimento ou algum registro de anúncio não informa receita declarada.',
  },
  attributedMargin: {
    version: METRICS_VERSION,
    label: 'Margem atribuída',
    unit: 'BRL_CENTS',
    formula: 'contribuição dos pedidos atribuídos - investimento em anúncios',
    nullWhen: 'Não há pedido atribuído ou algum pedido atribuído possui custo ausente.',
  },
  coverage: {
    version: METRICS_VERSION,
    label: 'Cobertura',
    unit: 'RATIO',
    formula: 'pedidos realizados com custos completos / pedidos realizados',
    nullWhen: 'Não há pedidos realizados.',
  },
} as const satisfies Record<string, MetricDefinition>);

export type MetricKey = keyof typeof METRIC_DICTIONARY;

export interface MetricValue {
  version: typeof METRICS_VERSION;
  value: number | null;
}

export type VersionedMetrics = Record<MetricKey, MetricValue>;

export interface DataQuality {
  realizedOrders: number;
  completeCostOrders: number;
  attributionEligibleOrders: number;
  attributedOrders: number;
  costCoverage: number | null;
  attributionCoverage: number | null;
}

export interface OrderCalculation {
  gross: Cents;
  discount: Cents;
  refund: Cents;
  revenue: Cents;
  cogs: Cents | null;
  fees: Cents | null;
  variable: Cents;
  contribution: Cents | null;
  missing: string[];
  pending: boolean;
  margin: number | null;
}

export interface Summary {
  rows: Array<{ order: Order } & OrderCalculation>;
  revenue: Cents;
  knownContribution: Cents;
  contribution: Cents | null;
  adSpend: Cents;
  operating: Cents;
  missingCount: number;
  paidCount: number;
  result: Cents | null;
  margin: number | null;
  quality: DataQuality;
  metrics: VersionedMetrics;
}

export function money(value: unknown, name = 'valor'): Cents {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} deve ser um inteiro não negativo em centavos.`);
  }
  return value as number;
}

export function parseBRL(value: unknown): Cents {
  const raw = String(value).trim();
  if (!/^(?:\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})(?:,\d{1,2})?$/.test(raw)) {
    throw new Error('Use um valor como 32,90, sem símbolo de moeda.');
  }
  const [whole, fraction = ''] = raw.replaceAll('.', '').split(',');
  return money(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}

function sumSafe(values: number[], name: string): Cents {
  const total = values.reduce((sum, value) => sum + value, 0);
  return money(total, name);
}

function sumSigned(values: number[], name: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${name} deve permanecer um inteiro seguro.`);
  return total;
}

export function calculateOrder(order: Order, products: ProductCost[]): OrderCalculation {
  const valid: OrderStatus[] = ['paid', 'pending', 'cancelled', 'refunded'];
  if (!valid.includes(order.status)) throw new Error('Situação inválida.');
  if (!Array.isArray(order.items) || !order.items.length) throw new Error('Pedido sem itens.');

  let gross = 0;
  let lineDiscount = 0;
  let cogs = 0;
  const missing: string[] = [];

  for (const line of order.items) {
    const quantity = money(line.quantity, 'quantidade');
    if (!quantity) throw new Error('Quantidade deve ser maior que zero.');
    const restocked = money(line.restocked ?? 0, 'quantidade devolvida ao estoque');
    if (restocked > quantity) throw new Error('Devolução excede a quantidade vendida.');

    const lineGross = money(money(line.unitPriceCents) * quantity, 'valor bruto da linha');
    const discount = money(line.discountCents ?? 0, 'desconto da linha');
    if (discount > lineGross) throw new Error('Desconto da linha excede seu valor bruto.');
    gross = sumSafe([gross, lineGross], 'valor bruto');
    lineDiscount = sumSafe([lineDiscount, discount], 'descontos das linhas');

    const unitCost = products.find(product => product.sku === line.sku)?.costCents;
    const consumed = order.status === 'cancelled' ? 0 : quantity - restocked;
    if (consumed > 0 && unitCost == null) {
      missing.push(`Custo de ${line.sku}`);
    } else if (consumed > 0) {
      cogs = sumSafe([cogs, money(unitCost) * consumed], 'custo de mercadoria');
    }
  }

  const orderDiscount = money(order.discountCents ?? 0, 'desconto do pedido');
  const discount = sumSafe([lineDiscount, orderDiscount], 'desconto total');
  if (discount > gross) throw new Error('Desconto excede o valor dos produtos.');
  const shippingRevenue = money(order.shippingRevenueCents ?? 0);

  const refunds = order.refunds ?? [];
  if (!Array.isArray(refunds)) throw new Error('Estornos devem formar uma lista.');
  if (refunds.length > 0 && money(order.refundCents ?? 0) > 0) {
    throw new Error('Informe estornos em uma única forma.');
  }
  for (const item of refunds) {
    const amount = money(item.amountCents, 'estorno');
    const reversal = sumSafe([
      money(item.feeReversalCents ?? 0, 'reversão de taxas'),
      money(item.taxReversalCents ?? 0, 'reversão de impostos'),
    ], 'reversões');
    if (reversal > 0 && amount === 0) {
      throw new Error('Uma reversão exige estorno positivo.');
    }
  }
  const refund = refunds.length
    ? sumSafe(refunds.map(item => money(item.amountCents, 'estorno')), 'estornos')
    : money(order.refundCents ?? 0, 'estorno');
  if (refund > gross - discount + shippingRevenue) {
    throw new Error('Estorno excede o valor recebido.');
  }

  const feeReversal = sumSafe(
    refunds.map(item => money(item.feeReversalCents ?? 0, 'reversão de taxas')),
    'reversão de taxas',
  );
  const taxReversal = sumSafe(
    refunds.map(item => money(item.taxReversalCents ?? 0, 'reversão de impostos')),
    'reversão de impostos',
  );
  const fees = order.feesCents == null ? null : money(order.feesCents, 'taxas');
  const taxes = order.taxCents == null ? null : money(order.taxCents, 'impostos');
  if (feeReversal > (fees ?? 0)) throw new Error('Reversão de taxas excede as taxas cobradas.');
  if (taxReversal > (taxes ?? 0)) throw new Error('Reversão de impostos excede os impostos cobrados.');

  const revenue = order.status === 'cancelled'
    ? 0
    : money(gross - discount + shippingRevenue - refund, 'receita');
  let variable = cogs;
  const costs: Array<[Cents | null | undefined, string, Cents]> = [
    [fees, 'Taxas', feeReversal],
    [order.shippingCostCents, 'Frete pago', 0],
    [taxes, 'Impostos', taxReversal],
    [order.packagingCents, 'Embalagem', 0],
    [order.cashbackCents, 'Cashback provisionado', 0],
  ];
  for (const [value, label, reversal] of costs) {
    if (value == null) {
      missing.push(label);
    } else {
      variable = sumSafe([variable, money(value, label) - reversal], 'custos variáveis');
    }
  }

  const pending = order.status === 'pending';
  const uniqueMissing = [...new Set(missing)];
  const contribution = pending || uniqueMissing.length ? null : revenue - variable;
  return {
    gross,
    discount,
    refund,
    revenue: pending ? 0 : revenue,
    cogs: missing.some(item => item.startsWith('Custo de ')) ? null : cogs,
    fees: fees == null ? null : fees - feeReversal,
    variable,
    contribution,
    missing: uniqueMissing,
    pending,
    margin: contribution == null || revenue <= 0 ? null : contribution / revenue,
  };
}

function metric(value: number | null): MetricValue {
  return { version: METRICS_VERSION, value };
}

export function summarize(
  orders: Order[],
  products: ProductCost[],
  expenses: Expense[],
): Summary {
  for (const expense of expenses) {
    if (expense.category !== 'ads' && expense.category !== 'operating') {
      throw new Error('Categoria de despesa inválida.');
    }
  }
  const rows = orders.map(order => ({ order, ...calculateOrder(order, products) }));
  const realized = rows.filter(row => !row.pending);
  const missingCount = realized.filter(row => row.missing.length).length;
  const revenue = sumSafe(realized.map(row => row.revenue), 'receita');
  const knownContribution = sumSigned(
    realized.map(row => row.contribution ?? 0),
    'contribuição conhecida',
  );
  const adExpenses = expenses.filter(expense => expense.category === 'ads');
  const adSpend = sumSafe(
    adExpenses.map(expense => money(expense.amountCents)),
    'investimento em anúncios',
  );
  const operating = sumSafe(
    expenses
      .filter(expense => expense.category === 'operating')
      .map(expense => money(expense.amountCents)),
    'despesas operacionais',
  );
  const contribution = missingCount ? null : knownContribution;
  const result = contribution == null
    ? null
    : sumSigned([contribution, -adSpend, -operating], 'resultado gerencial');

  const attributionEligible = realized.filter(row => row.order.status !== 'cancelled');
  const attributed = attributionEligible.filter(row => Boolean(row.order.attribution?.source));
  const completeCostOrders = realized.length - missingCount;
  const quality: DataQuality = {
    realizedOrders: realized.length,
    completeCostOrders,
    attributionEligibleOrders: attributionEligible.length,
    attributedOrders: attributed.length,
    costCoverage: realized.length ? completeCostOrders / realized.length : null,
    attributionCoverage: attributionEligible.length
      ? attributed.length / attributionEligible.length
      : null,
  };

  const declaredRevenueComplete = adExpenses.length > 0
    && adExpenses.every(expense => expense.declaredRevenueCents != null);
  const declaredRevenue = declaredRevenueComplete
    ? sumSafe(
      adExpenses.map(expense => money(expense.declaredRevenueCents, 'receita declarada')),
      'receita declarada',
    )
    : null;
  const attributedContribution = attributed.length > 0
    && attributed.every(row => row.contribution != null)
    ? sumSigned(
      attributed.map(row => row.contribution ?? 0),
      'contribuição atribuída',
    )
    : null;

  return {
    rows,
    revenue,
    knownContribution,
    contribution,
    adSpend,
    operating,
    missingCount,
    paidCount: realized.filter(row => row.order.status !== 'cancelled').length,
    result,
    margin: contribution == null || revenue <= 0 ? null : contribution / revenue,
    quality,
    metrics: {
      netRevenue: metric(revenue),
      contribution: metric(contribution),
      managerialResult: metric(result),
      declaredRoas: metric(declaredRevenue == null || adSpend <= 0
        ? null
        : declaredRevenue / adSpend),
      attributedMargin: metric(attributedContribution == null
        ? null
        : sumSigned([attributedContribution, -adSpend], 'margem atribuída')),
      coverage: metric(quality.costCoverage),
    },
  };
}

export interface PriceFloorInput {
  costCents: Cents;
  shippingCents: Cents;
  packagingCents: Cents;
  feesBps: BasisPoints;
  taxBps: BasisPoints;
  targetBps: BasisPoints;
}

export function priceFloor({
  costCents,
  shippingCents,
  packagingCents,
  feesBps,
  taxBps,
  targetBps,
}: PriceFloorInput): Cents {
  [costCents, shippingCents, packagingCents, feesBps, taxBps, targetBps]
    .forEach(value => money(value));
  const denominator = 10000 - feesBps - taxBps - targetBps;
  if (denominator <= 0) {
    throw new Error('A soma de taxas, impostos e margem precisa ser menor que 100%.');
  }
  const numerator = (costCents + shippingCents + packagingCents) * 10000;
  if (!Number.isSafeInteger(numerator)) throw new Error('Valor acima do limite.');
  return Math.ceil(numerator / denominator);
}
