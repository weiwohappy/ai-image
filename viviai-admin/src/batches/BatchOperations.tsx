import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AdminActor, AdminDetail, AdminTable, Kind } from '../contracts';
import { AdminError, errorText, type AdminClient } from '../http';
import { DataTable, Notices } from '../DataTable';
import { useAdminQuery } from '../useQuery';
import { formatValue } from '../format';
import { useCommandAttempt } from '../operations/useCommandAttempt';
import { OperationDialog, OperationDialogActions } from '../operations/OperationDialog';
import { UncertainCommandActions } from '../operations/UncertainCommandActions';
import { reasonText } from '../team/presentation';

/** The disposal commands the server advertises per batch, with the console's own labels. */
const commands = {
  cancel: {
    segment: 'cancel',
    action: 'batches.cancel',
    button: '取消剩余任务',
    confirm: '确认取消批次',
    title: '确认取消批次',
    description: '取消后排队中的任务不再提交；已经提交给模型的任务无法撤回。',
    done: '批次已取消',
  },
  retryFailed: {
    segment: 'retry-failed',
    action: 'batches.retry-failed',
    button: '重试失败项',
    confirm: '确认重试',
    title: '确认重试失败项',
    description: '按当前积分价格重新报价，只提交系统失败的项；已成功的项不会重复执行。',
    done: '已重新提交可重试的失败项',
  },
} as const;

export type BatchCommand = keyof typeof commands;
export interface BatchAction {
  action: string;
  allowed: boolean;
  reasonCode: string | null;
}
export interface BatchDetail extends Omit<AdminDetail, 'fields'> {
  fields: Array<{ label: string; value: string | number | boolean | null; kind?: Kind }>;
  actions: BatchAction[];
}

const MANAGE = 'batches.manage';

function reasonError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 500) return '操作原因需为 5–500 个字符';
  if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|提示词/i.test(trimmed))
    return '原因中不得包含密钥、提示词或图片内容';
  return '';
}

/**
 * The per-item table keeps the machine state codes an operator matches against logs, next to the
 * error code and the retry flag. The batch's own state is summarised in Chinese above it.
 */
function itemTable(table: AdminTable): AdminTable {
  return {
    ...table,
    columns: table.columns.map((column) =>
      column.key === 'status' ? { ...column, kind: undefined } : column,
    ),
  };
}

/**
 * Batch disposal for operators. Every control is offered only when both the administrator's
 * permissions and the server's own availability allow it, so a refused command can never be
 * sent from here, and the reason a command is refused is always shown next to it.
 */
