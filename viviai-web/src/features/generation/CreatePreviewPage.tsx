'use client';

import { ArrowUp, ImagePlus, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { Button } from '@/components/ui/button';

const sampleTiles = [
  'from-[#f2a264] via-[#a45b84] to-[#382744]',
  'from-[#506f64] via-[#85aa7e] to-[#1f3031]',
  'from-[#735bd4] via-[#836be7] to-[#312451]',
];

export function CreatePreviewPage() {
  return (
    <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-.045em] text-foreground md:text-4xl">图片生成</h1>
          <p className="mt-2 text-base text-muted-foreground">描述画面，或从一张参考图开始。</p>
        </div>
        <NavLink to="/remix" className="flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-400/10 px-4 py-2 text-sm text-violet-200 hover:border-violet-300/50">
          <WandSparkles className="size-4" /> 浏览爆款模板
        </NavLink>
      </div>

      <div className="grid min-h-[calc(100vh-10rem)] gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,.7fr)]">
        <section className="relative overflow-hidden rounded-[28px] border border-border bg-card p-4 md:p-6">
          <div className="absolute inset-y-6 left-0 w-1 rounded-r-full bg-primary shadow-[0_0_28px_rgba(216,255,82,.38)]" />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-5" /></span>
              <div><h2 className="text-lg font-semibold">创作画布</h2><p className="text-xs text-muted-foreground">最近生成 · 自动保存</p></div>
            </div>
            <div className="flex rounded-full border border-border bg-background p-1 text-xs text-muted-foreground"><button className="rounded-full bg-secondary px-3 py-1.5 text-foreground">画廊</button><button className="px-3 py-1.5">消息</button></div>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-[74px_1fr]">
            <aside className="hidden flex-col gap-3 md:flex" aria-label="参考图轨道">
              <button className="grid aspect-square place-items-center rounded-2xl border border-dashed border-border bg-background text-muted-foreground" aria-label="添加参考图"><ImagePlus className="size-5" /></button>
              {sampleTiles.slice(0, 2).map((gradient) => <div key={gradient} className={`aspect-square rounded-2xl bg-gradient-to-br ${gradient} opacity-75`} />)}
            </aside>
            <div className="grid auto-rows-[minmax(190px,1fr)] gap-3 sm:grid-cols-2">
              {sampleTiles.map((gradient, index) => (
                <article key={gradient} className={`group relative overflow-hidden rounded-[22px] bg-gradient-to-br ${gradient} ${index === 0 ? 'sm:row-span-2' : ''}`}>
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_24%,rgba(255,255,255,.72)_0_7%,transparent_7.5%),radial-gradient(circle_at_72%_24%,transparent_0_18%,rgba(255,255,255,.66)_18.5%_23%,transparent_23.5%)]" />
                  <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                    <span className="rounded-full bg-black/45 px-3 py-1.5 text-xs text-white backdrop-blur">{index === 0 ? '2K · 1:1' : '1K · 3:4'}</span>
                    <Button size="sm" variant="secondary" className="rounded-full">继续编辑</Button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <aside className="flex min-h-[560px] flex-col rounded-[28px] border border-border bg-card p-5 md:p-6">
          <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">生成设置</h2><p className="mt-1 text-xs text-muted-foreground">NanoBanana 2</p></div><Button variant="ghost" size="icon" aria-label="打开高级设置" className="rounded-full"><SlidersHorizontal /></Button></div>
          <div className="mt-6 flex-1">
            <label htmlFor="preview-prompt" className="text-sm font-medium text-foreground">描述你想生成的画面</label>
            <div className="relative mt-3 rounded-2xl border border-input bg-background p-4 focus-within:border-primary/45">
              <textarea id="preview-prompt" className="min-h-36 w-full resize-none bg-transparent text-base leading-7 text-foreground placeholder:text-muted-foreground" placeholder="例如：一款透明香氛瓶，暖色电影光，置于深色石材台面……" />
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground"><button className="rounded-full bg-secondary px-3 py-1.5">商业摄影</button><button className="rounded-full bg-secondary px-3 py-1.5">电影光</button><button className="rounded-full bg-secondary px-3 py-1.5">保留留白</button></div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <button className="rounded-xl border border-border bg-background px-3 py-3 text-left"><span className="block text-xs text-muted-foreground">清晰度</span><strong className="mt-1 block">2K</strong></button>
              <button className="rounded-xl border border-border bg-background px-3 py-3 text-left"><span className="block text-xs text-muted-foreground">画面比例</span><strong className="mt-1 block">1:1</strong></button>
              <button className="rounded-xl border border-border bg-background px-3 py-3 text-left"><span className="block text-xs text-muted-foreground">生成张数</span><strong className="mt-1 block">2 张</strong></button>
              <button className="rounded-xl border border-border bg-background px-3 py-3 text-left"><span className="block text-xs text-muted-foreground">预计积分</span><strong className="mt-1 block text-primary">10 积分</strong></button>
            </div>
          </div>
          <Button size="lg" className="mt-6 h-12 w-full rounded-2xl text-sm font-bold">开始生成 <ArrowUp /></Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">提交后将进入任务队列，失败自动退回积分</p>
        </aside>
      </div>
    </main>
  );
}
