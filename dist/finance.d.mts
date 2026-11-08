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
export declare const METRICS_VERSION: "1.0.0";
export declare const METRIC_DICTIONARY: Readonly<{
    readonly netRevenue: {
        readonly version: "1.0.0";
        readonly label: "Receita líquida";
        readonly unit: "BRL_CENTS";
        readonly formula: "produtos - descontos de linha - desconto do pedido + frete cobrado - estornos";
        readonly nullWhen: "Nunca; pedidos pendentes e cancelados contribuem com zero.";
    };
    readonly contribution: {
        readonly version: "1.0.0";
        readonly label: "Contribuição";
        readonly unit: "BRL_CENTS";
        readonly formula: "receita líquida - CMV consumido - taxas líquidas - frete pago - impostos líquidos - embalagem - cashback";
        readonly nullWhen: "Algum pedido realizado possui custo obrigatório ausente.";
    };
    readonly managerialResult: {
        readonly version: "1.0.0";
        readonly label: "Resultado gerencial";
        readonly unit: "BRL_CENTS";
        readonly formula: "contribuição - investimento em anúncios - despesas operacionais";
        readonly nullWhen: "A contribuição é desconhecida.";
    };
    readonly declaredRoas: {
        readonly version: "1.0.0";
        readonly label: "ROAS declarado";
        readonly unit: "RATIO";
        readonly formula: "receita atribuída declarada pelas plataformas / investimento em anúncios";
        readonly nullWhen: "Não há investimento ou algum registro de anúncio não informa receita declarada.";
    };
    readonly attributedMargin: {
        readonly version: "1.0.0";
        readonly label: "Margem atribuída";
        readonly unit: "BRL_CENTS";
        readonly formula: "contribuição dos pedidos atribuídos - investimento em anúncios";
        readonly nullWhen: "Não há pedido atribuído ou algum pedido atribuído possui custo ausente.";
    };
    readonly coverage: {
        readonly version: "1.0.0";
        readonly label: "Cobertura";
        readonly unit: "RATIO";
        readonly formula: "pedidos realizados com custos completos / pedidos realizados";
        readonly nullWhen: "Não há pedidos realizados.";
    };
}>;
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
    rows: Array<{
        order: Order;
    } & OrderCalculation>;
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
export declare function money(value: unknown, name?: string): Cents;
export declare function parseBRL(value: unknown): Cents;
export declare function calculateOrder(order: Order, products: ProductCost[]): OrderCalculation;
export declare function summarize(orders: Order[], products: ProductCost[], expenses: Expense[]): Summary;
export interface PriceFloorInput {
    costCents: Cents;
    shippingCents: Cents;
    packagingCents: Cents;
    feesBps: BasisPoints;
    taxBps: BasisPoints;
    targetBps: BasisPoints;
}
export declare function priceFloor({ costCents, shippingCents, packagingCents, feesBps, taxBps, targetBps, }: PriceFloorInput): Cents;
//# sourceMappingURL=finance.d.mts.map