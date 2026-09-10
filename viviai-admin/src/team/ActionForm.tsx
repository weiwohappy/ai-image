import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { AdminClient, AdminError, errorText } from '../http';
import type { TeamMutationResult } from './contracts';
import { LinkResult } from './LinkResult';
import { reasonText } from './presentation';
import { FieldErrorsProvider, FormField, type FieldErrors } from './FormField';
interface Props {
  client: AdminClient;
  title: string;
  description: string;
  submitLabel: string;
  successText: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  initialVersion?: number;
  children?: ReactNode;
  payload: () => Record<string, unknown>;
  validate?: () => FieldErrors | undefined;
  submitDisabled?: boolean;
  onReload?: () => Promise<{ version: number; summary: string }>;
  onClose: () => void;
  onChanged: () => void;
  onPermissionsChanged: () => Promise<void>;
}
type Submission = { key: string; body: Record<string, unknown> };
export function ActionForm(props: Props) {
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'editing' | 'saving' | 'unknown' | 'conflict' | 'success'>(
    'editing',
  );
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrors]);
  const [version, setVersion] = useState(props.initialVersion);
  const [latest, setLatest] = useState('');
  const [result, setResult] = useState<TeamMutationResult>();
  const [confirmClose, setConfirmClose] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const submission = useRef<Submission | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function close() {
    if (phase === 'saving') return;
    if (phase === 'success') props.onClose();
    else setConfirmClose(true);
  }
  async function dispatch(next: Submission) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setPhase('saving');
    setError('');
    try {
      const saved = await props.client.command<TeamMutationResult>(
        props.method,
        props.path,
        next.body,
        next.key,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(saved);
      setPhase('success');
      submission.current = null;
      props.onChanged();
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (
        !(failure instanceof AdminError) ||
        (failure.status >= 500 && failure.code !== 'ADMIN_TEAM_WRITES_DISABLED')
      ) {
        setPhase('unknown');
        setError('结果未确认。请重试同一操作以确认结果，不要重复新建。');
      } else {
        submission.current = null;
        setPhase(failure.status === 409 && props.onReload ? 'conflict' : 'editing');
        setError(
          failure.code && failure.code !== 'ERROR' ? reasonText(failure.code) : errorText(failure),
        );
        if (failure.status === 403) {
          try {
            await props.onPermissionsChanged();
          } catch {
            setError('权限刷新未成功，请重新登录后再操作');
          }
        }
      }
    } finally {
      pending.current = null;
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'editing' || pending.current || props.submitDisabled) return;
    const invalid = props.validate?.() ?? {};
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      invalid.reason = '操作原因需为 5–500 个字符';
    }
    setFieldErrors(invalid);
    if (Object.keys(invalid).length) {
      setError('请检查下方标记的字段');
      return;
    }
    const next = {
      key: crypto.randomUUID(),
      body: {
        ...props.payload(),
        ...(version === undefined ? {} : { expectedVersion: version }),
        reason: reason.trim(),
      },
    };
    submission.current = next;
    void dispatch(next);
  }
  async function reload() {
    if (!props.onReload || pending.current) return;
    setError('');
    try {
      const record = await props.onReload();
      setVersion(record.version);
      setLatest(record.summary);
      setPhase('editing');
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="team-sheet" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>{props.title}</SheetTitle>
          <SheetDescription>{props.description}</SheetDescription>
        </SheetHeader>
        <div className="team-sheet-body">
          {phase === 'success' && result ? (
            <div className="stack">
              <p className="team-success" role="status">
                {props.successText}
              </p>
              <LinkResult result={result} />
              <Button onClick={props.onClose}>完成</Button>
            </div>
          ) : (
            <form ref={form} className="stack" noValidate onSubmit={submit}>
              {latest && (
                <p className="notices">最新记录：{latest}。你的草稿已保留，请核对后保存。</p>
              )}
              <FieldErrorsProvider value={fieldErrors}>
                <fieldset disabled={phase !== 'editing'} className="team-fields">
                  {props.children}
                  <FormField name="reason" label="操作原因">
                    <Textarea
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="请说明本次变更的原因，不要填写密码或密钥"
                    />
                  </FormField>
                </fieldset>
              </FieldErrorsProvider>
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              {phase === 'conflict' && props.onReload && (
                <Button type="button" variant="outline" onClick={reload}>
                  加载最新记录
                </Button>
              )}
              <div className="team-form-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={phase === 'saving'}
                  onClick={close}
                >
                  取消
                </Button>
                {phase === 'unknown' ? (
                  <Button
                    type="button"
                    onClick={() => submission.current && void dispatch(submission.current)}
                  >
                    重试同一操作
                  </Button>
                ) : (
                  <Button type="submit" disabled={phase !== 'editing' || props.submitDisabled}>
                    {phase === 'saving' ? '正在保存…' : props.submitLabel}
                  </Button>
                )}
              </div>
            </form>
          )}
          {confirmClose && (
            <div className="notices team-close-confirm" role="alert">
              <p>
                {phase === 'unknown'
                  ? '关闭不会撤销服务端操作；结果仍未确认，请先重试。确定关闭？'
                  : '关闭将放弃尚未保存的修改，确定关闭？'}
              </p>
              <div className="team-form-actions">
                <Button variant="outline" onClick={() => setConfirmClose(false)}>
                  继续编辑
                </Button>
                <Button variant="outline" onClick={props.onClose}>
                  放弃并关闭
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
