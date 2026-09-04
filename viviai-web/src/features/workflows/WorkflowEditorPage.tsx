'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Coins, ImagePlus, LoaderCircle, Play, Save, Settings2, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { Workflow, WorkflowColumn } from '@/src/types/domain';
import { ColumnConfigDialog } from './ColumnConfigDialog';
import { WorkflowGrid } from './WorkflowGrid';
import { summarizeWorkflow } from './workflowMath';

function createDefaultWorkflow(id: string): Workflow {
  const stamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replaceAll('/', '').replace(/[:\s]/g, '');
  return {
    id,
    name: `工作流${stamp}`,
    version: 0,
    saved: false,
    updatedAt: new Date().toISOString(),
    columns: [
      { id: 'reference', name: '商品素材', type: 'reference' },
      { id: 'style-reference', name: '风格参考', type: 'reference' },
      { id: 'generation', name: '主图生成', type: 'generation', prompt: '商业商品摄影，背景简洁，主体清晰', sourceColumnIds: ['reference', 'style-reference'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
    ],
    rows: Array.from({ length: 3 }, (_, index) => ({
      id: `row-${index + 1}`,
      cells: { reference: `asset-${index + 1}`, 'style-reference': `asset-${index + 4}` },
      selected: index < 2,
      status: 'idle',
    })),
  };
}

export function WorkflowEditorPage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = params.workflowId === 'new';
  const stableId = useMemo(() => isNew ? `workflow-${crypto.randomUUID()}` : params.workflowId ?? 'new', [isNew, params.workflowId]);
  const existing = useQuery({ queryKey: [...queryKeys.workflows, stableId], queryFn: () => api.getWorkflow(stableId), enabled: !isNew });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });
  const [workflow, setWorkflow] = useState<Workflow>(() => createDefaultWorkflow(stableId));
  const [configuring, setConfiguring] = useState<WorkflowColumn>();
  const [zoom, setZoom] = useState(100);
  useEffect(() => { if (existing.data) setWorkflow(existing.data); }, [existing.data]);
  const selectedIds = workflow.rows.filter((row) => row.selected).map((row) => row.id);
  const summary = summarizeWorkflow(workflow, selectedIds);
  const save = useMutation({ mutationFn: () => api.saveWorkflow(workflow), onSuccess: (saved) => { setWorkflow(saved); queryClient.invalidateQueries({ queryKey: queryKeys.workflows }); navigate(`/workflows/${saved.id}`, { replace: true }); } });
  const run = useMutation({ mutationFn: () => api.runWorkflow(workflow.id, selectedIds), onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.batches }); navigate('/tasks'); } });
  function updateColumn(next: WorkflowColumn) { setWorkflow((current) => ({ ...current, saved: false, columns: current.columns.map((column) => column.id === next.id ? next : column) })); setConfiguring(next); }
  function addColumn(type: WorkflowColumn['type']) {
    const id = `${type}-${crypto.randomUUID()}`;
    const referenceIds = workflow.columns.filter((column) => column.type === 'reference').map((column) => column.id);
    const next: WorkflowColumn = type === 'reference'
      ? { id, name: `参考图 ${referenceIds.length + 1}`, type }
      : { id, name: `生成结果 ${workflow.columns.filter((column) => column.type === 'generation').length + 1}`, type, prompt: '', sourceColumnIds: referenceIds, modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' };
    setWorkflow((current) => ({ ...current, saved: false, columns: [...current.columns, next] }));
    if (type === 'generation') setConfiguring(next);
  }
  function removeColumn(columnId: string) {
    setWorkflow((current) => ({
      ...current,
      saved: false,
      columns: current.columns.filter((column) => column.id !== columnId).map((column) => column.type === 'generation' ? { ...column, sourceColumnIds: column.sourceColumnIds?.filter((id) => id !== columnId) } : column),
      rows: current.rows.map((row) => {
        const cells = { ...row.cells };
        delete cells[columnId];
        return { ...row, cells };
      }),
    }));
  }
  return <main className="mx-auto w-full max-w-[1600px] p-4 md:p-6 xl:p-8"><header className="flex flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><Link to="/workflows" className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground" aria-label="返回工作流"><ArrowLeft className="size-4" /></Link><div className="min-w-0"><Input aria-label="工作流名称" className="h-auto truncate border-0 bg-transparent p-0 text-2xl font-semibold shadow-none focus-visible:ring-0" value={workflow.name} onChange={(event) => setWorkflow((current) => ({ ...current, name: event.target.value, saved: false }))} /><p className="mt-1 text-xs text-muted-foreground">{workflow.saved ? `已保存 · 版本 ${workflow.version}` : '有未保存的修改'}</p></div></div><div className="flex items-center gap-2"><Button type="button" variant="outline" className="rounded-full" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}保存</Button><Button type="button" className="rounded-full" disabled={!workflow.saved || summary.tasks === 0 || run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}运行所选 {summary.tasks} 个任务</Button></div></header><section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3"><div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => addColumn('reference')}><ImagePlus />添加参考列</Button><Button type="button" variant="outline" size="sm" onClick={() => addColumn('generation')}><Sparkles />添加生成列</Button>{workflow.columns.map((column) => <span key={column.id} className="inline-flex items-center rounded-lg bg-secondary"><Button type="button" variant="ghost" size="sm" onClick={() => column.type === 'generation' && setConfiguring(column)}>{column.type === 'generation' && <Settings2 />}{column.name}</Button>{workflow.columns.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除${column.name}`} onClick={() => removeColumn(column.id)}><Trash2 /></Button>}</span>)}</div><div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label="缩小" onClick={() => setZoom((value) => Math.max(70, value - 10))}><ZoomOut /></Button><span className="w-12 text-center text-xs text-muted-foreground">{zoom}%</span><Button type="button" size="icon-sm" variant="ghost" aria-label="放大" onClick={() => setZoom((value) => Math.min(130, value + 10))}><ZoomIn /></Button></div></section><div className="mt-4 origin-top-left" style={{ transform: `scale(${zoom / 100})`, width: `${10000 / zoom}%` }}><WorkflowGrid workflow={workflow} assets={assets.data ?? []} onChange={setWorkflow} /></div><footer className="sticky bottom-4 z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/15 bg-[#24261f]/95 px-4 py-3 shadow-2xl backdrop-blur"><div className="flex flex-wrap gap-5 text-sm"><span><strong className="text-primary">{summary.rows}</strong> 行已选</span><span><strong>{summary.tasks}</strong> 个生成任务</span><span className="flex items-center gap-1.5 text-muted-foreground"><Coins className="size-4 text-primary" />预计 <strong className="text-foreground">{summary.estimatedCredits}</strong> 积分</span></div><p className="text-xs text-muted-foreground">保存后才可运行，避免批量误操作</p></footer><ColumnConfigDialog column={configuring} onChange={updateColumn} onClose={() => setConfiguring(undefined)} /></main>;
}
