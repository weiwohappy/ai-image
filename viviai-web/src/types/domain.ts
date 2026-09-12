export type Resolution = '0.5K' | '1K' | '2K' | '4K';
export type Quality = 'low' | 'medium' | 'high';
export type ImageRatio =
  | '21:9'
  | '16:9'
  | '3:2'
  | '5:4'
  | '4:3'
  | '1:1'
  | '4:5'
  | '3:4'
  | '2:3'
  | '9:16';
export type OutputCount = 1 | 2 | 3 | 4;
export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';
export type RemixStrength = 'similar' | 'balanced' | 'creative';

export interface User {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  planId: string;
  planName: string;
  credits: number;
  frozenCredits: number;
  concurrency: number;
  inviteCode: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  description: string;
  recommended?: boolean;
  resolutions: Resolution[];
  ratios: ImageRatio[];
  qualities?: Quality[];
  status: 'available' | 'unavailable';
  simulated?: boolean;
  formats?: Array<'png'>;
  maxReferenceImages?: number;
  unitCredits?: number;
  specs?: ModelOutputSpec[];
}

export interface ModelOutputSpec {
  id: string;
  resolution: Resolution;
  ratio: ImageRatio;
  width: number;
  height: number;
  imageSize?: string;
  unitCredits?: number;
}

export interface EstimateCreditsInput {
  modelId: string;
  resolution: Resolution;
  quality?: Quality;
  count: OutputCount;
}

export interface GenerationInput extends EstimateCreditsInput {
  prompt: string;
  ratio: ImageRatio;
  referenceAssetId?: string;
  referenceAssetIds?: string[];
  subjectAssetId?: string;
  source?: 'generation' | 'remix' | 'tool' | 'workflow';
  strength?: RemixStrength;
}

export interface GenerationQuote {
  id: string;
  input: unknown;
  inputHash: string;
  unitCredits: number;
  totalCredits: number;
  priceVersion: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface GenerationTask {
  id: string;
  input: GenerationInput;
  status: TaskStatus;
  progress: number;
  estimatedCredits: number;
  chargedCredits: number;
  createdAt: string;
  updatedAt: string;
  resultAssetIds: string[];
  stage?: string;
  cancelRequested?: boolean;
  items?: Array<{
    id: string;
    ordinal: number;
    status: TaskStatus;
    resultAssetId?: string | null;
    errorCode?: string | null;
  }>;
  templateId?: string;
  templateVersion?: number;
  remixStrength?: RemixStrength;
  toolId?: string;
  workflowId?: string;
  batchId?: string;
  workflowRowId?: string;
  workflowColumnId?: string;
  mockLifecycle?: {
    processingAt: string;
    completionAt: string;
    outcome: 'success' | 'partial' | 'failure';
  };
  errorCode?: ApiErrorCode;
  errorMessage?: string;
}

export type AssetSource = 'generation' | 'remix' | 'tool' | 'workflow' | 'upload';

export interface ImageAsset {
  id: string;
  name: string;
  imageUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  source: AssetSource;
  modelId?: string;
  favorite: boolean;
  createdAt: string;
  prompt?: string;
  templateId?: string;
  templateVersion?: number;
  remixStrength?: RemixStrength;
}

export interface Inspiration {
  id: string;
  title: string;
  imageUrl: string;
  prompt: string;
  category: string;
  creator: string;
  likes: number;
  liked: boolean;
}

export interface VisualAnalysis {
  composition: string;
  palette: string[];
  lighting: string;
  camera: string;
  typographyZone: string;
  avoid: string[];
}

export interface ViralTemplate {
  id: string;
  version: number;
  title: string;
  coverUrl: string;
  category: string;
  platform: string;
  industry: string;
  style: string;
  tags: string[];
  recommendedModelId: string;
  recommendedRatio: ImageRatio;
  sourceType: 'platform' | 'licensed-user' | 'brand' | 'public-domain';
  popularityLabel: string;
  remixCount: number;
  favorite: boolean;
  status: 'active' | 'inactive';
  analysis: VisualAnalysis;
}

export interface UploadedReference {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface RemixInput extends EstimateCreditsInput {
  referenceAssetId?: string;
  templateId?: string;
  templateVersion?: number;
  adaptation: string;
  strength: RemixStrength;
  ratio: ImageRatio;
  subjectAssetId?: string;
}

export interface ToolFieldOption {
  label: string;
  value: string;
}

export interface ToolFieldSchema {
  id: string;
  label: string;
  type: 'text' | 'select' | 'radio';
  required: boolean;
  options?: ToolFieldOption[];
}

export interface ToolTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  isNew?: boolean;
  coverUrl: string;
  maxAssets: number;
  assetLabel: string;
  fields: ToolFieldSchema[];
  defaults: Pick<GenerationInput, 'modelId' | 'resolution' | 'ratio' | 'count'>;
}

export type WorkflowColumnType = 'reference' | 'generation' | 'tool';

export interface WorkflowColumn {
  id: string;
  name: string;
  type: WorkflowColumnType;
  prompt?: string;
  sourceColumnIds?: string[];
  modelId?: string;
  resolution?: Resolution;
  ratio?: ImageRatio;
}

export interface WorkflowRow {
  id: string;
  cells: Record<string, string | undefined>;
  selected: boolean;
  status: TaskStatus | 'idle';
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  saved: boolean;
  columns: WorkflowColumn[];
  rows: WorkflowRow[];
  updatedAt: string;
}

export interface BatchTask {
  id: string;
  workflowId: string;
  workflowName: string;
  total: number;
  completed: number;
  processing: number;
  failed: number;
  estimatedCredits: number;
  status: TaskStatus;
  createdAt: string;
  childTaskIds: string[];
}

export interface Plan {
  id: string;
  name: string;
  cycle: 'month' | 'quarter' | 'year' | 'enterprise';
  price: number | null;
  originalPrice: number | null;
  credits: number | null;
  concurrency: number | null;
  durationDays: number | null;
  features: string[];
}

export interface PointLedgerEntry {
  id: string;
  type: 'register' | 'freeze' | 'consume' | 'refund' | 'purchase' | 'redeem' | 'invite';
  description: string;
  delta: number;
  balance: number;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  type: 'task' | 'credits' | 'billing' | 'system';
  title: string;
  content: string;
  read: boolean;
  createdAt: string;
  href?: string;
}

export interface Order {
  id: string;
  planId: string;
  amount: number;
  channel: 'alipay' | 'wechat';
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
}

export interface InviteRelation {
  id: string;
  username: string;
  reward: number;
  status: 'pending' | 'rewarded';
  createdAt: string;
}

export type ApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CODE'
  | 'INVALID_INPUT'
  | 'USERNAME_TAKEN'
  | 'EMAIL_TAKEN'
  | 'INSUFFICIENT_CREDITS'
  | 'CONCURRENCY_LIMIT'
  | 'MODEL_UNAVAILABLE'
  | 'TEMPLATE_UNAVAILABLE'
  | 'ASSET_INVALID'
  | 'CONTENT_REJECTED'
  | 'NOTIFICATION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REDEMPTION_INVALID_OR_EXPIRED'
  | 'REDEMPTION_LIMIT_REACHED'
  | 'INVALID_INVITE_CODE'
  | 'TASK_TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'PARAMETER_UNSUPPORTED';

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}
