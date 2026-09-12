import { useState, type FormEvent } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AdminActor } from '../contracts';
import { AdminClient, errorText } from '../http';
import { useAdminQuery } from '../useQuery';
import type { ContentMediaPage, ContentMediaRecord, Lifecycle } from './contracts';

function safePreview(row: ContentMediaRecord): string | undefined {
  return row.previewUrl === `/api/admin/content/media/${row.id}/content`
    ? row.previewUrl
    : undefined;
}

export function MediaLibraryPage({
  actor,
  client,
  writeEnabled,
}: {
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [queryText, setQueryText] = useState('');
  const [cursor, setCursor] = useState('');
  const [file, setFile] = useState<File>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState<{ row: ContentMediaRecord; status: Lifecycle }>();
  const [changeReason, setChangeReason] = useState('');
  const canWrite = writeEnabled && actor.permissions.includes('content.media.write');
  const canPublish = canWrite && actor.permissions.includes('content.media.publish');
  const params = new URLSearchParams({ limit: '30' });
  if (status) params.set('status', status);
  if (queryText.trim()) params.set('q', queryText.trim());
  if (cursor) params.set('cursor', cursor);
  const result = useAdminQuery<ContentMediaPage>(client, `/content/media?${params}`, revision);
  const refresh = () => {
    setCursor('');
    setRevision((value) => value + 1);
  };

  async function upload(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!file) return setError('请选择要上传的图片');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
      return setError('仅支持 PNG、JPEG 或 WebP');
    if (reason.trim().length < 5 || reason.trim().length > 500)
      return setError('上传原因需为 5–500 个字符');
    if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(reason))
      return setError('原因中不得包含密钥、提示词或图片内容');
    const body = new FormData();
    body.set('file', file);
    body.set('reason', reason.trim());
    try {
      await client.upload('/content/media', body, crypto.randomUUID());
      setFile(undefined);
      setReason('');
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function transition() {
    if (!changing || changeReason.trim().length < 5) return setError('状态变更原因至少 5 个字符');
    if (
      /api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(changeReason)
    )
      return setError('原因中不得包含密钥、提示词或图片内容');
    try {
      const path =
        changing.status === 'archived'
          ? `/content/media/${changing.row.id}/archive`
          : `/content/media/${changing.row.id}/transition`;
      const body =
        changing.status === 'archived'
          ? { version: changing.row.version, reason: changeReason.trim() }
          : { version: changing.row.version, reason: changeReason.trim(), status: changing.status };
      await client.command('POST', path, body, crypto.randomUUID());
      setChanging(undefined);
      setChangeReason('');
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <section className="operation-page" aria-label="内容媒体库">
      {canWrite && (
        <form className="panel panel-padding media-upload" onSubmit={(event) => void upload(event)}>
          <div>
            <h2>上传内容媒体</h2>
            <p className="caption">媒体与用户私有素材完全隔离；上传后默认为草稿。</p>
          </div>
          <label className="field">
            选择图片
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <label className="field">
            上传原因
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明版权来源与用途，不要粘贴图片内容"
            />
          </label>
          <Button type="submit">
            <ImageUp size={15} />
            上传媒体
          </Button>
        </form>
      )}
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
              placeholder="媒体标识"
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
        </div>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw size={15} />
          刷新
        </Button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {result.loading ? (
        <div className="panel loading-state" role="status">
          正在读取媒体…
        </div>
      ) : result.error ? (
        <p className="error-banner" role="alert">
          {result.error}
        </p>
      ) : (
        <div className="media-grid">
          {result.data?.rows.map((row) => (
            <article className="panel media-card" key={row.id}>
              {safePreview(row) ? (
                <img src={safePreview(row)} alt="" loading="lazy" />
              ) : (
                <div className="media-placeholder">预览不可用</div>
              )}
              <div>
                <strong>{row.externalId}</strong>
                <p>
                  {row.width} × {row.height} · {Math.ceil(row.byteSize / 1024)} KB
                </p>
                <span className={`status status-${row.status}`}>{row.status}</span>
              </div>
              {canWrite && row.status !== 'archived' && (
                <div className="operation-row-actions">
                  {canPublish && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setChanging({
                          row,
                          status: row.status === 'published' ? 'offline' : 'published',
                        })
                      }
                    >
                      {row.status === 'published' ? '下线' : '发布'}
                    </Button>
                  )}
                  {(row.status === 'draft' || row.status === 'offline') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setChanging({ row, status: 'archived' })}
                    >
                      归档
                    </Button>
                  )}
                </div>
              )}
            </article>
          ))}
          {!result.data?.rows.length && <div className="panel operation-empty">尚无内容媒体</div>}
        </div>
      )}
      {result.data?.nextCursor && (
        <div className="operation-pagination">
          <Button variant="outline" onClick={() => setCursor(result.data!.nextCursor!)}>
            下一页
          </Button>
        </div>
      )}
      {changing && (
        <div className="operation-confirm" role="dialog" aria-modal="true">
          <h3>
            确认
            {changing.status === 'published'
              ? '发布'
              : changing.status === 'offline'
                ? '下线'
                : '归档'}
            媒体
          </h3>
          <label htmlFor="media-transition-reason">状态变更原因</label>
          <Textarea
            id="media-transition-reason"
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
          />
          <div className="team-form-actions">
            <Button variant="outline" onClick={() => setChanging(undefined)}>
              取消
            </Button>
            <Button onClick={() => void transition()}>确认变更</Button>
          </div>
        </div>
      )}
    </section>
  );
}
