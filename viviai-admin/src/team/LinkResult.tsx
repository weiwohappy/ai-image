import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TeamMutationResult } from './contracts';
export function LinkResult({ result }: { result: TeamMutationResult }) {
  const [message, setMessage] = useState('');
  if (result.linkUnavailable)
    return (
      <p className="notices">
        操作已完成，但一次性链接不能再次读取。请关闭面板后重新生成链接，旧链接将立即失效。
      </p>
    );
  if (!result.link) return null;
  return (
    <div className="stack">
      <label className="field">
        一次性链接
        <Textarea readOnly value={result.link} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <p className="caption">
        链接仅本次显示，请私下发给对应同事。
        {result.expiresAt &&
          `有效期至 ${new Date(result.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间）。`}
      </p>
      <Button
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(result.link!);
            setMessage('链接已复制');
          } catch {
            setMessage('自动复制不可用，请选中上方链接手动复制');
          }
        }}
      >
        复制链接
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