export function BatchOperations({
  batchId,
  actor,
  client,
  writeEnabled,
  onChanged,
}: {
  batchId: string;
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
  onChanged: () => void;
}) {
  const path = `/batches/${batchId}`;
  const [revision, setRevision] = useState(0);
  const query = useAdminQuery<BatchDetail>(client, path, revision);
  const attempt = useCommandAttempt();
  const [command, setCommand] = useState<BatchCommand>();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState('');
  const [message, setMessage] = useState('');
  const reasonId = useId();
  const failureId = useId();
  // A refresh must not blank a batch the operator is reading; the last good read stands until
  // the new one arrives.
  const lastDetail = useRef<BatchDetail | undefined>(undefined);
  if (query.data) lastDetail.current = query.data;
  const detail = query.data ?? lastDetail.current;

  const canManage = actor.permissions.includes(MANAGE);
  const labels = command ? commands[command] : undefined;

  function close() {
    if (attempt.pending) return;
    attempt.reset();
    setCommand(undefined);
    setReason('');
    setFailure('');
  }

  async function submit() {
    if (!labels || attempt.pending) return;
    const invalid = reasonError(reason);
    if (invalid) {
      setFailure(invalid);
      return;
    }
    setFailure('');
    const trimmed = reason.trim();
    try {
      const outcome = await attempt.run(
        {
          method: 'POST',
          path: `${path}/${labels.segment}`,
          action: labels.action,
          target: batchId,
        },
        { reason: trimmed },
        (key) =>
          client.command<unknown>('POST', `${path}/${labels.segment}`, { reason: trimmed }, key),
      );
      if (outcome.kind === 'blocked') {
        setFailure('上一个请求的结果尚未确认，请先检查结果或放弃该请求');
        return;
      }
      setCommand(undefined);
      setReason('');
      setMessage(labels.done);
      onChanged();
      setRevision((n) => n + 1);
    } catch (error) {
      // A refusal is the server's answer, not a crash: it is shown in place, and the batch is
      // left exactly as it was.
      if (error instanceof AdminError)
        setFailure(error.code ? reasonText(error.code) : errorText(error));
    }
  }

  if (!detail)
    return query.error ? (
      <section className="panel panel-padding">
        <p className="error-banner" role="alert">
          {query.error}
        </p>
        <Button variant="outline" onClick={() => setRevision((n) => n + 1)}>
          重试
        </Button>
      </section>
    ) : (
      <div className="panel loading-state" role="status">
        正在读取批次详情…
      </div>
    );

  const rules = new Map(detail.actions.map((action) => [action.action, action]));
  const blocked = [
    ...new Set(
      detail.actions
        .filter((action) => !action.allowed)
        .map((action) => reasonText(action.reasonCode)),
    ),
  ];
  function disabledReason(action: BatchCommand): string | undefined {
    if (!writeEnabled) return '当前环境未开放批量任务处置';
    const rule = rules.get(action);
    return rule && !rule.allowed ? reasonText(rule.reasonCode) : undefined;
  }

  return (
    <div className="detail-stack">
      <Notices items={detail.notices} />
      {query.error && (
        <p className="error-banner" role="alert">
          {query.error}
        </p>
      )}
      <section className="panel">
        <div className="panel-title">
          <h2>{detail.title}</h2>
          <Button
            variant="outline"
            disabled={query.loading}
            onClick={() => setRevision((n) => n + 1)}
          >
            刷新详情
          </Button>
        </div>
        <dl className="detail-fields">
          {detail.fields.map((field, index) => (
            <div key={index}>
              <dt>{field.label}</dt>
              <dd>{formatValue(field.value, field.kind)}</dd>
            </div>
          ))}
        </dl>
        {!canManage ? (
          <p className="notices">当前账号对批量任务只有只读权限，无法取消或重试。</p>
        ) : (
          <>
            <div className="team-form-actions">
              {(['cancel', 'retryFailed'] as const).map((action) => (
                <Button
                  key={action}
                  type="button"
                  variant="outline"
                  disabled={attempt.pending || Boolean(disabledReason(action))}
                  title={disabledReason(action)}
                  onClick={() => {
                    setFailure('');
                    setReason('');
                    setCommand(action);
                  }}
                >
                  {commands[action].button}
                </Button>
              ))}
            </div>
            {blocked.map((text) => (
              <small className="team-action-reason" key={text}>
                {text}
              </small>
            ))}
          </>
        )}
        {message && (
          <p className="notices" role="status">
            {message}
          </p>
        )}
      </section>
      {detail.tables.map((table, index) => (
        <section className="panel" key={index}>
          <div className="panel-title">
            <h2>{table.title}</h2>
          </div>
          <DataTable table={itemTable(table)} permissions={actor.permissions} />
        </section>
      ))}
      {labels && (
        <OperationDialog
          title={labels.title}
          description={labels.description}
          pending={attempt.pending}
          onClose={close}
        >
          <div className="field">
            <label htmlFor={reasonId}>操作原因</label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={500}
              aria-invalid={Boolean(failure)}
              aria-describedby={failure ? failureId : undefined}
              placeholder="说明运营目的；不要填写密钥、提示词或客户内容"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {failure && (
            <p className="error-banner" id={failureId} role="alert">
              {failure}
            </p>
          )}
          {attempt.uncertain ? (
            <UncertainCommandActions
              pending={attempt.pending}
              message="取消结果尚未确认。重试会复用原请求，避免重复执行。"
              onRetry={() => void submit()}
              onAbandon={close}
            />
          ) : (
            <OperationDialogActions
              pending={attempt.pending}
              onCancel={close}
              confirmLabel={labels.confirm}
              onConfirm={() => void submit()}
            />
          )}
        </OperationDialog>
      )}
    </div>
  );
}
