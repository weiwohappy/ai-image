import { useState, type FormEvent } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { AdminTable } from './contracts';
import { AdminClient } from './http';
import { useAdminQuery } from './useQuery';
import { DataTable } from './DataTable';

type FilterConfig = {
  dated?: boolean;
  user?: boolean;
  model?: boolean;
  statuses?: [string, string][];
  sources?: [string, string][];
};
const routeFilters: Record<string, FilterConfig> = {
  '/users': { dated: true },
  '/credit-lots': { dated: true },
  '/credit-events': {
    dated: true,
    statuses: [
      ['paid_grant', '购买发放'],
      ['promotional_grant', '赠送发放'],
      ['freeze', '冻结'],
      ['consume', '消费'],
      ['release', '释放'],
      ['expire', '过期'],
    ],
  },
  '/orders': {
    dated: true,
    user: true,
    statuses: [
      ['creating', '创建中'],
      ['pending', '待支付'],
      ['paid', '已支付'],
      ['fulfilled', '已发放积分'],
    ],
    sources: [
      ['wechat', '微信支付'],
      ['alipay', '支付宝'],
    ],
  },
  '/jobs': {
    dated: true,
    user: true,
    model: true,
    statuses: [
      ['queued', '排队中'],
      ['submitting', '提交中'],
      ['pending', '等待上游'],
      ['unknown', '结果未知'],
      ['materializing', '图片入库中'],
      ['succeeded', '已成功'],
      ['failed', '失败'],
      ['cancelled', '已取消'],
    ],
    sources: [
      ['create', '文生图'],
      ['remix', '爆款复刻'],
    ],
  },
  '/models': {
    statuses: [
      ['enabled', '已启用'],
      ['disabled', '未启用'],
    ],
  },
  '/provider-accounts': {},
  '/alerts': {
    dated: true,
    statuses: [
      ['active', '待处理'],
      ['resolved', '已解除'],
    ],
    sources: [
      ['unknown_attempt', '上游结果未知'],
      ['overdue_reservation', '积分冻结超时'],
      ['missing_materialization', '图片入库异常'],
      ['budget_80_percent', '成本预算预警'],
    ],
  },
  '/audit-events': {
    dated: true,
    statuses: [
      ['allowed', '允许'],
      ['denied', '拒绝'],
    ],
  },
  '/administrators': {
    dated: true,
    statuses: [
      ['pending', '待激活'],
      ['active', '已激活'],
      ['disabled', '已禁用'],
    ],
  },
  '/roles': {},
};

