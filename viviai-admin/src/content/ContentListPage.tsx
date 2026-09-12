import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminActor } from '../contracts';
import { AdminClient, errorText } from '../http';
import { useAdminQuery } from '../useQuery';
import { ContentEditor } from './ContentEditor';
import type { ContentKind, ContentPage, ContentRecord, ToolRecord } from './contracts';
import { ToolDefinitionEditor } from './ToolDefinitionEditor';

const copy = {
  inspirations: { title: '灵感库', create: '新建灵感', singular: '灵感' },
  'remix-templates': { title: '爆款模板', create: '新建模板', singular: '模板' },
  tools: { title: 'AI 工具', create: '新建工具', singular: '工具' },
} as const;

export function ContentListPage({
  kind,
  actor,
  client,
  writeEnabled,
}: {
  kind: ContentKind;
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [queryText, setQueryText] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [cursor, setCursor] = useState('');
  const [editor, setEditor] = useState<ContentRecord | 'new'>();
  const [commandError, setCommandError] = useState('');
  const params = new URLSearchParams({ limit: '30' });
  if (queryText.trim()) params.set('q', queryText.trim());
  if (status) params.set('status', status);
  if (tag.trim() && kind !== 'tools') params.set('tag', tag.trim());
  if (cursor) params.set('cursor', cursor);
  const path = `/content/${kind}?${params}`;
  const result = useAdminQuery<ContentPage>(client, path, revision);
  const family = kind === 'remix-templates' ? 'templates' : kind;
  const canWrite = writeEnabled && actor.permissions.includes(`content.${family}.write`);
  const canPublish = actor.permissions.includes(`content.${family}.publish`);
  const canChange = (row: ContentRecord) => canWrite && (row.status !== 'published' || canPublish);

  function refresh() {
    setCursor('');
    setRevision((value) => value + 1);
  }

  async function move(row: ContentRecord, offset: number) {
    setCommandError('');
    try {
      await client.command(
        'POST',
        `/content/${kind}/reorder`,
        {
          reason: '调整运营列表的展示顺序',
          items: [
            { id: row.id, version: row.version, sortOrder: Math.max(0, row.sortOrder + offset) },
          ],
        },
        crypto.randomUUID(),
      );
      refresh();
    } catch (failure) {
      setCommandError(errorText(failure));
    }
  }

  return (
    <section className="operation-page" aria-label={copy[kind].title}>
      <div className="operation-toolbar">
        <div className="operation-filters">
          <label>
            关键词
            <Input
              value={queryText}
              onChange={(e) => {
                setQueryText(e.target.value);
                setCursor('');
              }}
              placeholder="名称或公开标识"
            />
          </label>
          <label>
            状态
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursor('');
              }}
            >
              <option value="">全部</option>
              <option value="draft">草稿</option>
              <option value="published">已发布</option>
              <option value="offline">已下线</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          {kind !== 'tools' && (
            <label>
              标签
              <Input
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  setCursor('');
                }}
              />
            </label>
          )}
        </div>
        <div className="team-form-actions">
          <Button variant="outline" onClick={refresh}>
            <RefreshCw size={15} />
            刷新
          </Button>
          {canWrite && (
            <Button onClick={() => setEditor('new')}>
              <Plus size={15} />
              {copy[kind].create}
            </Button>
          )}
        </div>
      </div>
      {commandError && (
        <p className="error-banner" role="alert">
          {commandError}
        </p>
      )}
      {result.loading ? (
        <div className="panel loading-state" role="status">
          正在读取内容…
        </div>
      ) : result.error ? (
        <p className="error-banner" role="alert">
          {result.error}
        </p>
      ) : (
        <div className="panel operation-table-wrap">
          <table className="operation-table">
            <thead>
              <tr>
                <th>内容</th>
                <th>公开标识</th>
                <th>状态</th>
                <th>排序</th>
                <th>版本</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {result.data?.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{'title' in row ? row.title : row.name}</strong>
                    <small>{row.category}</small>
                  </td>
                  <td>
                    <code>{row.externalId}</code>
                  </td>
                  <td>
                    <span className={`status status-${row.status}`}>{row.status}</span>
                  </td>
                  <td>{row.sortOrder}</td>
                  <td>v{row.version}</td>
                  <td>{new Date(row.updatedAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <div className="operation-row-actions">
                      {canChange(row) && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`编辑${'title' in row ? row.title : row.name}`}
                            onClick={() => setEditor(row)}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`上移${row.externalId}`}
                            onClick={() => void move(row, -10)}
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`下移${row.externalId}`}
                            onClick={() => void move(row, 10)}
                          >
                            <ArrowDown size={14} />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!result.data?.rows.length && (
                <tr>
                  <td colSpan={7} className="operation-empty">
                    没有符合条件的内容
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {result.data?.nextCursor && (
        <div className="operation-pagination">
          <Button variant="outline" onClick={() => setCursor(result.data!.nextCursor!)}>
            下一页
          </Button>
        </div>
      )}
      {editor &&
        (kind === 'tools' ? (
          <ToolDefinitionEditor
            record={editor === 'new' ? undefined : (editor as ToolRecord)}
            actor={actor}
            client={client}
            writeEnabled={writeEnabled}
            onClose={() => setEditor(undefined)}
            onChanged={refresh}
          />
        ) : (
          <ContentEditor
            kind={kind}
            record={editor === 'new' ? undefined : editor}
            actor={actor}
            client={client}
            writeEnabled={writeEnabled}
            onClose={() => setEditor(undefined)}
            onChanged={refresh}
          />
        ))}
    </section>
  );
}
