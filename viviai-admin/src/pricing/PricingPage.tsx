import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import type { AdminActor } from '../contracts';
import type { AdminClient } from '../http';
import { useAdminQuery } from '../useQuery';
import { formatValue } from '../format';
import { TeamSelect } from '../team/presentation';
import type { ModelPriceList, ModelPriceRow, PriceAction } from './contracts';
import { PriceEditor } from './PriceEditor';
import { PriceHistory } from './PriceHistory';

const labels: Record<PriceAction, string> = {
  create: '配置',
  edit: '编辑',
  enable: '启用',
  disable: '停用',
};
export function PricingPage({
  client,
  actor,
  writeEnabled,
  onPermissionsChanged,
  initialModelId = '',
}: {
  client: AdminClient;
  actor: AdminActor;
  writeEnabled: boolean;
  onPermissionsChanged: () => Promise<void>;
  initialModelId?: string;
}) {
  const [modelId, setModelId] = useState(initialModelId);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<{
    row: ModelPriceRow;
    action: PriceAction;
    saved?: boolean;
  }>();
  const [history, setHistory] = useState<ModelPriceRow>();
  const query = useAdminQuery<ModelPriceList>(
    client,
    `/model-pricing${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`,
    revision,
  );
  const permission = actor.permissions.includes('model-pricing.write');
  const write = permission && writeEnabled && query.data?.writeEnabled === true;
  const editorAllowed =
    write &&
    query.data?.items.some(
      (row) =>
        row.modelId === editor?.row.modelId &&
        row.resolution === editor?.row.resolution &&
        row.allowedActions.some((rule) => rule.action === editor.action && rule.allowed),
    );
  useEffect(() => {
    if (editor && (!permission || !writeEnabled || (!editor.saved && !editorAllowed)))
      setEditor(undefined);
  }, [editor, editorAllowed, permission, writeEnabled]);
  const refresh = () => setRevision((n) => n + 1);
  const models = Array.from(
    new Map((query.data?.items ?? []).map((row) => [row.modelId, row.name])).entries(),
  );
  return (
    <div className="team-page pricing-page">
      <div className="notices">
        按模型和分辨率设置单张积分；同档位下已支持比例同价。未配置或停用价格时不接受新任务，API
        是否就绪单独显示。
      </div>
      {(!writeEnabled || query.data?.writeEnabled === false) && (
        <p className="caption">当前环境未开放积分定价写操作</p>
      )}
      {!permission && <p className="caption">当前账号仅可查看积分定价</p>}
      <section className="panel">
        <div className="query-toolbar">
          <TeamSelect
            label="全部模型"
            value={modelId}
            options={models}
            onChange={(value) => {
              setModelId(value);
              setEditor(undefined);
              setHistory(undefined);
            }}
          />
          {modelId && (
            <Button variant="ghost" onClick={() => setModelId('')}>
              清除筛选
            </Button>
          )}
          <Button variant="outline" disabled={query.loading} onClick={refresh}>
            <RefreshCw size={15} />
            刷新
          </Button>
          <span className="pricing-secondary">单张积分 × 张数 = 预估总积分</span>
        </div>
        {query.loading ? (
          <p className="loading-state" role="status">
            正在读取积分定价…
          </p>
        ) : query.error ? (
          <p className="error-banner" role="alert">
            {query.error}
          </p>
        ) : !query.data?.items.length ? (
          <p className="empty-state">没有符合条件的模型规格</p>
        ) : (
          <Table className="team-table pricing-table">
            <TableHeader>
              <TableRow>
                <TableHead>模型 / 分辨率</TableHead>
                <TableHead>已支持比例与像素</TableHead>
                <TableHead>单张积分</TableHead>
                <TableHead>价格状态</TableHead>
                <TableHead>生成可用状态</TableHead>
                <TableHead>版本 / 更新时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((row) => {
                const state = row.priceId === null ? '未配置' : row.enabled ? '已启用' : '已停用';
                const actions: PriceAction[] =
                  row.priceId === null ? ['create'] : ['edit', row.enabled ? 'disable' : 'enable'];
                return (
                  <TableRow key={`${row.modelId}:${row.resolution}`}>
                    <TableCell>
                      <strong>{row.name}</strong>
                      <span className="pricing-resolution">{row.resolution}</span>
                      <small className="team-email">
                        {row.modelId} · {row.provider}
                      </small>
                    </TableCell>
                    <TableCell>
                      <details className="pricing-specs">
                        <summary>{row.specs.length} 种比例</summary>
                        <ul>
                          {row.specs.map((spec) => (
                            <li key={spec.id}>
                              {spec.ratio} · {spec.width} × {spec.height}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </TableCell>
                    <TableCell className="pricing-credits">
                      {row.unitCredits === null ? '—' : formatValue(row.unitCredits, 'credits')}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`pricing-state ${row.priceId && row.enabled ? 'pricing-active' : ''}`}
                      >
                        {state}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span>
                        {!row.runtimeAvailable
                          ? 'API 未就绪'
                          : row.availabilityReason === 'available'
                            ? '可接受新报价'
                            : '价格未启用'}
                      </span>
                      <small className="pricing-secondary pricing-block">
                        {row.runtimeAvailable
                          ? '配置就绪，不代表调用已实测'
                          : '仅配置积分不会启用渠道'}
                      </small>
                    </TableCell>
                    <TableCell>
                      v{row.version}
                      <small className="pricing-secondary pricing-block">
                        {row.updatedAt ? formatValue(row.updatedAt, 'datetime') : '尚未保存'}
                      </small>
                    </TableCell>
                    <TableCell>
                      <div className="team-row-actions">
                        {write &&
                          actions
                            .filter((action) =>
                              row.allowedActions.some(
                                (rule) => rule.action === action && rule.allowed,
                              ),
                            )
                            .map((action) => (
                              <Button
                                key={action}
                                size="sm"
                                variant="outline"
                                aria-label={`${labels[action]} ${row.modelId} ${row.resolution}`}
                                onClick={() => setEditor({ row, action })}
                              >
                                {labels[action]}
                              </Button>
                            ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`历史 ${row.modelId} ${row.resolution}`}
                          onClick={() => setHistory(row)}
                        >
                          历史
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
      {query.data && (
        <p className="caption">
          数据截至 {formatValue(query.data.asOf, 'datetime')}（上海时间）·
          价格按张计费，已提交任务保留原价
        </p>
      )}
      {editor && permission && writeEnabled && (editor.saved || editorAllowed) && (
        <PriceEditor
          key={`${editor.row.modelId}:${editor.row.resolution}:${editor.action}`}
          {...editor}
          client={client}
          onClose={() => setEditor(undefined)}
          onChanged={() => {
            // Keep only the read-only success acknowledgement during the post-save refresh.
            setEditor((current) => (current ? { ...current, saved: true } : current));
            refresh();
          }}
          onPermissionsChanged={async () => {
            setEditor(undefined);
            await onPermissionsChanged();
          }}
        />
      )}
      {history && (
        <PriceHistory
          key={`${history.modelId}:${history.resolution}:${revision}`}
          row={history}
          client={client}
          onClose={() => setHistory(undefined)}
        />
      )}
    </div>
  );
}
