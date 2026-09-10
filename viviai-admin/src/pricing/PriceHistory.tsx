import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { AdminClient } from '../http';
import { useAdminQuery } from '../useQuery';
import { formatValue } from '../format';
import { TeamPagination } from '../team/presentation';
import type { ModelPriceRow, ModelPriceHistory, PriceState } from './contracts';

const stateText = (state: PriceState | null) =>
  state
    ? `${formatValue(state.unitCredits, 'credits')} · ${state.enabled ? '已启用' : '已停用'} · v${state.version}`
    : '未配置';
export function PriceHistory({
  row,
  client,
  onClose,
}: {
  row: ModelPriceRow;
  client: AdminClient;
  onClose: () => void;
}) {
  const [cursors, setCursors] = useState(['']);
  const [revision, setRevision] = useState(0);
  const query = useAdminQuery<ModelPriceHistory>(
    client,
    `/model-pricing/${encodeURIComponent(row.modelId)}/history?resolution=${encodeURIComponent(row.resolution)}&limit=30${cursors.at(-1) ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ''}`,
    revision,
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="team-sheet" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>积分定价历史</SheetTitle>
          <SheetDescription>
            {row.name} · {row.resolution} · {row.modelId}。历史记录仅供查看。
          </SheetDescription>
        </SheetHeader>
        <div className="team-sheet-body stack">
          <div className="team-page-toolbar">
            <Button
              variant="outline"
              disabled={query.loading}
              onClick={() => {
                setCursors(['']);
                setRevision((n) => n + 1);
              }}
            >
              刷新历史
            </Button>
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
          </div>
          {query.loading ? (
            <p role="status">正在读取价格历史…</p>
          ) : query.error ? (
            <p className="error-banner" role="alert">
              {query.error}
            </p>
          ) : !query.data?.items.length ? (
            <p className="empty-state">暂无价格变更记录</p>
          ) : (
            <ol className="pricing-history">
              {query.data.items.map((event) => (
                <li key={event.id}>
                  <div className="team-page-toolbar">
                    <strong>{event.actor}</strong>
                    <time dateTime={event.createdAt}>
                      {formatValue(event.createdAt, 'datetime')}
                    </time>
                  </div>
                  <p>
                    {stateText(event.before)} → {stateText(event.after)}
                  </p>
                  <p className="pricing-secondary">
                      {event.action === 'model-pricing.import' ? '离线导入' : '价格配置'} ·{' '}
                    {event.resolution}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <TeamPagination
            cursors={cursors}
            nextCursor={query.data?.nextCursor}
            loading={query.loading}
            onChange={setCursors}
          />
          {query.data && (
            <p className="caption">
              数据截至 {formatValue(query.data.asOf, 'datetime')}（上海时间）
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
