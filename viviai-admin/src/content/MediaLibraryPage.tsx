import { useRef, useState, type FormEvent } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AdminActor } from '../contracts';
import { AdminClient, errorText } from '../http';
import { useAdminQuery } from '../useQuery';
import { OperationDialog, OperationDialogActions } from '../operations/OperationDialog';
import { useBeforeUnloadGuard, useDirtyRegistration } from '../operations/dirty-guard';
import { useCommandAttempt } from '../operations/useCommandAttempt';
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
  const [updatedFrom, setUpdatedFrom] = useState('');
  const [updatedTo, setUpdatedTo] = useState('');
  const [cursor, setCursor] = useState('');
  const [file, setFile] = useState<File>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState<{ row: ContentMediaRecord; status: Lifecycle }>();
  const [changeReason, setChangeReason] = useState('');
  const [changeError, setChangeError] = useState('');
  const changeReasonRef = useRef<HTMLTextAreaElement>(null);
  const canWrite = writeEnabled && actor.permissions.includes('content.media.write');
  const uploadAttempt = useCommandAttempt();
  const transitionAttempt = useCommandAttempt();
  const pending = uploadAttempt.pending || transitionAttempt.pending;
  const dirty = Boolean(file || reason || changing || changeReason);
  useBeforeUnloadGuard(dirty || pending);
  useDirtyRegistration({
    dirty,
    pending,
    discard: () => {
      setFile(undefined);
      setReason('');
      setChanging(undefined);
      setChangeReason('');
    },
  });
  const params = new URLSearchParams({ limit: '30' });
  const timeFilterInvalid = Boolean(
    updatedFrom && updatedTo && Date.parse(updatedFrom) >= Date.parse(updatedTo),
  );
  if (status) params.set('status', status);
  if (queryText.trim()) params.set('q', queryText.trim());
  if (updatedFrom && !timeFilterInvalid)
    params.set('updatedFrom', new Date(updatedFrom).toISOString());
  if (updatedTo && !timeFilterInvalid) params.set('updatedTo', new Date(updatedTo).toISOString());
  if (cursor) params.set('cursor', cursor);
  const result = useAdminQuery<ContentMediaPage>(client, `/content/media?${params}`, revision);
  const refresh = () => {
    setCursor('');
    setRevision((value) => value + 1);
  };

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
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
      await uploadAttempt.run(
        { name: file.name, size: file.size, type: file.type, reason: reason.trim() },
        (key) => client.upload('/content/media', body, key),
      );
      setFile(undefined);
      setReason('');
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function transition() {
    if (!changing) return;
    if (changeReason.trim().length < 5) {
      setChangeError('状态变更原因至少 5 个字符');
      changeReasonRef.current?.focus();
      return;
    }
    if (
      /api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(changeReason)
    ) {
      setChangeError('原因中不得包含密钥、提示词或图片内容');
      changeReasonRef.current?.focus();
      return;
    }
    setChangeError('');
    try {
      const path =
        changing.status === 'archived'
          ? `/content/media/${changing.row.id}/archive`
          : `/content/media/${changing.row.id}/transition`;
      const body =
        changing.status === 'archived'
          ? { version: changing.row.version, reason: changeReason.trim() }
          : { version: changing.row.version, reason: changeReason.trim(), status: changing.status };
      await transitionAttempt.run(body, (key) => client.command('POST', path, body, key));
      setChanging(undefined);
      setChangeReason('');
      refresh();
    } catch (failure) {
      setChangeError(errorText(failure));
      changeReasonRef.current?.focus();
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
          <Button type="submit" disabled={pending}>
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
          <label>
            更新开始时间
            <Input
              type="datetime-local"
              value={updatedFrom}
              aria-invalid={timeFilterInvalid}
              onChange={(e) => {
                setUpdatedFrom(e.target.value);
                setCursor('');
              }}
            />
          </label>
          <label>
            更新结束时间
            <Input
              type="datetime-local"
              value={updatedTo}
              aria-invalid={timeFilterInvalid}
              onChange={(e) => {
                setUpdatedTo(e.target.value);
                setCursor('');
              }}
            />
          </label>
        </div>
        {timeFilterInvalid && (
          <p className="field-error" role="alert">
            更新开始时间必须早于结束时间
          </p>
        )}
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
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setChangeError('');
                      setChanging({
                        row,
                        status: row.status === 'published' ? 'offline' : 'published',
                      });
                    }}
                  >
                    {row.status === 'published' ? '下线' : '发布'}
                  </Button>
                  {(row.status === 'draft' || row.status === 'offline') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setChangeError('');
                        setChanging({ row, status: 'archived' });
                      }}
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
        <OperationDialog
          title={`确认${changing.status === 'published' ? '发布' : changing.status === 'offline' ? '下线' : '归档'}媒体`}
          description="媒体状态会影响公开内容是否可用，请填写可审计原因。"
          pending={pending}
          initialFocus={changeReasonRef}
          onClose={() => setChanging(undefined)}
        >
          <label htmlFor="media-transition-reason">状态变更原因</label>
          <Textarea
            ref={changeReasonRef}
            id="media-transition-reason"
            value={changeReason}
            aria-invalid={Boolean(changeError)}
            aria-describedby={changeError ? 'media-transition-reason-error' : undefined}
            onChange={(e) => {
              setChangeReason(e.target.value);
              setChangeError('');
            }}
          />
          {changeError && (
            <p className="field-error" id="media-transition-reason-error" role="alert">
              {changeError}
            </p>
          )}
          <OperationDialogActions
            pending={pending}
            onCancel={() => setChanging(undefined)}
            confirmLabel="确认变更"
            onConfirm={() => void transition()}
          />
        </OperationDialog>
      )}
    </section>
  );
}
