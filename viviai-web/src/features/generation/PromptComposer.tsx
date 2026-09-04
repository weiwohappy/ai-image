'use client';

import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ImageAsset } from '@/src/types/domain';

const suggestions = ['商业摄影', '电影光', '保留文案留白'];

export function PromptComposer({ prompt, onPromptChange, assets, referenceAssetId, onReferenceChange }: {
  prompt: string;
  onPromptChange: (value: string) => void;
  assets: ImageAsset[];
  referenceAssetId?: string;
  onReferenceChange: (value?: string) => void;
}) {
  const reference = assets.find((asset) => asset.id === referenceAssetId);
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
      <div className="mt-4">
        <label htmlFor="reference-asset" className="text-sm font-medium">参考图（可选）</label>
        {reference ? (
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-border bg-background p-2">
            <img src={reference.thumbnailUrl} alt="" className="size-12 rounded-lg object-cover" />
            <span className="min-w-0 flex-1 truncate text-sm">{reference.name}</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="移除参考图" onClick={() => onReferenceChange(undefined)}><X /></Button>
          </div>
        ) : (
          <select id="reference-asset" className="mt-2 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value="" onChange={(event) => onReferenceChange(event.target.value || undefined)}>
            <option value="">从我的资产选择参考图</option>
            {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><ImagePlus className="size-3.5" />后端接入后，这里也支持本地上传。</p>
      </div>
    </div>
  );
}
