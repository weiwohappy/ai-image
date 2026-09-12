import { useMemo, useRef, useState, type FormEvent } from 'react';
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
import type { AdminActor } from '../contracts';
import { AdminClient, AdminError, errorText } from '../http';
import { FieldErrorsProvider, FormField, type FieldErrors } from '../team/FormField';
import { OperationDialog, OperationDialogActions } from '../operations/OperationDialog';
import { useBeforeUnloadGuard, useDirtyRegistration } from '../operations/dirty-guard';
import { useCommandAttempt } from '../operations/useCommandAttempt';
import type { ContentKind, ContentRecord, Lifecycle } from './contracts';

type Props = {
  kind: ContentKind;
  record?: ContentRecord;
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
};

const labels = { inspirations: '灵感', 'remix-templates': '模板', tools: '工具' } as const;

function initialValues(kind: ContentKind, record?: ContentRecord) {
  const shared = {
    externalId: record?.externalId ?? '',
    title:
      record && 'title' in record ? record.title : record && 'name' in record ? record.name : '',
    description: record?.description ?? '',
    category: record?.category ?? '',
    creatorName: record?.creatorName ?? '',
    sourceType: record?.sourceType ?? (kind === 'remix-templates' ? 'platform' : ''),
    sourceName: record?.sourceName ?? '',
    sourceUrl: record?.sourceUrl ?? '',
    defaultModelId: record?.defaultModelId ?? '',
    defaultOutputSpecId: record?.defaultOutputSpecId ?? '',
    coverMediaExternalId: record?.coverMediaExternalId ?? '',
    sortOrder: record?.sortOrder ?? 0,
  };
  if (kind === 'inspirations') {
    const row = record && 'baseLikes' in record ? record : undefined;
    return {
      ...shared,
      editorialLabel: row?.editorialLabel ?? '',
      baseLikes: row?.baseLikes ?? 0,
      tags: row?.tags.join(', ') ?? '',
      defaultPrompt: row?.defaultPrompt ?? '',
      secondaryMediaExternalId: row?.caseMediaExternalId ?? '',
      structured: '',
    };
  }
  if (kind === 'remix-templates') {
    const row = record && 'visualAnalysis' in record ? record : undefined;
    return {
      ...shared,
      editorialLabel: row?.popularityLabel ?? '',
      baseLikes: row?.baseRemixCount ?? 0,
      tags: row?.tags.join(', ') ?? '',
      defaultPrompt: row?.defaultPrompt ?? '',
      secondaryMediaExternalId: row?.referenceMediaExternalId ?? '',
      structured: JSON.stringify(
        row
          ? {
              platform: row.platform,
              industry: row.industry,
              style: row.style,
              visualAnalysis: row.visualAnalysis,
              defaultParameters: row.defaultParameters,
            }
          : {
              platform: '',
              industry: '',
              style: '',
              visualAnalysis: {
                composition: '',
                palette: ['#ffffff'],
                lighting: '',
                camera: '',
                typographyZone: '',
                avoid: [],
              },
              defaultParameters: {},
            },
        null,
        2,
      ),
    };
  }
  const row = record && 'promptTemplate' in record ? record : undefined;
  return {
    ...shared,
    editorialLabel: '',
    baseLikes: 0,
    tags: '',
    defaultPrompt: row?.promptTemplate ?? '',
    secondaryMediaExternalId: row?.iconMediaExternalId ?? '',
    structured: JSON.stringify(
      row
        ? {
            fields: row.fields,
            defaults: row.defaults,
            maxAssets: row.maxAssets,
            maxOutputCount: row.maxOutputCount,
            assetLabel: row.assetLabel,
            isNew: row.isNew,
          }
        : {
            fields: [],
            defaults: { modelId: '', resolution: '1K', ratio: '1:1', count: 1 },
            maxAssets: 0,
            maxOutputCount: 1,
            assetLabel: '参考图',
            isNew: false,
          },
      null,
      2,
    ),
  };
}

function fieldMessage(field?: string): string {
  const names: Record<string, string> = {
    defaultModelId: '默认模型',
    defaultOutputSpecId: '默认规格',
    coverMediaExternalId: '封面媒体',
    promptTemplate: '提示词模板',
  };
  return `${names[field ?? ''] ?? '该字段'}未通过发布校验`;
}

