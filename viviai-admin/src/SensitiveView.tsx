import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EyeOff, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AdminClient, errorText } from './http';
import type { SensitiveData, SensitiveGrant } from './contracts';
import { formatValue } from './format';

export function SensitiveView({ jobId, client }: { jobId: string; client: AdminClient }) {
  const [reason, setReason] = useState('');
  const [grant, setGrant] = useState<SensitiveGrant | null>(null);
  const [content, setContent] = useState<{
    prompt: string;
    images: Array<{ id: string; role: string; url: string }>;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [jobId]);
  useEffect(() => {
    setContent(null);
    if (!grant) return;
    const controller = new AbortController();
    const urls: string[] = [];
    const expires = new Date(grant.expiresAt).getTime();
    function clear() {
      controller.abort();
      setContent(null);
      setGrant(null);
      setBusy(false);
      urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
    }
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 300_000) {
      clear();
      return;
    }
    const timer = setTimeout(clear, expires - Date.now());
    function visibility() {
      if (document.visibilityState === 'hidden' || Date.now() >= expires) clear();
    }
    document.addEventListener('visibilitychange', visibility);
    (async () => {
      try {
        const data = await client.get<SensitiveData>(
          `/jobs/${encodeURIComponent(jobId)}/sensitive?grantId=${encodeURIComponent(grant.id)}`,
          controller.signal,
        );
        const blobs = await Promise.all(
          data.assets.map((asset) =>
            client.blob(
              `/assets/${encodeURIComponent(asset.id)}/preview?grantId=${encodeURIComponent(grant.id)}`,
              controller.signal,
            ),
          ),
        );
        if (controller.signal.aborted || Date.now() >= expires) return;
        const images = data.assets.map((asset, index) => {
          const url = URL.createObjectURL(blobs[index]);
          urls.push(url);
          return { id: asset.id, role: asset.role, url };
        });
        setContent({ prompt: data.prompt, images });
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(errorText(failure));
          setGrant(null);
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [client, jobId, grant]);
  async function apply(event: FormEvent) {
    event.preventDefault();
    if (busy || reason.trim().length < 10) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const next = await client.post<SensitiveGrant>(
        '/sensitive-access-grants',
        { jobId, reason: reason.trim() },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setReason('');
        setGrant(next);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(errorText(failure));
        setBusy(false);
      }
    }
  }
  return (
    <section className="panel sensitive-panel">
      <div className="panel-title">
        <h2>
          <ShieldCheck size={18} />
          受保护的参考图与提示词
        </h2>
        <span className="caption">仅限处理当前任务</span>
      </div>
      <div className="panel-padding">
        <p className="caption">
          查看须填写工单与用途，授权有效期最多 5
          分钟。切换任务、隐藏页面或授权到期会清除内容。不要填写密码或 API Key。
        </p>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {!grant ? (
          <form className="sensitive-form" onSubmit={apply}>
            <label className="field">
              查看原因
              <Textarea
                required
                minLength={10}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：处理工单 CS-123，核实用户上传的参考图与生成结果差异"
              />
            </label>
            <Button type="submit" disabled={busy || reason.trim().length < 10}>
              {busy ? '正在申请…' : '申请查看 5 分钟'}
            </Button>
          </form>
        ) : (
          <>
            <div className="grant-banner">
              <span>授权截止 {formatValue(grant.expiresAt, 'datetime')}</span>
              <Button
                variant="outline"
                onClick={() => {
                  setContent(null);
                  setGrant(null);
                }}
              >
                <EyeOff size={16} />
                立即隐藏
              </Button>
            </div>
            {!content ? (
              <p role="status">正在读取受保护的内容…</p>
            ) : (
              <div>
                <h3>提示词</h3>
                <p className="sensitive-prompt">{content.prompt}</p>
                <div className="private-images">
                  {content.images.map((asset) => (
                    <figure key={asset.id}>
                      <img src={asset.url} alt={`${asset.role} · ${asset.id}`} />
                      <figcaption>
                        {asset.role} · {asset.id}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
