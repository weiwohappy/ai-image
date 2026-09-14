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
/** An operation an administrator may attempt on a batch, and the rule that blocks it. */
export interface BatchAction {
  action: 'cancel' | 'retryFailed';
  allowed: boolean;
  reasonCode: string | null;
}
export interface BatchDetail extends AdminDetail {
  actions: BatchAction[];
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
