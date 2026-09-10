export type Cell = string | number | boolean | null;
export type Kind = 'text' | 'status' | 'datetime' | 'credits' | 'cny' | 'usd';
export interface Column {
  key: string;
  label: string;
  kind?: Kind;
  link?: 'users' | 'orders' | 'jobs' | 'attempts';
}
export interface AdminTable {
  title: string;
  columns: Column[];
  rows: Array<{ id: string } & Record<string, Cell>>;
  nextCursor: string | null;
  asOf: string;
  notices: string[];
}
export interface AdminDetail {
  id: string;
  title: string;
  fields: Array<{ label: string; value: string | null; kind?: Kind }>;
  tables: AdminTable[];
  notices: string[];
  sensitive?: { jobId: string; assetIds: string[] };
}
export interface AdminActor {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  sessionExpiresAt: string;
}
export interface Dashboard {
  asOf: string;
  environment: string;
  metrics: Array<{
    key: string;
    label: string;
    value: string | null;
    kind?: Kind;
    note: string;
    href?: string;
  }>;
  alerts: AdminTable;
  notices: string[];
}
export interface AdminStatus {
  enabled: boolean;
  environment: string;
  stage: 'A' | 'B1';
  teamWritesEnabled?: boolean;
  modelPricingWritesEnabled?: boolean;
  localTestPasswords?: boolean;
  localPasswordLogin?: boolean;
}
export interface AuthChallenge {
  next: 'mfa' | 'enroll';
  expiresAt: string;
  secret?: string;
  otpauthUri?: string;
}
export interface AuthResult {
  account: AdminActor;
  recoveryCodes?: string[];
}
export interface SensitiveGrant {
  id: string;
  expiresAt: string;
}
export interface SensitiveData {
  prompt: string;
  assets: Array<{
    id: string;
    role: string;
    width: number | null;
    height: number | null;
    previewPath: string;
  }>;
}