function formField(field: string): string {
  if (/^(fields|defaults|visualAnalysis|defaultParameters)(\.|\[|$)/.test(field))
    return 'structured';
  if (/^(case|reference|icon)MediaExternalId$/.test(field)) return 'secondaryMediaExternalId';
  return field;
}

export function ContentEditor(props: Props) {
  const [values, setValues] = useState(() => initialValues(props.kind, props.record));
  const original = useMemo(
    () => JSON.stringify(initialValues(props.kind, props.record)),
    [props.kind, props.record],
  );
  const [version, setVersion] = useState(props.record?.version ?? 1);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [transition, setTransition] = useState<Lifecycle>();
  const [transitionReason, setTransitionReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latestConflict, setLatestConflict] = useState<{
    record: ContentRecord;
    values: ReturnType<typeof initialValues>;
    unresolved: string[];
  }>();
  const transitionReasonRef = useRef<HTMLTextAreaElement>(null);
  const [transitionReasonError, setTransitionReasonError] = useState('');
  const commandAttempt = useCommandAttempt();
  const saving = commandAttempt.pending;
  const family = props.kind === 'remix-templates' ? 'templates' : props.kind;
  const hasWrite =
    props.writeEnabled && props.actor.permissions.includes(`content.${family}.write`);
  const hasPublish = props.actor.permissions.includes(`content.${family}.publish`);
  const canWrite = hasWrite && (props.record?.status !== 'published' || hasPublish);
  const canPublish = hasWrite && hasPublish;
  const dirty = JSON.stringify(values) !== original || reason.length > 0;
  useBeforeUnloadGuard(dirty || saving);
  useDirtyRegistration({ dirty, pending: saving, discard: props.onClose });

  const update = (name: keyof typeof values, value: string | number) =>
    setValues((current) => ({ ...current, [name]: value }));

  function payload(): Record<string, unknown> | null {
    const common = {
      externalId: values.externalId.trim(),
      description: values.description.trim(),
      category: values.category.trim(),
      ...(values.creatorName.trim() ? { creatorName: values.creatorName.trim() } : {}),
      ...(values.sourceType ? { sourceType: values.sourceType } : {}),
      ...(values.sourceName.trim() ? { sourceName: values.sourceName.trim() } : {}),
      ...(values.sourceUrl.trim() ? { sourceUrl: values.sourceUrl.trim() } : {}),
      defaultModelId: values.defaultModelId.trim(),
      defaultOutputSpecId: values.defaultOutputSpecId.trim(),
      coverMediaExternalId: values.coverMediaExternalId.trim(),
      status: props.record?.status ?? 'draft',
      sortOrder: Number(values.sortOrder),
    };
    if (props.kind === 'inspirations')
      return {
        ...common,
        title: values.title.trim(),
        ...(values.editorialLabel.trim() ? { editorialLabel: values.editorialLabel.trim() } : {}),
        baseLikes: Number(values.baseLikes),
        tags: values.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        defaultPrompt: values.defaultPrompt.trim(),
        ...(values.secondaryMediaExternalId.trim()
          ? { caseMediaExternalId: values.secondaryMediaExternalId.trim() }
          : {}),
      };
    let extra: Record<string, unknown>;
    try {
      extra = JSON.parse(values.structured) as Record<string, unknown>;
    } catch {
      setErrors({ structured: '请输入有效 JSON' });
      return null;
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      setErrors({ structured: 'JSON 顶层必须是对象' });
      return null;
    }
    if (props.kind === 'remix-templates')
      return {
        ...common,
        title: values.title.trim(),
        popularityLabel: values.editorialLabel.trim() || undefined,
        baseRemixCount: Number(values.baseLikes),
        tags: values.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        defaultPrompt: values.defaultPrompt.trim(),
        ...(values.secondaryMediaExternalId.trim()
          ? { referenceMediaExternalId: values.secondaryMediaExternalId.trim() }
          : {}),
        ...extra,
      };
    const defaults =
      extra.defaults && typeof extra.defaults === 'object' && !Array.isArray(extra.defaults)
        ? { ...(extra.defaults as Record<string, unknown>), modelId: values.defaultModelId.trim() }
        : extra.defaults;
    return {
      ...common,
      name: values.title.trim(),
      promptTemplate: values.defaultPrompt.trim(),
      ...(values.secondaryMediaExternalId.trim()
        ? { iconMediaExternalId: values.secondaryMediaExternalId.trim() }
        : {}),
      ...extra,
      defaults,
    };
  }

  function validate(operationReason: string): boolean {
    const next: FieldErrors = {};
    for (const name of [
      'externalId',
      'title',
      'description',
      'category',
      'defaultModelId',
      'defaultOutputSpecId',
      'coverMediaExternalId',
    ] as const)
      if (!String(values[name]).trim()) next[name] = '此项不能为空';
    if (operationReason.trim().length < 5 || operationReason.trim().length > 500)
      next.reason = '操作原因需为 5–500 个字符';
    if (
      /api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(
        operationReason,
      )
    )
      next.reason = '原因中不得包含 API 密钥、提示词或图片内容';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving || !validate(reason)) return;
    const content = payload();
    if (!content) return;
    setMessage('');
    setConflict(false);
    try {
      const path = props.record
        ? `/content/${props.kind}/${props.record.id}`
        : `/content/${props.kind}`;
      const body = {
        ...content,
        ...(props.record ? { version } : {}),
        reason: reason.trim(),
      };
      await commandAttempt.run(body, (key) =>
        props.client.command(props.record ? 'PATCH' : 'POST', path, body, key),
      );
      props.onChanged();
      props.onClose();
    } catch (failure) {
      if (failure instanceof AdminError && failure.status === 409 && props.record) {
        setConflict(true);
        setMessage('记录已被其他同事修改');
      } else if (failure instanceof AdminError && failure.field) {
        setErrors({ [formField(failure.field)]: fieldMessage(failure.field) });
        setMessage('请检查下方标记的发布字段');
      } else setMessage(errorText(failure));
    } finally {
      // The shared command-attempt hook releases the pending guard.
    }
  }

  async function reload() {
    if (!props.record) return;
    try {
      const latest = await props.client.get<ContentRecord>(
        `/content/${props.kind}/${props.record.id}`,
      );
      const latestValues = initialValues(props.kind, latest);
      const unresolved = Object.keys(values).filter(
        (field) =>
          JSON.stringify(values[field as keyof typeof values]) !==
          JSON.stringify(latestValues[field as keyof typeof latestValues]),
      );
      setLatestConflict({ record: latest, values: latestValues, unresolved });
      setConflict(false);
      if (!unresolved.length) {
        setVersion(latest.version);
        setLatestConflict(undefined);
        setMessage(`冲突已合并，将基于 v${latest.version} 保存`);
      } else setMessage('请选择每个冲突字段采用本地或服务端值');
    } catch (failure) {
      setMessage(errorText(failure));
    }
  }

  async function confirmTransition() {
    if (!props.record || !transition) return;
    const trimmed = transitionReason.trim();
    let nextError = '';
    if (trimmed.length < 5 || trimmed.length > 500) nextError = '操作原因需为 5–500 个字符';
    if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(trimmed))
      nextError = '原因中不得包含 API 密钥、提示词或图片内容';
    if (nextError) {
      setTransitionReasonError(nextError);
      transitionReasonRef.current?.focus();
      return;
    }
    setTransitionReasonError('');
    setMessage('');
    try {
      const path =
        transition === 'archived'
          ? `/content/${props.kind}/${props.record.id}/archive`
          : `/content/${props.kind}/${props.record.id}/transition`;
      const body =
        transition === 'archived'
          ? { version, reason: transitionReason.trim() }
          : { version, reason: transitionReason.trim(), status: transition };
      await commandAttempt.run(body, (key) => props.client.command('POST', path, body, key));
      props.onChanged();
      props.onClose();
    } catch (failure) {
      if (failure instanceof AdminError && failure.field)
        setErrors({ [formField(failure.field)]: fieldMessage(failure.field) });
      setMessage(
        failure instanceof AdminError && failure.field
          ? '请检查下方标记的发布字段'
          : errorText(failure),
      );
      setTransition(undefined);
    } finally {
      // The shared command-attempt hook releases the pending guard.
    }
  }

  function resolveConflict(field: string, choice: 'local' | 'server') {
    if (!latestConflict) return;
    if (choice === 'server')
      setValues((current) => ({
        ...current,
        [field]: latestConflict.values[field as keyof typeof latestConflict.values],
      }));
    const unresolved = latestConflict.unresolved.filter((item) => item !== field);
    if (unresolved.length) setLatestConflict({ ...latestConflict, unresolved });
    else {
      setVersion(latestConflict.record.version);
      setLatestConflict(undefined);
      commandAttempt.reset();
      setMessage(`冲突已合并，将基于 v${latestConflict.record.version} 保存`);
    }
  }

  const close = () => (dirty ? setConfirmClose(true) : props.onClose());
  const status = props.record?.status ?? 'draft';
  return (
    <Sheet
      open
      disablePointerDismissal={saving}
      onOpenChange={(open) => !open && !saving && close()}
    >
      <SheetContent className="team-sheet operation-sheet" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>
            {props.record ? `编辑${labels[props.kind]}` : `新建${labels[props.kind]}`}
          </SheetTitle>
          <SheetDescription>
            先保存草稿，发布前将再次校验媒体、模型、规格和提示词。
          </SheetDescription>
        </SheetHeader>
        <div className="team-sheet-body">
          <form className="stack" onSubmit={save} noValidate>
            <FieldErrorsProvider value={errors}>
              <fieldset className="team-fields" disabled={!canWrite || saving}>
                <div className="operation-grid">
                  <FormField name="externalId" label="公开标识">
                    <Input
                      value={values.externalId}
                      disabled={Boolean(props.record)}
                      onChange={(e) => update('externalId', e.target.value)}
                    />
                  </FormField>
                  <FormField name="title" label={props.kind === 'tools' ? '工具名称' : '标题'}>
                    <Input value={values.title} onChange={(e) => update('title', e.target.value)} />
                  </FormField>
                  <FormField name="category" label="分类">
                    <Input
                      value={values.category}
                      onChange={(e) => update('category', e.target.value)}
                    />
                  </FormField>
                  <FormField name="sortOrder" label="排序值">
                    <Input
                      type="number"
                      min={0}
                      value={values.sortOrder}
                      onChange={(e) => update('sortOrder', Number(e.target.value))}
                    />
                  </FormField>
                </div>
                <FormField name="description" label="描述">
                  <Textarea
                    value={values.description}
                    onChange={(e) => update('description', e.target.value)}
                  />
                </FormField>
                <div className="operation-grid">
                  <FormField name="creatorName" label="创作者">
                    <Input
                      value={values.creatorName}
                      onChange={(e) => update('creatorName', e.target.value)}
                    />
                  </FormField>
                  <FormField name="sourceType" label="来源类型">
                    <select
                      value={values.sourceType}
                      onChange={(e) => update('sourceType', e.target.value)}
                    >
                      <option value="">未指定</option>
                      <option value="platform">平台创作</option>
                      <option value="licensed-user">用户授权</option>
                      <option value="brand">品牌授权</option>
                      <option value="public-domain">公共领域</option>
                    </select>
                  </FormField>
                  <FormField name="sourceName" label="来源名称">
                    <Input
                      value={values.sourceName}
                      onChange={(e) => update('sourceName', e.target.value)}
                    />
                  </FormField>
                  <FormField name="sourceUrl" label="来源链接">
                    <Input
                      type="url"
                      value={values.sourceUrl}
                      onChange={(e) => update('sourceUrl', e.target.value)}
                    />
                  </FormField>
                </div>
                <div className="operation-grid">
                  <FormField name="defaultModelId" label="默认模型">
                    <Input
                      value={values.defaultModelId}
                      onChange={(e) => update('defaultModelId', e.target.value)}
                    />
                  </FormField>
                  <FormField name="defaultOutputSpecId" label="默认规格">
                    <Input
                      value={values.defaultOutputSpecId}
                      onChange={(e) => update('defaultOutputSpecId', e.target.value)}
                    />
                  </FormField>
                  <FormField name="coverMediaExternalId" label="封面媒体标识">
                    <Input
                      value={values.coverMediaExternalId}
                      onChange={(e) => update('coverMediaExternalId', e.target.value)}
                    />
                  </FormField>
                  <FormField name="secondaryMediaExternalId" label="辅助媒体标识">
                    <Input
                      value={values.secondaryMediaExternalId}
                      onChange={(e) => update('secondaryMediaExternalId', e.target.value)}
                    />
                  </FormField>
                </div>
                <FormField
                  name="defaultPrompt"
                  label={props.kind === 'tools' ? '提示词模板' : '默认提示词'}
                >
                  <Textarea
                    value={values.defaultPrompt}
                    onChange={(e) => update('defaultPrompt', e.target.value)}
                  />
                </FormField>
                {props.kind !== 'tools' && (
                  <>
                    <FormField name="tags" label="标签（逗号分隔）">
                      <Input value={values.tags} onChange={(e) => update('tags', e.target.value)} />
                    </FormField>
                    <FormField
                      name="baseLikes"
                      label={props.kind === 'inspirations' ? '基础点赞数' : '基础复制数'}
                    >
                      <Input
                        type="number"
                        min={0}
                        value={values.baseLikes}
                        onChange={(e) => update('baseLikes', Number(e.target.value))}
                      />
                    </FormField>
                  </>
                )}
                {props.kind !== 'inspirations' && (
                  <FormField
                    name="structured"
                    label={
                      props.kind === 'tools' ? '字段与生成限制 JSON' : '视觉分析与默认参数 JSON'
                    }
                  >
                    <Textarea
                      rows={10}
                      className="operation-code"
                      value={values.structured}
                      onChange={(e) => update('structured', e.target.value)}
                    />
                  </FormField>
                )}
                <FormField name="reason" label="操作原因">
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="说明运营目的；不要填写 API 密钥、提示词或图片内容"
                  />
                </FormField>
              </fieldset>
            </FieldErrorsProvider>
            {message && (
              <p
                className={
                  message.startsWith('已加载') || message.startsWith('冲突已合并')
                    ? 'notices'
                    : 'error-banner'
                }
                role="alert"
              >
                {message}
              </p>
            )}
            {conflict && !latestConflict && (
              <Button type="button" variant="outline" onClick={() => void reload()}>
                加载最新版本
              </Button>
            )}
            <div className="team-form-actions">
              <Button type="button" variant="outline" disabled={saving} onClick={close}>
                取消编辑
              </Button>
              {props.record && canPublish && status !== 'archived' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setTransition(status === 'published' ? 'offline' : 'published')}
                >
                  {status === 'published' ? '下线内容' : '发布内容'}
                </Button>
              )}
              {props.record && canWrite && (status === 'draft' || status === 'offline') && (
                <Button type="button" variant="ghost" onClick={() => setTransition('archived')}>
                  归档内容
                </Button>
              )}
              <Button type="submit" disabled={!canWrite || saving || Boolean(latestConflict)}>
                {props.record ? '保存修改' : '保存草稿'}
              </Button>
            </div>
          </form>
          {confirmClose && (
            <OperationDialog
              title="放弃未保存修改？"
              description="当前内容草稿尚未保存，确认后无法恢复。"
              onClose={() => setConfirmClose(false)}
            >
              <strong role="alert">放弃未保存修改？</strong>
              <div className="team-form-actions">
                <Button variant="outline" onClick={() => setConfirmClose(false)}>
                  继续编辑
                </Button>
                <Button variant="outline" onClick={props.onClose}>
                  放弃并关闭
                </Button>
              </div>
            </OperationDialog>
          )}
          {transition && (
            <OperationDialog
              title={`确认${transition === 'published' ? '发布' : transition === 'offline' ? '下线' : '归档'}内容`}
              description="此操作会改变内容生命周期，请填写原因。"
              pending={saving}
              initialFocus={transitionReasonRef}
              onClose={() => {
                setTransition(undefined);
                setTransitionReasonError('');
              }}
            >
              <label htmlFor="content-transition-reason">
                {transition === 'published'
                  ? '发布原因'
                  : transition === 'offline'
                    ? '下线原因'
                    : '归档原因'}
              </label>
              <Textarea
                ref={transitionReasonRef}
                id="content-transition-reason"
                value={transitionReason}
                aria-invalid={Boolean(transitionReasonError)}
                aria-describedby={
                  transitionReasonError ? 'content-transition-reason-error' : undefined
                }
                onChange={(e) => {
                  setTransitionReason(e.target.value);
                  setTransitionReasonError('');
                }}
              />
              {transitionReasonError && (
                <p id="content-transition-reason-error" className="field-error" role="alert">
                  {transitionReasonError}
                </p>
              )}
              <OperationDialogActions
                pending={saving}
                onCancel={() => setTransition(undefined)}
                confirmLabel={`确认${transition === 'published' ? '发布' : transition === 'offline' ? '下线' : '归档'}`}
                onConfirm={() => void confirmTransition()}
              />
            </OperationDialog>
          )}
          {latestConflict && (
            <OperationDialog
              title="解决字段冲突"
              description={`服务端已有 v${latestConflict.record.version}。逐项确认后才能再次保存。`}
              onClose={() => undefined}
            >
              <div className="stack conflict-fields">
                {latestConflict.unresolved.map((field) => {
                  const label =
                    field === 'title'
                      ? '标题'
                      : field === 'structured'
                        ? '结构化配置'
                        : field === 'description'
                          ? '描述'
                          : field;
                  return (
                    <div className="notices" key={field}>
                      <strong>{label}</strong>
                      <p>
                        服务端：
                        {String(latestConflict.values[field as keyof typeof latestConflict.values])}
                      </p>
                      <div className="team-form-actions">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => resolveConflict(field, 'local')}
                        >
                          保留我的 {label}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => resolveConflict(field, 'server')}
                        >
                          采用服务端 {label}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <Button type="button" disabled>
                  保存修改
                </Button>
              </div>
            </OperationDialog>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
