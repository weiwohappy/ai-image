'use client';

import { Link } from 'react-router-dom';

export function AuthPage({ mode }: { mode: 'login' | 'register' | 'forgot' }) {
  const title = mode === 'login' ? '登录 VIVIAI' : mode === 'register' ? '创建 VIVIAI 账户' : '找回密码';
  return (
    <main className="grid min-h-screen place-items-center bg-background px-5">
      <section className="w-full max-w-md rounded-3xl border border-border bg-card p-8 shadow-2xl shadow-black/25">
        <Link to="/create" className="mb-10 flex items-center gap-3 text-base font-bold">
          <span className="grid size-10 place-items-center rounded-[14px] bg-primary text-xl font-black text-primary-foreground">V</span>
          VIVIAI
        </Link>
        <h1 className="text-3xl font-semibold tracking-[-.04em]">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">登录后继续刚才的创作，提示词和参数会保留。</p>
        <div className="mt-8 rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">账户表单将在下一阶段接入 Mock 登录。</div>
      </section>
    </main>
  );
}
