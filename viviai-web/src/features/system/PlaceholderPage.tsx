export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <main className="mx-auto w-full max-w-[1500px] p-5 md:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-[-.04em] text-foreground">{title}</h1>
        <p className="mt-2 max-w-2xl text-base text-muted-foreground">{description}</p>
      </div>
      <section className="grid min-h-[420px] place-items-center rounded-3xl border border-dashed border-border bg-card/50 p-8 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/10 text-xl text-primary">✦</span>
          <p className="mt-4 text-sm text-muted-foreground">该功能已进入后续实施任务</p>
        </div>
      </section>
    </main>
  );
}
