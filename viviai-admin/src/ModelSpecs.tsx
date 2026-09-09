import type { AdminTable } from './contracts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableCaption,
} from '@/components/ui/table';
import { formatValue } from './format';
import { Notices } from './DataTable';

export function ModelSpecs({ table }: { table: AdminTable }) {
  const resolutions = [...new Set(table.rows.map((row) => String(row.resolution)))];
  const ratios = [...new Set(table.rows.map((row) => String(row.ratio)))];
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>原生分辨率 × 比例</h2>
        <span className="caption">仅展示后端规格记录，不推算尺寸</span>
      </div>
      <Notices items={table.notices} />
      <Table>
        <TableCaption>
          像素尺寸为模型原生输出。未启用不等于不支持；空白组合不对外开放。
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>分辨率</TableHead>
            {ratios.map((ratio) => (
              <TableHead key={ratio}>{ratio}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {resolutions.map((resolution) => (
            <TableRow key={resolution}>
              <TableHead>{resolution}</TableHead>
              {ratios.map((ratio) => {
                const spec = table.rows.find(
                  (row) => row.resolution === resolution && row.ratio === ratio,
                );
                return (
                  <TableCell key={ratio}>
                    {spec ? (
                      <div className="spec-cell">
                        <span>
                          {spec.width} × {spec.height}
                        </span>
                        <small>{spec.enabled === true ? '已启用' : '未启用'}</small>
                        <small>{formatValue(spec.credits, 'credits')}</small>
                      </div>
                    ) : (
                      <span className="unsupported">不支持</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!resolutions.length && <div className="empty-state">暂无已核实的原生规格</div>}
    </section>
  );
}
