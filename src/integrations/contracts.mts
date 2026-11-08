export interface ExternalRecord {
  externalId: string;
  sourceUpdatedAt: Date;
  payload: unknown;
}
export interface PullPage {
  records: ExternalRecord[];
  nextCursor: unknown | null;
}
export interface CommerceAdapter {
  readonly provider: string;
  verifyWebhook(rawBody: Buffer, headers: Headers): Promise<boolean>;
  pullOrders(cursor: unknown | null, signal: AbortSignal): Promise<PullPage>;
}
export interface AdsAdapter {
  readonly provider: string;
  pullDailyMetrics(from: Date, to: Date, cursor: unknown | null, signal: AbortSignal): Promise<PullPage>;
}
export interface AdapterFactory {
  commerce(provider: string, credential: unknown): CommerceAdapter;
  ads(provider: string, credential: unknown): AdsAdapter;
}

export class UnsupportedAdapterError extends Error {
  constructor(provider: string) {
    super(`O conector ${provider} ainda não está implementado.`);
  }
}
