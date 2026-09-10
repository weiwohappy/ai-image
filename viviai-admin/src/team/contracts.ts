export type TeamAction =
  | 'create'
  | 'edit'
  | 'assignRoles'
  | 'enable'
  | 'disable'
  | 'resetPassword'
  | 'rotate'
  | 'revoke'
  | 'delete';
export interface AllowedAction {
  action: TeamAction;
  allowed: boolean;
  reasonCode: string | null;
}
export interface RoleOption {
  key: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
}
export interface TeamMember {
  id: string;
  email: string;
  displayName: string;
  status: 'pending' | 'active' | 'disabled';
  activated: boolean;
  roles: RoleOption[];
  version: number;
  createdAt: string;
  allowedActions: AllowedAction[];
}
export interface TeamInvitation {
  id: string;
  email: string;
  displayName: string;
  roles: RoleOption[];
  status: 'pending' | 'expired' | 'revoked' | 'consumed';
  version: number;
  expiresAt: string;
  createdAt: string;
  allowedActions: AllowedAction[];
}
export interface TeamRole extends RoleOption {
  description: string;
  version: number;
  memberCount: number;
  invitationCount: number;
  allowedActions: AllowedAction[];
}
export interface TeamList<T> {
  items: T[];
  nextCursor: string | null;
  asOf: string;
  allowedActions: AllowedAction[];
}
export interface PermissionEntry {
  key: string;
  name: string;
  module: string;
  dependencies: string[];
  customRoleAllowed: boolean;
}
export interface PermissionCatalog {
  permissions: PermissionEntry[];
  assignableRoles: RoleOption[];
  writeEnabled: boolean;
}
export interface TeamMutationResult {
  resourceId: string;
  version: number;
  link?: string;
  linkUnavailable?: boolean;
  expiresAt?: string;
}
export interface TeamCommandMeta {
  expectedVersion?: number;
  reason: string;
}
