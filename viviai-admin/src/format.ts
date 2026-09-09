import type { Cell, Kind } from './contracts';

function fixedInteger(value: string, digits: number, prefix: string): string {
  if (!/^-?\d+$/.test(value)) return '数据格式异常';
  const integer = BigInt(value);
  const negative = integer < BigInt(0);
  const raw = (negative ? -integer : integer).toString().padStart(digits + 1, '0');
  const whole = (digits ? raw.slice(0, -digits) : raw).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${prefix}${whole}${digits ? `.${raw.slice(-digits)}` : ''}`;
}
export function formatValue(value: Cell | undefined, kind?: Kind): string {
  if (value === null || value === undefined) return '暂不可用';
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
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return /^\/(?:dashboard|users|orders|jobs|attempts|models|provider-accounts|alerts|audit-events|administrators|roles)(?:\/[a-zA-Z0-9_.-]+)?$/.test(
    path,
  )
    ? path
    : null;
}
