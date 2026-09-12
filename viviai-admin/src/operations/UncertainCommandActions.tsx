import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { OperationDialog, OperationDialogActions } from './OperationDialog';

export function UncertainCommandActions({
  pending,
  onRetry,
  onAbandon,
  message = '网络结果尚未确认。重试会复用原请求，避免重复执行。',
}: {
  pending: boolean;
  onRetry: () => void;
  onAbandon: () => void;
  message?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div className="notices stack" role="status">
        {message}
        <div className="team-form-actions">
          <Button type="button" variant="outline" disabled={pending} onClick={onRetry}>
            检查结果/重试同请求
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            放弃未确认请求
          </Button>
        </div>
      </div>
      {confirming && (
        <OperationDialog
          title="放弃未确认请求？"
          description="新操作将使用新的幂等键；原请求仍可能已经执行。"
          onClose={() => setConfirming(false)}
        >
          <OperationDialogActions
            onCancel={() => setConfirming(false)}
            confirmLabel="确认放弃"
            onConfirm={() => {
              setConfirming(false);
              onAbandon();
            }}
          />
        </OperationDialog>
      )}
    </>
  );
}
