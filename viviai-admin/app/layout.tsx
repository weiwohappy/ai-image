import type { ReactNode } from 'react';
import './globals.css';
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="robots" content="noindex,nofollow" />
        <title>VIVIAI · 运营平台</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
