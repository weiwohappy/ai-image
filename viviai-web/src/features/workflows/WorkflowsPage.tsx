'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Layers3, Plus } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function WorkflowsPage() {
  const workflows = useQuery({ queryKey: queryKeys.workflows, queryFn: api.listWorkflows });
  return <main className="mx-auto w-full max-w-[1480px] p-4 md:p-6 xl:p-8"><header className="flex flex-wrap items-end justify-between gap-4"><div><p className="flex items-center gap-2 text-sm font-medium text-primary"><Layers3 className="size-4" />BATCH STUDIO</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">工作流</h1><p className="mt-2 text-base text-muted-foreground">用表格编排素材与提示词，一次生成整批图片。</p></div><Button render={<NavLink to="/workflows/new" />} nativeButton={false} className="rounded-full"><Plus />新建工作流</Button></header>{workflows.data?.length ? <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{workflows.data.map((workflow) => <NavLink key={workflow.id} to={`/workflows/${workflow.id}`} className="group rounded-[22px] border border-border bg-card p-5 hover:border-primary/25"><div className="flex items-start justify-between"><span className="grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><Layers3 /></span><ArrowUpRight className="size-5 text-muted-foreground group-hover:text-primary" /></div><h2 className="mt-5 text-lg font-semibold">{workflow.name}</h2><p className="mt-2 text-sm text-muted-foreground">{workflow.rows.length} 行 · {workflow.columns.length} 列 · 版本 {workflow.version}</p><p className="mt-5 text-xs text-muted-foreground">更新于 {new Date(workflow.updatedAt).toLocaleString('zh-CN')}</p></NavLink>)}</div> : <div className="mt-8 grid min-h-96 place-items-center rounded-[28px] border border-dashed border-border bg-card/40 text-center"><div><Layers3 className="mx-auto size-10 text-primary" /><h2 className="mt-4 text-xl font-semibold">创建你的第一个批量工作流</h2><p className="mt-2 text-sm text-muted-foreground">适合批量商品主图、社媒矩阵和多尺寸版本。</p><NavLink to="/workflows/new" className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"><Plus className="size-4" />新建工作流</NavLink></div></div>}</main>;
}
