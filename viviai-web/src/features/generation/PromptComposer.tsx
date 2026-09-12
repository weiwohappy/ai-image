'use client';

import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ImageAsset } from '@/src/types/domain';

const suggestions = ['商业摄影', '电影光', '保留文案留白'];

export function PromptComposer({ prompt, onPromptChange, assets, referenceAssetId, referencePreviewUrl, referenceName, onReferenceChange, onReferenceUpload, allowReference = true }: {
  prompt: string;
  onPromptChange: (value: string) => void;
  assets: ImageAsset[];
  referenceAssetId?: string;
  referencePreviewUrl?: string;
  referenceName?: string;
  onReferenceChange: (value?: string) => void;
  onReferenceUpload: (file: File) => void;
  allowReference?: boolean;
}) {
  const reference = assets.find((asset) => asset.id === referenceAssetId);
  const referenceUrl = reference?.thumbnailUrl ?? referencePreviewUrl;
  const displayedName = reference?.name ?? referenceName;
  return (
    <div>
      <label htmlFor="generation-prompt" className="text-sm font-medium text-foreground">描述你想生成的画面</label>
      <div className="mt-3 rounded-2xl border border-input bg-background p-3 focus-within:border-primary/45">
        <Textarea id="generation-prompt" aria-label="描述你想生成的画面" className="min-h-32 resize-none border-0 bg-transparent p-1 text-base leading-7 shadow-none focus-visible:ring-0" maxLength={1200} placeholder="例如：一款透明香氛瓶，暖色电影光，置于深色石材台面……" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {suggestions.map((item) => <button type="button" key={item} className="rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => onPromptChange(`${prompt}${prompt ? '，' : ''}${item}`)}>{item}</button>)}
          <span className="ml-auto text-xs text-muted-foreground">{prompt.length}/1200</span>
        </div>
      </div>
      {allowReference ? <div className="mt-4">
        <label htmlFor="reference-asset" className="text-sm font-medium">参考图（可选）</label>
        {referenceUrl ? (
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-border bg-background p-2">
            <img src={referenceUrl} alt="" className="size-12 rounded-lg object-cover" />
            <span className="min-w-0 flex-1 truncate text-sm">{displayedName}</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="移除参考图" onClick={() => onReferenceChange(undefined)}><X /></Button>
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
            <select id="reference-asset" className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value="" onChange={(event) => onReferenceChange(event.target.value || undefined)}>
              <option value="">从我的资产选择参考图</option>
              {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select>
            <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-input px-4 text-sm hover:bg-secondary"><ImagePlus className="size-4" />本地上传<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="上传本地参考图" onChange={(event) => { const file = event.target.files?.[0]; if (file) onReferenceUpload(file); event.currentTarget.value = ''; }} /></label>
          </div>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><ImagePlus className="size-3.5" />支持 PNG、JPG、WebP；当前原型在浏览器本地保存预览。</p>
      </div> : <div className="mt-4 rounded-xl border border-violet-300/20 bg-violet-400/8 p-3 text-xs leading-5 text-muted-foreground"><span className="font-medium text-violet-200">需要参考图？</span> 请前往“上传爆款图复刻”工作台。真实图片接口将参考图作为复刻任务输入。</div>}
    </div>
  );
}
