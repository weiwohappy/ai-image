export type ContentKind = 'inspirations' | 'remix-templates' | 'tools';
export type Lifecycle = 'draft' | 'published' | 'offline' | 'archived';

export interface ContentBase {
  resourceId: string;
  id: string;
  externalId: string;
  description: string;
  category: string;
  creatorName?: string | null;
  sourceType?: 'platform' | 'licensed-user' | 'brand' | 'public-domain' | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  defaultModelId: string;
  defaultOutputSpecId: string;
  coverMediaExternalId: string;
  status: Lifecycle;
  sortOrder: number;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InspirationRecord extends ContentBase {
  title: string;
  editorialLabel?: string | null;
  baseLikes: number;
  tags: string[];
  defaultPrompt: string;
  caseMediaExternalId?: string;
}

export interface RemixTemplateRecord extends ContentBase {
  title: string;
  platform: string;
  industry: string;
  style: string;
  popularityLabel?: string | null;
  baseRemixCount: number;
  tags: string[];
  visualAnalysis: {
    composition: string;
    palette: string[];
    lighting: string;
    camera: string;
    typographyZone: string;
    avoid: string[];
  };
  defaultPrompt: string;
  defaultParameters: { strength?: 'similar' | 'balanced' | 'creative' };
  referenceMediaExternalId?: string;
}

export interface ToolRecord extends ContentBase {
  name: string;
  fields: Array<{
    id: string;
    label: string;
    type: 'text' | 'select' | 'radio';
    required: boolean;
    options?: Array<{ label: string; value: string }>;
  }>;
  promptTemplate: string;
  defaults: { modelId: string; resolution: string; ratio: string; count: number };
  maxAssets: number;
  maxOutputCount: number;
  assetLabel: string;
  iconMediaExternalId?: string;
  isNew: boolean;
}

export type ContentRecord = InspirationRecord | RemixTemplateRecord | ToolRecord;
export interface ContentPage<T = ContentRecord> {
  rows: T[];
  nextCursor: string | null;
}

export interface ContentMediaRecord {
  resourceId: string;
  id: string;
  externalId: string;
  contentType: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  status: Lifecycle;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
}

export type ContentMediaPage = ContentPage<ContentMediaRecord>;
