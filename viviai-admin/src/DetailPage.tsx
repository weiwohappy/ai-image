import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { AdminDetail } from './contracts';
import { AdminClient } from './http';
import { useAdminQuery } from './useQuery';
import { DataTable, Notices } from './DataTable';
import { ModelSpecs } from './ModelSpecs';
import { SensitiveView } from './SensitiveView';
import { ResourcePage } from './ResourcePage';
import { formatValue } from './format';

export function DetailPage({
  path,
  client,
  permissions,
}: {
  path: string;
  client: AdminClient;
  permissions: string[];
}) {
  const [revision, setRevision] = useState(0);
  const query = useAdminQuery<AdminDetail>(client, path, revision);
  if (query.loading)
    return (
      <div className="panel loading-state" role="status">
        正在读取详情…
      </div>
    );
  if (query.error || !query.data)
    return (
      <section className="panel panel-padding">
        <p className="error-banner" role="alert">
          {query.error ?? '详情不可用'}
        </p>
        <Button variant="outline" onClick={() => setRevision((n) => n + 1)}>
          重试
        </Button>
      </section>
    );
  const detail = query.data;
  const overview = (
    <div className="detail-stack">
      <Notices items={detail.notices} />
      <section className="panel">
        <div className="panel-title">
          <h2>{detail.title}</h2>
          <Button variant="outline" onClick={() => setRevision((n) => n + 1)}>
            刷新详情
          </Button>
        </div>
        <dl className="detail-fields">
          {detail.fields.map((field, i) => (
            <div key={i}>
              <dt>{field.label}</dt>
              <dd>{formatValue(field.value, field.kind)}</dd>
            </div>
          ))}
        </dl>
      </section>
      {detail.tables.map((table, index) =>
        path.startsWith('/models/') &&
        table.columns.some((column) => column.key === 'resolution') &&
        table.columns.some((column) => column.key === 'ratio') ? (
          <ModelSpecs key={index} table={table} />
        ) : (
          <section className="panel" key={index}>
            <div className="panel-title">
              <h2>{table.title}</h2>
            </div>
            <DataTable table={table} permissions={permissions} />
          </section>
        ),
      )}
      {detail.sensitive && permissions.includes('sensitive.read') && (
        <SensitiveView
          key={detail.sensitive.jobId}
          jobId={detail.sensitive.jobId}
          client={client}
        />
      )}
    </div>
  );
  if (path.startsWith('/users/') && permissions.includes('credits.read'))
    return (
      <Tabs defaultValue="overview">
        <TabsList className="detail-tabs">
          <TabsTrigger value="overview">用户概况</TabsTrigger>
          <TabsTrigger value="lots">积分批次</TabsTrigger>
          <TabsTrigger value="events">积分流水</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">{overview}</TabsContent>
        <TabsContent value="lots">
          <ResourcePage path={`${path}/credit-lots`} client={client} permissions={permissions} />
        </TabsContent>
        <TabsContent value="events">
          <ResourcePage path={`${path}/credit-events`} client={client} permissions={permissions} />
        </TabsContent>
      </Tabs>
    );
  return overview;
}
