import { Dialog } from '@base-ui/react/dialog';
import type { ReactNode, RefObject } from 'react';
import { Button } from '@/components/ui/button';

export function OperationDialog({
  open = true,
  title,
  description,
  pending = false,
  className = '',
  initialFocus,
  onClose,
  children,
}: {
  open?: boolean;
  title: string;
  description: string;
  pending?: boolean;
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      modal
      disablePointerDismissal={pending}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="operation-dialog-backdrop" />
        <Dialog.Popup className={`operation-confirm ${className}`} initialFocus={initialFocus}>
          <Dialog.Title className="cn-font-heading">{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function OperationDialogActions({
  pending = false,
  onCancel,
  confirmLabel,
  onConfirm,
}: {
  pending?: boolean;
  onCancel: () => void;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <div className="team-form-actions">
      <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
        取消
      </Button>
      <Button type="button" disabled={pending} onClick={onConfirm}>
        {pending ? '处理中…' : confirmLabel}
      </Button>
    </div>
  );
}
