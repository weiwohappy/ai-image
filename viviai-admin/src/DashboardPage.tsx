import type { Dashboard } from './contracts';
import { DataTable, Notices } from './DataTable';
import { formatValue, safeRoute } from './format';
export function DashboardPage({
  dashboard,
  permissions = [],
}: {
  dashboard: Dashboard;
  permissions?: string[];
}) {
  return (
    <>
      <Notices items={dashboard.notices} />
      <div className="metric-grid">
        {dashboard.metrics.map((metric) => (
          <section className="metric" key={metric.key}>
            <h2>{metric.label}</h2>
            <div className={metric.value === null ? 'metric-unavailable' : 'metric-value'}>
              {formatValue(metric.value, metric.kind)}
            </div>
            <p>{metric.note}</p>
            {metric.href && safeRoute(metric.href) && <a href={`#${metric.href}`}>查看明细 →</a>}
          </section>
        ))}
      </div>
      {!dashboard.metrics.length && (
        <section className="panel empty-state">
          当前角色尚未接入业务指标<p>这里不会展示其他团队的私有数据。</p>
        </section>
      )}
      <section className="panel">
        <div className="panel-title">
          <h2>需要关注</h2>
          <span className="caption">按当前角色范围展示</span>
        </div>
        <DataTable table={dashboard.alerts} permissions={permissions} />
      </section>
      <p className="caption page-footnote">
        数据截至 {formatValue(dashboard.asOf, 'datetime')} · {dashboard.environment} ·
        未知成本不计作零成本
      </p>
    </>
  );
}
