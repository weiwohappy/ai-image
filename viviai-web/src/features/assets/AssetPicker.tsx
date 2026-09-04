'use client';

import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';

import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function AssetPicker({ selected, onChange, max = 1, label = '选择素材' }: { selected: string[]; onChange: (ids: string[]) => void; max?: number; label?: string }) {
  const { data: assets = [] } = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });
  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id));
    else if (selected.length < max) onChange([...selected, id]);
  }
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}<span className="ml-2 font-normal text-muted-foreground">最多 {max} 张</span></legend>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {assets.slice(0, 8).map((asset) => {
          const active = selected.includes(asset.id);
          return <button type="button" key={asset.id} aria-label={`${active ? '取消选择' : '选择'}${asset.name}`} aria-pressed={active} className={`group relative overflow-hidden rounded-xl border ${active ? 'border-primary ring-2 ring-primary/20' : 'border-border'}`} onClick={() => toggle(asset.id)}><img src={asset.thumbnailUrl} alt="" className="aspect-square w-full object-cover" />{active && <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" /></span>}</button>;
        })}
      </div>
    </fieldset>
  );
}
