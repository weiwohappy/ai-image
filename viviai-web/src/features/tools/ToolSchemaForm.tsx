'use client';

import { Input } from '@/components/ui/input';
import type { ToolFieldSchema } from '@/src/types/domain';

export function ToolSchemaForm({ fields, values, onChange }: { fields: ToolFieldSchema[]; values: Record<string, string>; onChange: (id: string, value: string) => void }) {
  return <div className="space-y-4">{fields.map((field) => {
    if (field.type === 'select') return <label key={field.id} className="block text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-primary">*</span>}<select aria-label={field.label} className="mt-2 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={values[field.id] ?? ''} onChange={(event) => onChange(field.id, event.target.value)}><option value="">请选择</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
    if (field.type === 'radio') return <fieldset key={field.id}><legend className="text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-primary">*</span>}</legend><div className="mt-2 flex gap-2">{field.options?.map((option) => <label key={option.value} className={`flex-1 rounded-xl border p-3 text-sm ${values[field.id] === option.value ? 'border-primary bg-primary/8' : 'border-border bg-background'}`}><input type="radio" name={field.id} value={option.value} checked={values[field.id] === option.value} onChange={() => onChange(field.id, option.value)} className="mr-2 accent-[var(--primary)]" />{option.label}</label>)}</div></fieldset>;
    return <label key={field.id} className="block text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-primary">*</span>}<Input className="mt-2 h-11 rounded-xl bg-background" value={values[field.id] ?? ''} onChange={(event) => onChange(field.id, event.target.value)} /></label>;
  })}</div>;
}
