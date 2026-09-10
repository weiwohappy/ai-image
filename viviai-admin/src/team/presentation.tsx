import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { AllowedAction, PermissionEntry, RoleOption, TeamAction } from './contracts';
import { useFieldFeedback } from './FormField';
const reasons: Record<string, string> = {
  ADMIN_FORBIDDEN: '当前账号没有此操作权限',
  ADMIN_TEAM_WRITES_DISABLED: '当前环境未开放团队写操作',
  ADMIN_SELF_PROTECTED: '不能对本人执行此操作',
  ADMIN_TEAM_SELF_PROTECTED: '不能对本人执行此操作',
  ADMIN_TARGET_PROTECTED: '仅超级管理员可管理此账号',
  ADMIN_LAST_SUPER_ADMIN: '必须保留一位可登录的超级管理员',
  ADMIN_SUPER_ADMIN_NOT_USABLE: '请先完成账号激活，再授予超级管理员',
  ADMIN_BUILTIN_ROLE: '内置角色受保护，仅可查看',
  ADMIN_ROLE_IN_USE: '角色仍被成员或有效邀请使用，请先解除关联',
  ADMIN_ROLE_KEY_EXISTS: '角色标识已存在或被保留，请使用其他标识',
  ADMIN_INVALID_INPUT: '输入格式有误，请检查名称、角色和操作原因',
  ADMIN_NOT_FOUND: '记录不存在或不可访问，请关闭后刷新列表',
  ADMIN_VERSION_CONFLICT: '记录已被其他管理员修改，请加载最新记录',
  ADMIN_IDEMPOTENCY_CONFLICT: '此操作凭证已被使用，请关闭后重新操作',
  ADMIN_INVITATION_CONSUMED: '邀请已被使用，无法再修改',
  ADMIN_ACCOUNT_DISABLED: '请先启用该账号',
  ADMIN_INVITATION_EXISTS: '该邮箱已有邀请，请在邀请列表中处理',
  ADMIN_ACCOUNT_EXISTS: '该邮箱已有成员账号，请在成员列表中查找',
  ADMIN_INVALID_RESET: '重置链接无效、已使用或已过期，请联系管理员重新生成',
};
export function reasonText(code?: string | null) {
  return code ? (reasons[code] ?? '当前状态下不可执行此操作') : '当前账号没有此操作权限';
}
export function canAct(actions: AllowedAction[], action: TeamAction) {
  return actions.some((item) => item.action === action && item.allowed);
}
export function ActionButton({
  actions,
  action,
  enabled,
  children,
  onClick,
}: {
  actions: AllowedAction[];
  action: TeamAction;
  enabled: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  const rule = actions.find((item) => item.action === action);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!enabled || !rule?.allowed}
      title={
        !enabled
          ? reasons.ADMIN_TEAM_WRITES_DISABLED
          : !rule?.allowed
            ? reasonText(rule?.reasonCode)
            : undefined
      }
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
export function RoleTags({ roles }: { roles: RoleOption[] }) {
  return (
    <div className="team-role-tags">
      {roles.map((role) => (
        <span className="team-role-tag" key={role.key}>
          {role.name}
        </span>
      ))}
    </div>
  );
}
export function RoleChoices({
  roles,
  selected,
  onChange,
  permissions,
}: {
  roles: RoleOption[];
  selected: string[];
  onChange: (keys: string[]) => void;
  permissions: PermissionEntry[];
}) {
  const { error, errorId } = useFieldFeedback('roles');
  return (
    <fieldset
      className="team-choices"
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorId : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <legend>分配角色</legend>
      {error && (
        <p className="team-field-error" id={errorId}>
          {error}
        </p>
      )}
      {roles.map((role) => (
        <label key={role.key} className="team-choice">
          <input
            type="checkbox"
            aria-label={role.name}
            checked={selected.includes(role.key)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, role.key]
                  : selected.filter((key) => key !== role.key),
              )
            }
          />
          <span>
            <strong>{role.name}</strong>
            <small>
              {role.permissions
                .map((key) => permissions.find((p) => p.key === key)?.name ?? key)
                .join('、')}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function TeamSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value || '__all'}
      onValueChange={(next) => onChange(next === '__all' ? '' : String(next ?? ''))}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">{label}</SelectItem>
        {options.map(([key, name]) => (
          <SelectItem key={key} value={key}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function TeamPagination({
  cursors,
  nextCursor,
  loading,
  onChange,
}: {
  cursors: string[];
  nextCursor?: string | null;
  loading: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="pagination">
      <span>第 {cursors.length} 页 · 每页最多 30 条</span>
      <div>
        <Button
          variant="outline"
          disabled={loading || cursors.length === 1}
          onClick={() => onChange(cursors.slice(0, -1))}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={loading || !nextCursor}
          onClick={() => nextCursor && onChange([...cursors, nextCursor])}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
