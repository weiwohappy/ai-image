import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { AdminClient, errorText } from '../http';
import { useBeforeUnloadGuard, useDirtyRegistration } from '../operations/dirty-guard';
import { useCommandAttempt } from '../operations/useCommandAttempt';
import { UncertainCommandActions } from '../operations/UncertainCommandActions';
import type { GeneratedBatch } from './contracts';

export function CodeBatchDialog({
  client,
  onClose,
  onChanged,
}: {
  client: AdminClient;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [campaignId, setCampaignId] = useState('');
  const [campaignVersion, setCampaignVersion] = useState(1);
  const [quantity, setQuantity] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<GeneratedBatch>();
  const [error, setError] = useState('');
  const attempt = useCommandAttempt();
  const saving = attempt.pending;
  const locked = saving || attempt.uncertain;
  const dirty = Boolean(campaignId || reason || result);
  useBeforeUnloadGuard(dirty || locked);
  useDirtyRegistration({ dirty, pending: locked, discard: destroy });
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving) return;
    setError('');
    if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return setError('请输入有效的活动 ID');
    if (!Number.isInteger(campaignVersion) || campaignVersion < 1)
      return setError('请输入有效的活动版本');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000)
      return setError('生成数量必须为 1–1000');
    if (!Number.isInteger(maxUses) || maxUses < 1) return setError('单码可用次数至少为 1');
    if (reason.trim().length < 5 || reason.trim().length > 500)
      return setError('生成原因需为 5–500 个字符');
    if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(reason))
      return setError('原因中不得包含密钥、提示词或图片内容');
    const body = { campaignId, campaignVersion, quantity, maxUses, reason: reason.trim() };
    try {
      const path = '/redemption-codes';
      const outcome = await attempt.run(
        {
          method: 'POST',
          path,
          action: 'redemptions.code.generate',
          target: campaignId,
        },
        body,
        (key) => client.command<GeneratedBatch>('POST', path, body, key),
      );
      if (outcome.kind === 'success') {
        setResult(outcome.value);
        onChanged();
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      // The logical attempt deliberately survives an uncertain network outcome.
    }
  }

  function destroy() {
    setResult(undefined);
    onClose();
  }
  return (
    <Sheet
      open
      disablePointerDismissal={locked}
      onOpenChange={(open) => !open && !locked && destroy()}
    >
      <SheetContent className="team-sheet operation-sheet" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>生成兑换码</SheetTitle>
          <SheetDescription>
            明文只在本次成功响应中出现，关闭后立即销毁且无法再次查看。
          </SheetDescription>
        </SheetHeader>
        <div className="team-sheet-body">
          {result ? (
            <div className="stack one-time-result">
              <div className="one-time-warning">
                <strong>请现在安全保存</strong>
                <p>关闭此结果后，系统不会再显示这些明文。</p>
              </div>
              <pre>
                {result.codes?.map((code) => code.code).join('\n') || '批次已创建，但明文无法恢复'}
              </pre>
              <Button onClick={destroy}>关闭并销毁明文</Button>
            </div>
          ) : (
            <form className="stack" onSubmit={(event) => void submit(event)}>
              <fieldset className="team-fields" disabled={locked}>
                <label className="field">
                  活动 ID
                  <Input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
                </label>
                <label className="field">
                  活动版本
                  <Input
                    type="number"
                    min={1}
                    value={campaignVersion}
                    onChange={(e) => setCampaignVersion(Number(e.target.value))}
                  />
                </label>
                <div className="operation-grid">
                  <label className="field">
                    生成数量
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      value={quantity}
                      onChange={(e) => setQuantity(Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    单码可用次数
                    <Input
                      type="number"
                      min={1}
                      value={maxUses}
                      onChange={(e) => setMaxUses(Number(e.target.value))}
                    />
                  </label>
                </div>
                <label className="field">
                  生成原因
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="说明活动批次用途，不要填写敏感数据"
                  />
                </label>
              </fieldset>
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              {attempt.uncertain && (
                <UncertainCommandActions
                  pending={saving}
                  message="网络结果尚未确认。请使用同一请求检查结果，避免重复发码。"
                  onRetry={() => void submit()}
                  onAbandon={() => attempt.abandon()}
                />
              )}
              <div className="team-form-actions">
                <Button type="button" variant="outline" disabled={locked} onClick={destroy}>
                  取消
                </Button>
                <Button type="submit" disabled={locked}>
                  {saving ? '正在生成…' : '确认生成'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
