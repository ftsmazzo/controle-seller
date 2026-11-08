import { z } from 'zod';

export const periodSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  channel: z.string().trim().max(80).optional(),
  status: z.enum(['paid', 'pending', 'cancelled', 'refunded']).optional(),
  q: z.string().trim().max(120).optional(),
}).refine(value => value.from <= value.to, 'Período inválido.');

export const costVersionSchema = z.object({
  variantId: z.string().uuid(),
  integrationId: z.string().uuid().nullable().optional(),
  effectiveAt: z.coerce.date(),
  unitCostCents: z.coerce.number().int().min(0).max(1_000_000_000),
  note: z.string().trim().max(500).optional(),
}).strict();

export const recommendationActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['accepted', 'dismissed']),
}).strict();

export type RecommendationRule =
  | 'negative_margin' | 'missing_cost' | 'critical_stock'
  | 'campaign_margin_drain' | 'stale_sync' | 'revoked_token' | 'divergence';

export interface RecommendationCandidate {
  rule: RecommendationRule;
  fingerprint: string;
  title: string;
  severity: 'info' | 'warning' | 'critical';
  evidence: Record<string, unknown>;
  coverage: number | null;
  confidence: number | null;
  suggestedAction: string;
}

export interface DecisionSignals {
  negativeMarginOrders: Array<{ id: string; contributionCents: number }>;
  missingCostSkus: Array<{ sku: string; orders: number }>;
  criticalStock: Array<{ sku: string; stock: number }>;
  marginDrainingCampaigns: Array<{ id: string; name: string; marginAfterMediaCents: number }>;
  integrations: Array<{ id: string; provider: string; status: string; lastSyncAt: Date | null }>;
  divergences: Array<{ id: string; description: string }>;
  costCoverage: number | null;
  now?: Date;
}

export function generateRecommendations(signals: DecisionSignals): RecommendationCandidate[] {
  const now = signals.now ?? new Date();
  const result: RecommendationCandidate[] = [];
  for (const order of signals.negativeMarginOrders) result.push({
    rule: 'negative_margin', fingerprint: `negative_margin:${order.id}`,
    title: 'Pedido com margem negativa', severity: 'critical',
    evidence: { orderId: order.id, contributionCents: order.contributionCents },
    coverage: signals.costCoverage, confidence: 1,
    suggestedAction: 'Revisar preço, desconto, frete e taxas deste pedido.',
  });
  for (const item of signals.missingCostSkus) result.push({
    rule: 'missing_cost', fingerprint: `missing_cost:${item.sku}`,
    title: `Custo ausente no SKU ${item.sku}`, severity: 'critical',
    evidence: { sku: item.sku, affectedOrders: item.orders },
    coverage: signals.costCoverage, confidence: 1,
    suggestedAction: 'Cadastrar um custo com vigência anterior às vendas afetadas.',
  });
  for (const item of signals.criticalStock) result.push({
    rule: 'critical_stock', fingerprint: `critical_stock:${item.sku}`,
    title: `Estoque crítico no SKU ${item.sku}`, severity: 'warning',
    evidence: { sku: item.sku, availableUnits: item.stock },
    coverage: 1, confidence: 1,
    suggestedAction: 'Confirmar o saldo físico e planejar reposição.',
  });
  for (const campaign of signals.marginDrainingCampaigns) result.push({
    rule: 'campaign_margin_drain', fingerprint: `campaign_margin_drain:${campaign.id}`,
    title: `Campanha consumindo margem: ${campaign.name}`, severity: 'critical',
    evidence: { campaignId: campaign.id, marginAfterMediaCents: campaign.marginAfterMediaCents },
    coverage: signals.costCoverage, confidence: signals.costCoverage,
    suggestedAction: 'Revisar orçamento e segmentação; nenhuma alteração será feita automaticamente.',
  });
  for (const integration of signals.integrations) {
    if (integration.status === 'revoked') result.push({
      rule: 'revoked_token', fingerprint: `revoked_token:${integration.id}`,
      title: `Acesso revogado em ${integration.provider}`, severity: 'critical',
      evidence: { integrationId: integration.id, provider: integration.provider },
      coverage: 1, confidence: 1, suggestedAction: 'Reconectar a integração.',
    });
    const age = integration.lastSyncAt ? now.getTime() - integration.lastSyncAt.getTime() : Infinity;
    if (age > 36 * 60 * 60 * 1000) result.push({
      rule: 'stale_sync', fingerprint: `stale_sync:${integration.id}`,
      title: `Sincronização atrasada em ${integration.provider}`, severity: 'warning',
      evidence: { integrationId: integration.id, lastSyncAt: integration.lastSyncAt?.toISOString() ?? null },
      coverage: 1, confidence: 1, suggestedAction: 'Verificar a conexão e executar uma nova sincronização.',
    });
  }
  for (const divergence of signals.divergences) result.push({
    rule: 'divergence', fingerprint: `divergence:${divergence.id}`,
    title: 'Divergência detectada', severity: 'warning',
    evidence: { issueId: divergence.id, description: divergence.description },
    coverage: null, confidence: 1, suggestedAction: 'Conferir a origem e corrigir o dado na fonte.',
  });
  return result;
}

export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n');
}
