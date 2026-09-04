import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { PointLedgerEntry } from '@/src/types/domain';

export function PointLedger({ entries }: { entries: PointLedgerEntry[] }) {
  return <div className="overflow-hidden rounded-2xl border border-border">{entries.map((entry) => <div key={entry.id} className="flex items-center gap-3 border-b border-border bg-background p-4 last:border-0"><span className={`grid size-9 place-items-center rounded-xl ${entry.delta > 0 ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>{entry.delta > 0 ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{entry.description}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString('zh-CN')}</p></div><div className="text-right"><strong className={entry.delta > 0 ? 'text-primary' : ''}>{entry.delta > 0 ? '+' : ''}{entry.delta}</strong><p className="mt-1 text-xs text-muted-foreground">余额 {entry.balance}</p></div></div>)}</div>;
}
