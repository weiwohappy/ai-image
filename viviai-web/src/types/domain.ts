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
  version: number;
  isNew?: boolean;
  coverUrl: string;
  maxAssets: number;
  assetLabel: string;
  fields: ToolFieldSchema[];
  defaults: Pick<GenerationInput, 'modelId' | 'resolution' | 'ratio' | 'count'>;
}

export interface ToolQuoteInput {
  toolId: string;
  toolVersion: number;
  assetIds: string[];
  values: Record<string, string>;
  modelId: string;
  resolution: Resolution;
  ratio: ImageRatio;
  count: OutputCount;
}

export interface ToolRunQuote {
  quoteId: string;
  toolId: string;
  toolVersion: number;
  modelId: string;
  resolution: Resolution;
  ratio: ImageRatio;
  count: OutputCount;
  unitCredits: number;
  totalCredits: number;
  createdAt: string;
  expiresAt: string;
}

export type WorkflowColumnType = 'reference' | 'generation' | 'tool';

export interface WorkflowReferenceColumn {
  id: string;
  name: string;
  type: 'reference';
}

export interface WorkflowGenerationColumn {
  id: string;
  name: string;
  type: 'generation';
  prompt: string;
  sourceColumnIds: string[];
  modelId: string;
  resolution: Resolution;
  ratio: ImageRatio;
}

export interface WorkflowToolColumn {
  id: string;
  name: string;
  type: 'tool';
  toolId: string;
  toolVersion: number;
  sourceColumnIds: string[];
  values: Record<string, string>;
}

export type WorkflowColumn =
  | WorkflowReferenceColumn
  | WorkflowGenerationColumn
  | WorkflowToolColumn;

/** One grid row. `rowKey` is the stable identity the server quotes and reports on. */
export interface WorkflowRow {
  rowKey: string;
  cells: Record<string, string>;
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  columns: WorkflowColumn[];
  rows: WorkflowRow[];
  updatedAt: string;
}

export interface WorkflowDefinition {
  name: string;
  columns: WorkflowColumn[];
  rows: WorkflowRow[];
}

/** One priced (or rejected) row/column pair of a batch quote. */
export interface WorkflowQuoteItem {
  rowKey: string;
  columnId: string;
  columnName: string | null;
  status: 'ready' | 'invalid';
  quoteId?: string;
  modelId?: string;
  resolution?: Resolution;
  ratio?: ImageRatio;
  count?: number;
  unitCredits?: number;
  totalCredits?: number;
  createdAt?: string;
  expiresAt?: string;
  error?: { code: string; message: string };
}

export interface WorkflowRunQuote {
  quoteId: string | null;
  workflowId: string;
  workflowVersion: number;
  submittable: boolean;
  totalCredits: number;
  createdAt: string | null;
  expiresAt: string | null;
  items: WorkflowQuoteItem[];
}

export interface WorkflowRunItem {
  id: string;
  rowKey: string;
  columnKey: string;
  columnName: string | null;
  status: TaskStatus;
  errorCode: string | null;
  retryable: boolean;
  generationJobId: string;
  resultAssetIds: string[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: TaskStatus;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  cancelRequested: boolean;
  retryOfRunId: string | null;
  retryRunIds: string[];
  estimatedCredits: number;
  chargedCredits: number;
  createdAt: string;
  updatedAt: string;
  childTaskIds: string[];
  items: WorkflowRunItem[];
}

export type WorkflowQuoteRequest =
  | { workflowId: string; rowIds: string[] }
  | { retryRunId: string };

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
  | 'ACCOUNT_EXISTS'
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
  | 'PARAMETER_UNSUPPORTED'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_VERSION_CONFLICT'
  | 'INVALID_WORKFLOW_GRAPH'
  | 'INVALID_WORKFLOW_SELECTION'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_USED'
  | 'QUOTE_MISMATCH'
  | 'PRICE_CHANGED'
  | 'MODEL_CONFIG_CHANGED'
  | 'RETRY_NOT_ALLOWED'
  | 'RETRY_INPUT_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_SETTLED'
  | 'RUN_ALREADY_SETTLED'
  | 'RETRY_MISMATCH'
  | 'RETRY_UNAVAILABLE'
  | 'ORIGIN_MISMATCH';

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}