export function ResourcePage(props: { path: string; client: AdminClient; permissions: string[] }) {
  return <ResourceQuery key={props.path} {...props} />;
}
function ResourceQuery({
  path,
  client,
  permissions,
}: {
  path: string;
  client: AdminClient;
  permissions: string[];
}) {
  const [draft, setDraft] = useState({
    q: '',
    status: '',
    from: '',
    to: '',
    userId: '',
    modelId: '',
    source: '',
  });
  const [filters, setFilters] = useState('');
  const [cursors, setCursors] = useState<string[]>(['']);
  const [revision, setRevision] = useState(0);
  const [validation, setValidation] = useState('');
  const searchable = true;
  const filterConfig =
    routeFilters[
      path.endsWith('/credit-events')
        ? '/credit-events'
        : path.endsWith('/credit-lots')
          ? '/credit-lots'
          : path
    ] ?? {};
  const dated = filterConfig.dated;
  const cursor = cursors[cursors.length - 1];
  const query = useAdminQuery<AdminTable>(
    client,
    `${path}?limit=30${filters}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    revision,
  );
  const detailResource = ['/users', '/orders', '/jobs', '/models'].includes(path)
    ? path
    : undefined;
  const statuses = (filterConfig.statuses ?? []).map(([value, label]) => ({ value, label }));
  const sources = filterConfig.sources ?? [];
  const userFilter = filterConfig.user;
  function search(event: FormEvent) {
    event.preventDefault();
    setValidation('');
    if (draft.from && draft.to && draft.from > draft.to) {
      setValidation('结束时间不能早于开始时间');
      return;
    }
    const params = new URLSearchParams();
    if (searchable && draft.q.trim()) params.set('q', draft.q.trim());
    if (statuses.length && draft.status) params.set('status', draft.status);
    if (userFilter && draft.userId.trim()) params.set('userId', draft.userId.trim());
    if (filterConfig.model && draft.modelId.trim()) params.set('modelId', draft.modelId.trim());
    if (sources.length && draft.source) params.set('source', draft.source);
    if (dated && draft.from)
      params.set('from', new Date(`${draft.from}T00:00:00+08:00`).toISOString());
    if (dated && draft.to)
      params.set('to', new Date(`${draft.to}T23:59:59.999+08:00`).toISOString());
    setFilters(params.size ? `&${params.toString()}` : '');
    setCursors(['']);
    setRevision((n) => n + 1);
  }
  return (
    <section className="panel">
      <form className="query-toolbar" onSubmit={search}>
        {searchable && (
          <div className="search-field">
            <Search size={16} />
            <Input
              aria-label="精确搜索"
              placeholder={
                path === '/users'
                  ? '精确输入用户 ID / 邮箱'
                  : path === '/orders'
                    ? '精确输入订单 ID / 订单号'
                    : path === '/models'
                      ? '精确输入模型 ID'
                      : path === '/jobs'
                        ? '精确输入任务 ID'
                        : path === '/administrators'
                          ? '精确输入成员 ID / 邮箱'
                          : path === '/provider-accounts'
                            ? '精确输入账户范围 ID'
                            : path === '/roles'
                              ? '精确输入角色 ID'
                              : '精确输入记录 ID'
              }
              value={draft.q}
              maxLength={254}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
        )}
        {statuses.length > 0 && (
          <Select
            value={draft.status || 'all'}
            onValueChange={(value) =>
              setDraft({ ...draft, status: value === 'all' ? '' : (value ?? '') })
            }
          >
            <SelectTrigger aria-label="状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {statuses.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {userFilter && (
          <Input
            className="scope-filter"
            aria-label="用户 ID"
            placeholder="按用户 ID 筛选"
            maxLength={36}
            value={draft.userId}
            onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
          />
        )}
        {filterConfig.model && (
          <Input
            className="scope-filter"
            aria-label="模型 ID"
            placeholder="按模型 ID 筛选"
            maxLength={100}
            value={draft.modelId}
            onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
          />
        )}
        {sources.length > 0 && (
          <Select
            value={draft.source || 'all'}
            onValueChange={(value) =>
              setDraft({ ...draft, source: value === 'all' ? '' : (value ?? '') })
            }
          >
            <SelectTrigger aria-label="来源筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              {sources.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {dated && (
          <div className="date-fields">
            <label>
              起始日
              <Input
                aria-label="起始日"
                type="date"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <span>—</span>
            <label>
              结束日
              <Input
                aria-label="结束日"
                type="date"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
          </div>
        )}
        {(searchable || dated) && (
          <Button type="submit" disabled={query.loading}>
            查询
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => setRevision((n) => n + 1)}
          disabled={query.loading}
        >
          <RefreshCw size={15} />
          刷新
        </Button>
      </form>
      {validation && (
        <p className="error-banner" role="alert">
          {validation}
        </p>
      )}
      {query.loading ? (
        <div className="loading-state" role="status">
          正在读取记录…
        </div>
      ) : query.error ? (
        <p className="error-banner" role="alert">
          {query.error}
        </p>
      ) : (
        query.data && (
          <DataTable table={query.data} permissions={permissions} detailResource={detailResource} />
        )
      )}
      <div className="pagination">
        <span>第 {cursors.length} 页 · 每页最多 30 条</span>
        <div>
          <Button
            variant="outline"
            disabled={cursors.length === 1 || query.loading}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={!query.data?.nextCursor || query.loading}
            onClick={() => {
              if (query.data?.nextCursor)
                setCursors((values) => [...values, query.data!.nextCursor!]);
            }}
          >
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
