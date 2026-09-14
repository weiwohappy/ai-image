import type { Cell, Kind } from './contracts';

function fixedInteger(value: string, digits: number, prefix: string): string {
  if (!/^-?\d+$/.test(value)) return '数据格式异常';
  const integer = BigInt(value);
  const negative = integer < BigInt(0);
  const raw = (negative ? -integer : integer).toString().padStart(digits + 1, '0');
  const whole = (digits ? raw.slice(0, -digits) : raw).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${prefix}${whole}${digits ? `.${raw.slice(-digits)}` : ''}`;
}
const statusLabels: Record<string, string> = {
  queued: '排队中',
  processing: '处理中',
  running: '执行中',
  succeeded: '已成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果未知',
  active: '有效',
  disabled: '已停用',
  pending: '待处理',
  paid: '已支付',
  unpaid: '未支付',
  closed: '已关闭',
  expired: '已过期',
  enabled: '已启用',
  open: '待处理',
  resolved: '已解除',
  pending_mfa: '待绑定 MFA',
};
/** The Chinese label for a state code, or the code itself when it is not one we know. */
export function statusLabel(value: Cell | undefined): string {
  return statusLabels[String(value)] ?? String(value);
}
export function formatValue(value: Cell | undefined, kind?: Kind): string {
  if (value === null || value === undefined) return '暂不可用';
  if (kind === 'status') return statusLabel(value);
  if (kind === 'cny') return fixedInteger(String(value), 2, '¥');
  if (kind === 'usd') return fixedInteger(String(value), 6, '$');
  if (kind === 'credits') return `${fixedInteger(String(value), 0, '')} 积分`;
  if (kind === 'datetime') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime())
      ? '时间格式异常'
      : new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(date);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
export function safeRoute(path: string): string | null {
  if (path === '/model-pricing') return path;
  if (path.startsWith('/model-pricing?')) {
    const params = new URLSearchParams(path.slice('/model-pricing?'.length));
    const value = params.get('modelId');
    return [...params.keys()].length === 1 &&
      value &&
      /^[a-zA-Z0-9_.-]+$/.test(value) &&
      value !== '.' &&
      value !== '..'
      ? `/model-pricing?modelId=${encodeURIComponent(value)}`
      : null;
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return /^\/(?:dashboard|users|orders|jobs|attempts|models|provider-accounts|alerts|audit-events|administrators|roles|workflows|batches)(?:\/[a-zA-Z0-9_.-]+)?$/.test(
    path,
  )
    ? path
    : null;
}
