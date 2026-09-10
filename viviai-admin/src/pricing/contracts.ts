export type PriceAction = 'create' | 'edit' | 'enable' | 'disable';
export type PriceState = { unitCredits: number; enabled: boolean; version: number };
export interface ModelPriceRow {
  modelId: string;
  name: string;
  provider: string;
  resolution: string;
  specs: { id: string; resolution: string; ratio: string; width: number; height: number }[];
  priceId: string | null;
  unitCredits: number | null;
  enabled: boolean;
  version: number;
  updatedAt: string | null;
  runtimeAvailable: boolean;
  availabilityReason: 'unpriced' | 'price_disabled' | 'runtime_unavailable' | 'available';
  allowedActions: { action: PriceAction; allowed: boolean; reasonCode: string | null }[];
}
export interface ModelPriceList {
  items: ModelPriceRow[];
  asOf: string;
  writeEnabled: boolean;
}
export interface ModelPriceHistory {
  items: {
    id: string;
    createdAt: string;
    actor: string;
    modelId: string;
    resolution: string;
    action: string;
    before: PriceState | null;
    after: PriceState;
  }[];
  asOf: string;
  nextCursor: string | null;
}
