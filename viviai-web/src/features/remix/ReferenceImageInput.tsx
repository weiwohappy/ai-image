'use client';

import { ImagePlus, LoaderCircle, Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import type { RemixDraft } from '@/src/stores/sessionStore';

type Reference = NonNullable<RemixDraft['reference']>;

export function ReferenceImageInput({ value, onChange, onBusyChange, label = '爆款参考图', compact = false }: {
  value?: Reference;
  onChange: (value?: Reference) => void;
  onBusyChange: (busy: boolean) => void;
  label?: string;
  compact?: boolean;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { sequence.current += 1; }, []);

  async function upload(files: File[]) {
    if (busy) return;
    if (files.length !== 1) { setError('每次请选择一张图片。'); return; }
    const file = files[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('请上传 JPG、PNG 或 WebP 图片。'); return; }
    if (!file.size || file.size > 5 * 1024 * 1024) { setError('图片大小须在 0 到 5MB 之间。'); return; }
    const current = ++sequence.current;
    let previewUrl: string | undefined;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      previewUrl = URL.createObjectURL(file);
      const reference = await api.uploadRemixReference(file);
      if (sequence.current !== current) { URL.revokeObjectURL(previewUrl); return; }
      if (value?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(value.previewUrl);
      onChange({ ...reference, previewUrl });
    } catch (failure) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (sequence.current === current) setError(failure instanceof Error ? failure.message : '上传失败，请重试。');
    } finally {
      if (sequence.current === current) { setBusy(false); onBusyChange(false); }
    }
  }

  return (
    <div>
      <input ref={input} id={inputId} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label={`上传${label}`} disabled={busy} onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} />
      <div className={`relative overflow-hidden rounded-2xl border ${dragging ? 'border-violet-300 bg-violet-400/10' : 'border-dashed border-border bg-background/60'}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}>
        {value ? (
          <div>
            <img src={value.previewUrl} alt={`${label}预览`} className={`w-full object-contain ${compact ? 'h-36' : 'h-[300px] md:h-[390px]'}`} />
            <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-3">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{value.name}</p><p className="mt-1 text-xs text-muted-foreground">{value.width} × {value.height}</p></div>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>替换</Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除${label}`} disabled={busy} onClick={() => { if (value.previewUrl.startsWith('blob:')) URL.revokeObjectURL(value.previewUrl); onChange(undefined); setError(''); }}><X /></Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className={`flex w-full flex-col items-center justify-center px-5 text-center outline-none transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${compact ? 'min-h-28 py-5' : 'min-h-[350px] py-12 md:min-h-[450px]'}`}>
            <span className={`grid place-items-center rounded-2xl bg-violet-400/10 text-violet-300 ${compact ? 'size-9' : 'size-16'}`}><ImagePlus className={compact ? 'size-5' : 'size-7'} /></span>
            <strong className={`mt-4 ${compact ? 'text-sm' : 'text-xl'}`}>点击上传{label}</strong>
            <span className="mt-2 text-sm text-muted-foreground">也可以将图片拖到这里</span>
            <span className="mt-4 text-xs text-muted-foreground">JPG、PNG、WebP · 最大 5MB</span>
            {!compact && <span className="mt-7 inline-flex items-center gap-2 rounded-xl bg-violet-400/15 px-5 py-3 text-sm font-medium text-violet-200"><Upload className="size-4" />选择图片</span>}
          </button>
        )}
        {busy && <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-background/85 text-sm"><LoaderCircle className="size-5 animate-spin text-violet-300" />正在上传{label}…</div>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
