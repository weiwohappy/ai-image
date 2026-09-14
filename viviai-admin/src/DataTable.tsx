import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableCaption,
} from '@/components/ui/table';
import type { ReactNode } from 'react';
import type { AdminTable } from './contracts';
import { formatValue, safeRoute } from './format';
import { routePermission } from './navigation';

export function Notices({ items }: { items: string[] }) {
  return items.length ? (
    <div className="notices">
      {items.map((notice, i) => (
        <p key={i}>{notice}</p>
      ))}
    </div>
  ) : null;
}
export function DataTable({
  table,
  permissions = [],
  detailResource,
  rowAction,
}: {
  table: AdminTable;
  permissions?: string[];
  detailResource?: string;
  rowAction?: (row: AdminTable['rows'][number]) => ReactNode;
}) {
  const hasTrailingColumn = Boolean(detailResource || rowAction);
  return (
    <div className="data-block">
      <Notices items={table.notices} />
      <Table>
        <TableCaption>
          {table.title} · 数据截至 {formatValue(table.asOf, 'datetime')}（上海时间）
        </TableCaption>
        <TableHeader>
          <TableRow>
            {table.columns.map((column) => (
              <TableHead key={column.key}>{column.label}</TableHead>
            ))}
            {hasTrailingColumn && (
              <TableHead>
                <span className="sr-only">操作</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.length ? (
            table.rows.map((row) => (
              <TableRow key={row.id}>
                {table.columns.map((column) => {
                  const value = row[column.key];
                  const text = formatValue(value, column.kind);
                  const path =
                    column.link && typeof value === 'string'
                      ? safeRoute(`/${column.link}/${value}`)
                      : null;
                  const permission = path ? routePermission(path) : null;
                  return (
                    <TableCell key={column.key}>
                      {path && permission && permissions.includes(permission) ? (
                        <a href={`#${path}`} className="record-link">
                          {text}
                        </a>
                      ) : column.kind === 'status' ? (
                        <span
                          className={`status-pill status-${String(value).replace(/[^a-z]/g, '')}`}
                        >
                          {text}
                        </span>
                      ) : (
                        text
                      )}
                    </TableCell>
                  );
                })}
                {hasTrailingColumn && (
                  <TableCell>
                    {rowAction
                      ? rowAction(row)
                      : detailResource && (
                          <a
                            href={`#${detailResource}/${encodeURIComponent(row.id)}`}
                            aria-label={`查看 ${row.id} 详情`}
                          >
                            查看详情
                          </a>
                        )}
                  </TableCell>
                )}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={table.columns.length + (hasTrailingColumn ? 1 : 0)}>
                <div className="empty-state">
                  没有符合条件的记录<p>可调整筛选条件或稍后刷新。</p>
                </div>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
