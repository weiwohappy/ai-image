'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Coins, ImagePlus, LoaderCircle, Play, Save, Settings2, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { ModelConfig, Workflow, WorkflowDefinition, WorkflowGenerationColumn, WorkflowRun } from '@/src/types/domain';
import { ColumnConfigDialog } from './ColumnConfigDialog';
import { WorkflowGrid } from './WorkflowGrid';
import { WorkflowQuoteDialog } from './WorkflowQuoteDialog';
import { summarizeWorkflow } from './workflowMath';

function renderableRun(run: WorkflowRun) {
  return !['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status);
}

function draftName(): string {
  const stamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replaceAll('/', '').replace(/[:\s]/g, '');
  return `工作流${stamp}`;
}

/** A brand-new workflow holds no assets and takes its generation defaults from the live catalog. */
function createDraft(models: ModelConfig[]): Definition {
  const model = models.find((item) => item.status === 'available') ?? models[0];
  return {
    id: null,
    version: 0,
    name: draftName(),
    columns: [
      { id: 'reference', name: '商品素材', type: 'reference' },
      { id: 'style-reference', name: '风格参考', type: 'reference' },
      { id: 'generation', name: '主图生成', type: 'generation', prompt: '商业商品摄影，背景简洁，主体清晰', sourceColumnIds: ['reference', 'style-reference'], modelId: model?.id ?? '', resolution: model?.resolutions[0] ?? '1K', ratio: model?.ratios[0] ?? '1:1' },
    ],
    rows: Array.from({ length: 3 }, () => ({ rowKey: `row-${crypto.randomUUID()}`, cells: {} })),
    dirty: true,
  };
}

interface Definition extends WorkflowDefinition {
  id: string | null;
  version: number;
  dirty: boolean;
}

function fromServer(workflow: Workflow): Definition {
  return { id: workflow.id, version: workflow.version, name: workflow.name, columns: workflow.columns, rows: workflow.rows, dirty: false };
}

function toDefinition(draft: Definition): WorkflowDefinition {
  return { name: draft.name, columns: draft.columns, rows: draft.rows };
}

export function WorkflowEditorPage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = params.workflowId === 'new';
  const [draft, setDraft] = useState<Definition>();
  const [appliedVersion, setAppliedVersion] = useState<number>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [configuring, setConfiguring] = useState<WorkflowGenerationColumn>();
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState('');
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [quotedFingerprint, setQuotedFingerprint] = useState('');
  const idempotencyKey = useRef<string | undefined>(undefined);

  const models = useQuery({ queryKey: queryKeys.models, queryFn: api.listModels });
  const existing = useQuery({ queryKey: [...queryKeys.workflows, params.workflowId], queryFn: () => api.getWorkflow(params.workflowId!), enabled: !isNew });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });
  const runs = useQuery({
    queryKey: queryKeys.workflowRuns,
    queryFn: api.listWorkflowRuns,
    refetchInterval: (query) => (query.state.data?.some(renderableRun) ? 1500 : false),
  });

  useEffect(() => {
    if (isNew) {
      if (!draft && models.data) {
        const seeded = createDraft(models.data);
        setDraft(seeded);
        setSelectedRowKeys(seeded.rows.slice(0, 2).map((row) => row.rowKey));
      }
      return;
    }
    // Only adopt a server version we have not already applied, so a refetch cannot clobber local edits.
    if (existing.data && existing.data.version !== appliedVersion) {
      setDraft(fromServer(existing.data));
      setAppliedVersion(existing.data.version);
      setSelectedRowKeys(existing.data.rows.slice(0, 2).map((row) => row.rowKey));
    }
  }, [isNew, models.data, existing.data, appliedVersion, draft]);

  const latestRun = runs.data?.find((run) => run.workflowId === draft?.id);
  const summary = useMemo(() => summarizeWorkflow(draft ?? { columns: [], rows: [] }, selectedRowKeys), [draft, selectedRowKeys]);
  const columnStatus = useMemo(() => Object.fromEntries((latestRun?.items ?? []).map((item) => [`${item.columnKey}:${item.rowKey}`, item.status])), [latestRun]);
  const quoteFingerprint = draft?.id ? JSON.stringify({ workflowId: draft.id, version: draft.version, rowKeys: [...selectedRowKeys].sort() }) : '';

  const save = useMutation({
    mutationFn: () => {
      const definition = toDefinition(draft!);
      return draft!.id ? api.updateWorkflow(draft!.id, { ...definition, version: draft!.version }) : api.createWorkflow(definition);
    },
    onSuccess: (saved) => {
      setDraft(fromServer(saved));
      setAppliedVersion(saved.version);
      setError('');
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
      if (isNew) navigate(`/workflows/${saved.id}`, { replace: true });
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === 'WORKFLOW_VERSION_CONFLICT') { setConflictOpen(true); return; }
      setError(failure instanceof Error ? failure.message : '保存失败，请稍后重试。');
    },
  });

  const quote = useMutation({
    mutationFn: () => api.quoteWorkflowRun({ workflowId: draft!.id!, rowIds: selectedRowKeys }),
    onSuccess: () => { setQuotedFingerprint(quoteFingerprint); setError(''); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '获取报价失败。'),
  });

  const run = useMutation({
    mutationFn: (quoteId: string) => api.submitWorkflowRun(quoteId, idempotencyKey.current!),
    onSuccess: () => { setQuoteOpen(false); setError(''); queryClient.invalidateQueries({ queryKey: queryKeys.workflowRuns }); navigate('/tasks'); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '批量任务创建失败。'),
  });

  // Keeping the local draft as a copy is the only way to save when the server moved on underneath us.
  const keepLocal = useMutation({
    mutationFn: () => api.createWorkflow(toDefinition(draft!)),
    onSuccess: (saved) => {
      setDraft(fromServer(saved));
      setAppliedVersion(saved.version);
      setConflictOpen(false);
      setError('');
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
      navigate(`/workflows/${saved.id}`, { replace: true });
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '另存副本失败。'),
  });

  function update(next: Partial<Definition>) {
    setDraft((current) => (current ? { ...current, ...next, dirty: true } : current));
  }
  function updateColumn(next: WorkflowGenerationColumn) {
    if (!draft) return;
    update({ columns: draft.columns.map((column) => (column.id === next.id ? next : column)) });
    setConfiguring(next);
  }
  function addColumn(type: 'reference' | 'generation') {
    if (!draft) return;
    const id = `${type}-${crypto.randomUUID()}`;
    const referenceIds = draft.columns.filter((column) => column.type === 'reference').map((column) => column.id);
    if (type === 'reference') {
      update({ columns: [...draft.columns, { id, name: `参考图 ${referenceIds.length + 1}`, type }] });
      return;
    }
    const generation: WorkflowGenerationColumn = {
      id,
      name: `生成结果 ${draft.columns.filter((column) => column.type === 'generation').length + 1}`,
      type,
      prompt: '',
      sourceColumnIds: referenceIds,
      modelId: draft.columns.find((column) => column.type === 'generation')?.modelId ?? models.data?.[0]?.id ?? '',
      resolution: '1K',
      ratio: '1:1',
    };
    update({ columns: [...draft.columns, generation] });
    setConfiguring(generation);
  }
  function removeColumn(columnId: string) {
    if (!draft) return;
    update({
      columns: draft.columns.filter((column) => column.id !== columnId).map((column) => column.type === 'reference' ? column : { ...column, sourceColumnIds: column.sourceColumnIds.filter((id) => id !== columnId) }),
      rows: draft.rows.map((row) => { const cells = { ...row.cells }; delete cells[columnId]; return { ...row, cells }; }),
    });
  }
  function toggleRow(rowKey: string) {
    setSelectedRowKeys((current) => (current.includes(rowKey) ? current.filter((key) => key !== rowKey) : [...current, rowKey]));
  }
  function openQuote() {
    idempotencyKey.current = crypto.randomUUID();
    setQuotedFingerprint('');
    setError('');
    setQuoteOpen(true);
    quote.mutate();
  }
  function reQuote() {
    idempotencyKey.current = crypto.randomUUID();
    setQuotedFingerprint('');
    setError('');
    quote.mutate();
  }
  function reloadServerVersion() {
    setConflictOpen(false);
    setAppliedVersion(undefined);
    setError('');
    existing.refetch();
  }

  if (!draft) return <main className="p-8"><div className="h-[70vh] animate-pulse rounded-[28px] bg-card" /></main>;

  return (
    <main className="mx-auto w-full max-w-[1600px] p-4 md:p-6 xl:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/workflows" className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground" aria-label="返回工作流"><ArrowLeft className="size-4" /></Link>
          <div className="min-w-0">
            <Input aria-label="工作流名称" className="h-auto truncate border-0 bg-transparent p-0 text-2xl font-semibold shadow-none focus-visible:ring-0" value={draft.name} onChange={(event) => update({ name: event.target.value })} />
            <p className="mt-1 text-xs text-muted-foreground">{draft.dirty ? '有未保存的修改' : `已保存 · 版本 ${draft.version}`}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" className="rounded-full" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}保存
          </Button>
          <Button type="button" className="rounded-full" disabled={draft.dirty || !draft.id || summary.tasks === 0 || quote.isPending} onClick={openQuote}>
            {quote.isPending && quoteOpen ? <LoaderCircle className="animate-spin" /> : <Play />}运行所选 {summary.tasks} 个任务
          </Button>
        </div>
      </header>
      {error && !quoteOpen && <p role="alert" className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => addColumn('reference')}><ImagePlus />添加参考列</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addColumn('generation')}><Sparkles />添加生成列</Button>
          {draft.columns.map((column) => (
            <span key={column.id} className="inline-flex items-center rounded-lg bg-secondary">
              <Button type="button" variant="ghost" size="sm" onClick={() => column.type === 'generation' && setConfiguring(column)}>{column.type === 'generation' && <Settings2 />}{column.name}</Button>
              {draft.columns.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除${column.name}`} onClick={() => removeColumn(column.id)}><Trash2 /></Button>}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="缩小" onClick={() => setZoom((value) => Math.max(70, value - 10))}><ZoomOut /></Button>
          <span className="w-12 text-center text-xs text-muted-foreground">{zoom}%</span>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="放大" onClick={() => setZoom((value) => Math.min(130, value + 10))}><ZoomIn /></Button>
        </div>
      </section>
      <div className="mt-4 origin-top-left" style={{ transform: `scale(${zoom / 100})`, width: `${10000 / zoom}%` }}>
        <WorkflowGrid workflow={{ ...draft, id: draft.id ?? 'new', updatedAt: '' }} assets={assets.data ?? []} selectedRowKeys={selectedRowKeys} columnStatus={columnStatus} onChange={(next) => update({ name: next.name, columns: next.columns, rows: next.rows })} onToggleRow={toggleRow} />
      </div>
      <footer className="sticky bottom-4 z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/15 bg-[#24261f]/95 px-4 py-3 shadow-2xl backdrop-blur">
        <div className="flex flex-wrap gap-5 text-sm">
          <span><strong className="text-primary">{summary.rows}</strong> 行已选</span>
          <span><strong>{summary.tasks}</strong> 个生成任务</span>
          <span className="flex items-center gap-1.5 text-muted-foreground"><Coins className="size-4 text-primary" />预计 <strong className="text-foreground">{summary.estimatedCredits}</strong> 积分</span>
          {latestRun && <span className="text-muted-foreground" data-testid="run-progress">最近批次：成功 {latestRun.succeededCount} · 失败 {latestRun.failedCount} · 已扣 {latestRun.chargedCredits} 积分</span>}
        </div>
        <p className="text-xs text-muted-foreground">保存后才可运行，避免批量误操作</p>
      </footer>
      <ColumnConfigDialog column={configuring} models={models.data ?? []} referenceColumns={draft.columns.filter((column) => column.type === 'reference')} onChange={updateColumn} onClose={() => setConfiguring(undefined)} />
      <WorkflowQuoteDialog open={quoteOpen} onOpenChange={setQuoteOpen} quote={quote.data} loading={quote.isPending} error={error} stale={quotedFingerprint !== '' && quoteFingerprint !== quotedFingerprint} submitting={run.isPending} balance={(queryClient.getQueryData(queryKeys.me) as { credits?: number } | undefined)?.credits} onConfirm={() => quote.data?.quoteId && run.mutate(quote.data.quoteId)} onReQuote={reQuote} />
      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <DialogContent className="max-w-md rounded-[24px] border-border bg-card p-6">
          <DialogTitle className="text-xl font-semibold">工作流已被其他改动更新</DialogTitle>
          <DialogDescription>服务端已有更新的版本，本地修改尚未保存。请选择如何处理。</DialogDescription>
          <div className="mt-2 flex flex-col gap-2">
            <Button type="button" variant="outline" onClick={reloadServerVersion}>重新加载服务端版本</Button>
            <Button type="button" disabled={keepLocal.isPending} onClick={() => keepLocal.mutate()}>
              {keepLocal.isPending ? <LoaderCircle className="animate-spin" /> : null}保留本地内容供复制
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
