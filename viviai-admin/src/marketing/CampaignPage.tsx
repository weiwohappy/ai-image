import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AdminActor } from '../contracts';
import { AdminClient, AdminError, errorText } from '../http';
import { useAdminQuery } from '../useQuery';
import { CodeBatchDialog } from './CodeBatchDialog';
import { OperationDialog, OperationDialogActions } from '../operations/OperationDialog';
import { useBeforeUnloadGuard, useDirtyRegistration } from '../operations/dirty-guard';
import { useCommandAttempt } from '../operations/useCommandAttempt';
import { UncertainCommandActions } from '../operations/UncertainCommandActions';
import type { Campaign, MarketingPage, RedemptionCode, Referral } from './contracts';

type View = 'campaigns' | 'codes' | 'referrals';
type CampaignDraft = Omit<
  Campaign,
  'resourceId' | 'id' | 'createdAt' | 'updatedAt' | 'status' | 'version'
>;
const emptyCampaign: CampaignDraft = {
  name: '',
  startsAt: '',
  endsAt: '',
  perUserLimit: 1,
  credits: 1,
  totalLimit: null,
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localDate = (value: string) => {
  if (!value) return '';
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const campaignDraft = (row: Campaign): CampaignDraft => ({
  name: row.name,
  startsAt: localDate(row.startsAt),
  endsAt: localDate(row.endsAt),
  perUserLimit: row.perUserLimit,
  credits: row.credits,
  totalLimit: row.totalLimit,
});

export function CampaignPage({
  view,
  actor,
  client,
  writeEnabled,
}: {
  view: View;
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState('');
  const [status, setStatus] = useState('');
  const [queryText, setQueryText] = useState('');
  const [filterCampaignId, setFilterCampaignId] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [filterCodeId, setFilterCodeId] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [editing, setEditing] = useState<Campaign | 'new'>();
  const [draft, setDraft] = useState<CampaignDraft>(emptyCampaign);
  const [originalDraft, setOriginalDraft] = useState<CampaignDraft>(emptyCampaign);
  const [reason, setReason] = useState('');
  const [reasonInvalid, setReasonInvalid] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [lifecycle, setLifecycle] = useState<{ row: Campaign; action: 'disable' | 'archive' }>();
  const [campaignConflict, setCampaignConflict] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [latestConflict, setLatestConflict] = useState<{
    row: Campaign;
    draft: CampaignDraft;
    unresolved: Array<keyof CampaignDraft>;
    statusChanged: boolean;
  }>();
  const [codeDialog, setCodeDialog] = useState(false);
  const [codeLifecycle, setCodeLifecycle] = useState<RedemptionCode>();
  const [claims, setClaims] = useState(false);
  const commandAttempt = useCommandAttempt();
  const pending = commandAttempt.pending;
  const locked = pending || commandAttempt.uncertain;
  const [lastCommand, setLastCommand] = useState<
    'save' | 'campaign-lifecycle' | 'code-lifecycle'
  >();
  const dirty = Boolean(
    (editing && (JSON.stringify(draft) !== JSON.stringify(originalDraft) || reason.length)) ||
    ((lifecycle || codeLifecycle) && reason.length),
  );
  useBeforeUnloadGuard(dirty || locked);
  useDirtyRegistration({
    dirty,
    pending: locked,
    discard: () => {
      setEditing(undefined);
      setLifecycle(undefined);
      setCodeLifecycle(undefined);
      setReason('');
    },
  });
  const canWrite = writeEnabled && actor.permissions.includes('redemptions.write');
  const endpoint =
    view === 'campaigns'
      ? '/redemption-campaigns'
      : view === 'codes'
        ? claims
          ? '/redemption-claims'
          : '/redemption-codes'
        : '/referrals';
  const params = new URLSearchParams({ limit: '30' });
  const campaignFilterInvalid = Boolean(filterCampaignId && !uuidPattern.test(filterCampaignId));
  const userFilterInvalid = Boolean(filterUserId && !uuidPattern.test(filterUserId));
  const codeFilterInvalid = Boolean(filterCodeId && !uuidPattern.test(filterCodeId));
  const timeFilterInvalid = Boolean(
    filterFrom && filterTo && Date.parse(filterFrom) >= Date.parse(filterTo),
  );
  if (status && (view === 'campaigns' || (view === 'codes' && !claims) || view === 'referrals'))
    params.set('status', status);
  if (queryText.trim() && view !== 'referrals' && !claims) params.set('q', queryText.trim());
  if (filterCampaignId && !campaignFilterInvalid && view === 'codes')
    params.set('campaignId', filterCampaignId);
  if (filterUserId && !userFilterInvalid && (claims || view === 'referrals'))
    params.set('userId', filterUserId);
  if (filterCodeId && !codeFilterInvalid && claims) params.set('codeId', filterCodeId);
  if (filterFrom && !timeFilterInvalid) params.set('from', new Date(filterFrom).toISOString());
  if (filterTo && !timeFilterInvalid) params.set('to', new Date(filterTo).toISOString());
  if (cursor) params.set('cursor', cursor);
  const result = useAdminQuery<MarketingPage<Record<string, unknown>>>(
    client,
    `${endpoint}?${params}`,
    revision,
  );
  const refresh = () => {
    setCursor('');
    setRevision((value) => value + 1);
  };

  function open(row?: Campaign) {
    const nextDraft = row ? campaignDraft(row) : emptyCampaign;
    setEditing(row ?? 'new');
    setDraft(nextDraft);
    setOriginalDraft(nextDraft);
    setReason('');
    setReasonInvalid(false);
    setError('');
    setCampaignConflict(false);
    setLatestConflict(undefined);
  }

  function safeReason(value: string): boolean {
    if (value.trim().length < 5 || value.trim().length > 500) {
      setError('操作原因需为 5–500 个字符');
      setReasonInvalid(true);
      reasonRef.current?.focus();
      return false;
    }
    if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(value)) {
      setError('原因中不得包含密钥、提示词或图片内容');
      setReasonInvalid(true);
      reasonRef.current?.focus();
      return false;
    }
    setReasonInvalid(false);
    return true;
  }

  async function save(event?: FormEvent, retry = false) {
    event?.preventDefault();
    if (pending || !editing || (!retry && !safeReason(reason))) return;
    if (
      !draft.name.trim() ||
      !draft.startsAt ||
      !draft.endsAt ||
      Date.parse(draft.startsAt) >= Date.parse(draft.endsAt)
    )
      return setError('请填写有效的活动名称与时间范围');
    const body = {
      ...draft,
      startsAt: new Date(draft.startsAt).toISOString(),
      endsAt: new Date(draft.endsAt).toISOString(),
      ...(editing === 'new' ? {} : { version: editing.version }),
      reason: reason.trim(),
    };
    try {
      const method = editing === 'new' ? 'POST' : 'PATCH';
      const path =
        editing === 'new' ? '/redemption-campaigns' : `/redemption-campaigns/${editing.id}`;
      setLastCommand('save');
      const result = retry
        ? await commandAttempt.retry()
        : await commandAttempt.run(
            {
              method,
              path,
              action: `redemptions.campaign.${editing === 'new' ? 'create' : 'update'}`,
              target: editing === 'new' ? draft.name.trim() : editing.id,
            },
            body,
            (key) => client.command(method, path, body, key),
          );
      if (result.kind === 'success') {
        setLastCommand(undefined);
        setEditing(undefined);
        refresh();
      }
    } catch (failure) {
      if (failure instanceof AdminError && failure.status === 409 && editing !== 'new') {
        setCampaignConflict(true);
        setError('活动已被其他同事修改，请加载最新版本');
      } else
        setError(
          failure instanceof AdminError && failure.code === 'REDEMPTION_CAMPAIGN_LIMIT_EXCEEDED'
            ? '新上限低于已承诺的兑换容量'
            : errorText(failure),
        );
    }
  }

  async function reloadCampaign() {
    if (!editing || editing === 'new') return;
    try {
      const latest = await client.get<Campaign>(`/redemption-campaigns/${editing.id}`);
      const nextDraft = campaignDraft(latest);
      const statusChanged = editing.status !== latest.status;
      setEditing(latest);
      const unresolved = (Object.keys(draft) as Array<keyof CampaignDraft>).filter(
        (field) => JSON.stringify(draft[field]) !== JSON.stringify(nextDraft[field]),
      );
      setLatestConflict({ row: latest, draft: nextDraft, unresolved, statusChanged });
      setCampaignConflict(false);
      if (!unresolved.length) {
        setEditing(latest);
        setLatestConflict(undefined);
        setError(`冲突已合并，将基于 v${latest.version} 保存`);
      } else setError('请选择每个冲突字段采用本地或服务端值');
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function changeLifecycle(retry = false) {
    if (pending || !lifecycle || (!retry && !safeReason(reason))) return;
    try {
      const body = { version: lifecycle.row.version, reason: reason.trim() };
      const path = `/redemption-campaigns/${lifecycle.row.id}/${lifecycle.action}`;
      setLastCommand('campaign-lifecycle');
      const result = retry
        ? await commandAttempt.retry()
        : await commandAttempt.run(
            {
              method: 'POST',
              path,
              action: `redemptions.campaign.${lifecycle.action}`,
              target: lifecycle.row.id,
            },
            body,
            (key) => client.command('POST', path, body, key),
          );
      if (result.kind === 'success') {
        setLastCommand(undefined);
        setLifecycle(undefined);
        setReason('');
        refresh();
      }
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function disableCode(retry = false) {
    if (pending || !codeLifecycle || (!retry && !safeReason(reason))) return;
    try {
      const body = { version: codeLifecycle.version, reason: reason.trim() };
      const path = `/redemption-codes/${codeLifecycle.id}/disable`;
      setLastCommand('code-lifecycle');
      const result = retry
        ? await commandAttempt.retry()
        : await commandAttempt.run(
            {
              method: 'POST',
              path,
              action: 'redemptions.code.disable',
              target: codeLifecycle.id,
            },
            body,
            (key) => client.command('POST', path, body, key),
          );
      if (result.kind === 'success') {
        setLastCommand(undefined);
        setCodeLifecycle(undefined);
        setReason('');
        refresh();
      }
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  const conflictLabels: Record<keyof CampaignDraft, string> = useMemo(
    () => ({
      name: '活动名称',
      startsAt: '开始时间',
      endsAt: '结束时间',
      perUserLimit: '每用户上限',
      credits: '兑换积分',
      totalLimit: '总兑换上限',
    }),
    [],
  );
  function resolveCampaignConflict(field: keyof CampaignDraft, choice: 'local' | 'server') {
    if (!latestConflict) return;
    if (choice === 'server')
      setDraft((current) => ({ ...current, [field]: latestConflict.draft[field] }));
    const unresolved = latestConflict.unresolved.filter((item) => item !== field);
    if (unresolved.length) setLatestConflict({ ...latestConflict, unresolved });
    else {
      setEditing(latestConflict.row);
      setLatestConflict(undefined);
      commandAttempt.reset();
      setError(`冲突已合并，将基于 v${latestConflict.row.version} 保存`);
    }
  }
  function requestCloseEditor() {
    if (locked) return;
    if (dirty) setConfirmDiscard(true);
    else setEditing(undefined);
  }

  if (view === 'campaigns') {
    const rows = (result.data?.rows ?? []) as unknown as Campaign[];
    return (
      <section className="operation-page" aria-label="兑换活动">
        <div className="operation-toolbar">
          <div className="operation-filters">
            <label>
              关键词
              <Input
                value={queryText}
                onChange={(e) => {
                  setQueryText(e.target.value);
                  setCursor('');
                }}
              />
            </label>
            <label>
              状态
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setCursor('');
                }}
              >
                <option value="">全部</option>
                <option value="active">进行中</option>
                <option value="disabled">已停用</option>
                <option value="archived">已归档</option>
              </select>
            </label>
            <label>
              活动开始筛选
              <Input
                type="datetime-local"
                value={filterFrom}
                aria-invalid={timeFilterInvalid}
                onChange={(event) => {
                  setFilterFrom(event.target.value);
                  setCursor('');
                }}
              />
            </label>
            <label>
              活动结束筛选
              <Input
                type="datetime-local"
                value={filterTo}
                aria-invalid={timeFilterInvalid}
                onChange={(event) => {
                  setFilterTo(event.target.value);
                  setCursor('');
                }}
              />
            </label>
          </div>
          <div className="team-form-actions">
            <Button variant="outline" disabled={locked} onClick={refresh}>
              <RefreshCw size={15} />
              刷新
            </Button>
            {canWrite && (
              <Button disabled={locked} onClick={() => open()}>
                <Plus size={15} />
                新建兑换活动
              </Button>
            )}
          </div>
        </div>
        {timeFilterInvalid && (
          <p className="field-error" role="alert">
            开始时间必须早于结束时间
          </p>
        )}
        {error && !editing && !lifecycle && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {result.loading ? (
          <div className="panel loading-state" role="status">
            正在读取兑换活动…
          </div>
        ) : result.error ? (
          <p className="error-banner" role="alert">
            {result.error}
          </p>
        ) : (
          <div className="panel operation-table-wrap">
            <table className="operation-table">
              <thead>
                <tr>
                  <th>活动</th>
                  <th>时间范围</th>
                  <th>积分</th>
                  <th>总上限</th>
                  <th>状态</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.name}</strong>
                      <small>{row.id}</small>
                    </td>
                    <td>
                      {new Date(row.startsAt).toLocaleDateString('zh-CN')} –{' '}
                      {new Date(row.endsAt).toLocaleDateString('zh-CN')}
                    </td>
                    <td>{row.credits}</td>
                    <td>{row.totalLimit ?? '不限'}</td>
                    <td>
                      <span className={`status status-${row.status}`}>{row.status}</span>
                    </td>
                    <td>v{row.version}</td>
                    <td>
                      <div className="operation-row-actions">
                        {canWrite && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={locked}
                              aria-label={`编辑${row.name}`}
                              onClick={() => open(row)}
                            >
                              编辑
                            </Button>
                            {row.status === 'active' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={locked}
                                aria-label={`停用${row.name}`}
                                onClick={() => {
                                  setLifecycle({ row, action: 'disable' });
                                  setReason('');
                                  setReasonInvalid(false);
                                  setError('');
                                }}
                              >
                                停用
                              </Button>
                            )}
                            {row.status === 'disabled' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={locked}
                                aria-label={`归档${row.name}`}
                                onClick={() => {
                                  setLifecycle({ row, action: 'archive' });
                                  setReason('');
                                  setReasonInvalid(false);
                                  setError('');
                                }}
                              >
                                归档
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="operation-empty">
                      尚无兑换活动
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {result.data?.nextCursor && (
          <div className="operation-pagination">
            <Button variant="outline" onClick={() => setCursor(result.data!.nextCursor!)}>
              下一页
            </Button>
          </div>
        )}
        {editing && (
          <OperationDialog
            title={editing === 'new' ? '新建兑换活动' : `编辑${editing.name}`}
            description="保存活动配置前请核对时间、容量和积分，并填写可审计原因。"
            pending={locked}
            className="operation-form"
            onClose={requestCloseEditor}
          >
            <form className="stack" onSubmit={(event) => void save(event)}>
              <fieldset
                disabled={locked || (editing !== 'new' && editing.status === 'archived')}
                className="stack"
              >
                <label className="field">
                  活动名称
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <div className="operation-grid">
                  <label className="field">
                    开始时间
                    <Input
                      type="datetime-local"
                      value={draft.startsAt}
                      onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    结束时间
                    <Input
                      type="datetime-local"
                      value={draft.endsAt}
                      onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    每用户上限
                    <Input
                      type="number"
                      min={1}
                      value={draft.perUserLimit}
                      onChange={(e) => setDraft({ ...draft, perUserLimit: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    兑换积分
                    <Input
                      type="number"
                      min={1}
                      value={draft.credits}
                      onChange={(e) => setDraft({ ...draft, credits: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    总兑换上限
                    <Input
                      type="number"
                      min={1}
                      value={draft.totalLimit ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          totalLimit: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </label>
                </div>
                <label className="field">
                  操作原因
                  <Textarea
                    ref={reasonRef}
                    value={reason}
                    aria-invalid={reasonInvalid}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setReasonInvalid(false);
                    }}
                  />
                </label>
              </fieldset>
              {error && (
                <p
                  className={error.startsWith('冲突已合并') ? 'notices' : 'error-banner'}
                  role="alert"
                >
                  {error}
                </p>
              )}
              {commandAttempt.uncertain && lastCommand === 'save' && (
                <UncertainCommandActions
                  pending={pending}
                  onRetry={() => void save(undefined, true)}
                  onAbandon={() => {
                    commandAttempt.abandon();
                    setLastCommand(undefined);
                  }}
                />
              )}
              {campaignConflict && !latestConflict && (
                <Button type="button" variant="outline" onClick={() => void reloadCampaign()}>
                  加载最新版本
                </Button>
              )}
              <div className="team-form-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={requestCloseEditor}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    locked ||
                    Boolean(latestConflict) ||
                    (editing !== 'new' && editing.status === 'archived')
                  }
                >
                  保存活动
                </Button>
              </div>
            </form>
          </OperationDialog>
        )}
        {lifecycle && (
          <OperationDialog
            title={`确认${lifecycle.action === 'disable' ? '停用' : '归档'}活动`}
            description={`将以 v${lifecycle.row.version} 执行状态变更。`}
            pending={locked}
            initialFocus={reasonRef}
            onClose={() => {
              setLifecycle(undefined);
              setReason('');
            }}
          >
            <label className="field">
              {lifecycle.action === 'disable' ? '停用原因' : '归档原因'}
              <Textarea
                ref={reasonRef}
                value={reason}
                aria-invalid={reasonInvalid}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonInvalid(false);
                }}
              />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <OperationDialogActions
              pending={locked}
              onCancel={() => {
                setLifecycle(undefined);
                setReason('');
              }}
              confirmLabel={`确认${lifecycle.action === 'disable' ? '停用' : '归档'}`}
              onConfirm={() => void changeLifecycle()}
            />
            {commandAttempt.uncertain && lastCommand === 'campaign-lifecycle' && (
              <UncertainCommandActions
                pending={pending}
                onRetry={() => void changeLifecycle(true)}
                onAbandon={() => {
                  commandAttempt.abandon();
                  setLastCommand(undefined);
                }}
              />
            )}
          </OperationDialog>
        )}
        {latestConflict && (
          <OperationDialog
            title="解决活动冲突"
            description={`服务端已有 v${latestConflict.row.version}。逐项确认后才能再次保存。`}
            onClose={() => undefined}
          >
            <div className="stack conflict-fields">
              {latestConflict.statusChanged && (
                <p className="notices">
                  服务端状态已变为 {latestConflict.row.status}，不能由字段合并覆盖
                </p>
              )}
              {latestConflict.unresolved.map((field) => (
                <div className="notices" key={field}>
                  <strong>{conflictLabels[field]}</strong>
                  <p>服务端：{String(latestConflict.draft[field] ?? '不限')}</p>
                  <div className="team-form-actions">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => resolveCampaignConflict(field, 'local')}
                    >
                      保留我的 {conflictLabels[field]}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => resolveCampaignConflict(field, 'server')}
                    >
                      采用服务端 {conflictLabels[field]}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </OperationDialog>
        )}
        {confirmDiscard && (
          <OperationDialog
            title="放弃未保存修改？"
            description="当前活动草稿尚未保存，确认后无法恢复。"
            onClose={() => setConfirmDiscard(false)}
          >
            <div className="team-form-actions">
              <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
                继续编辑
              </Button>
              <Button
                onClick={() => {
                  setConfirmDiscard(false);
                  setEditing(undefined);
                  setReason('');
                }}
              >
                放弃并关闭
              </Button>
            </div>
          </OperationDialog>
        )}
      </section>
    );
  }

  if (view === 'codes') {
    const rows = result.data?.rows ?? [];
    return (
      <section className="operation-page" aria-label="兑换码">
        <div className="operation-toolbar">
          <div className="segmented">
            <Button
              variant={!claims ? 'default' : 'outline'}
              disabled={locked}
              onClick={() => {
                setClaims(false);
                setCursor('');
              }}
            >
              兑换码
            </Button>
            <Button
              variant={claims ? 'default' : 'outline'}
              disabled={locked}
              onClick={() => {
                setClaims(true);
                setCursor('');
              }}
            >
              兑换记录
            </Button>
          </div>
          {canWrite && !claims && (
            <Button disabled={locked} onClick={() => setCodeDialog(true)}>
              <Plus size={15} />
              生成兑换码
            </Button>
          )}
        </div>
        <div className="operation-filters panel panel-padding">
          {!claims && (
            <label>
              兑换码关键词
              <Input
                value={queryText}
                onChange={(event) => {
                  setQueryText(event.target.value);
                  setCursor('');
                }}
              />
            </label>
          )}
          <label>
            活动 ID 筛选
            <Input
              value={filterCampaignId}
              pattern="[0-9a-fA-F-]{36}"
              aria-invalid={campaignFilterInvalid}
              onChange={(event) => {
                setFilterCampaignId(event.target.value.trim());
                setCursor('');
              }}
            />
          </label>
          {claims ? (
            <>
              <label>
                用户 ID 筛选
                <Input
                  value={filterUserId}
                  pattern="[0-9a-fA-F-]{36}"
                  aria-invalid={userFilterInvalid}
                  onChange={(event) => {
                    setFilterUserId(event.target.value.trim());
                    setCursor('');
                  }}
                />
              </label>
              <label>
                兑换码 ID 筛选
                <Input
                  value={filterCodeId}
                  pattern="[0-9a-fA-F-]{36}"
                  aria-invalid={codeFilterInvalid}
                  onChange={(event) => {
                    setFilterCodeId(event.target.value.trim());
                    setCursor('');
                  }}
                />
              </label>
            </>
          ) : (
            <label>
              兑换码状态
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setCursor('');
                }}
              >
                <option value="">全部</option>
                <option value="active">可兑换</option>
                <option value="disabled">已停用</option>
              </select>
            </label>
          )}
          <label>
            创建开始时间
            <Input
              type="datetime-local"
              value={filterFrom}
              aria-invalid={timeFilterInvalid}
              onChange={(event) => {
                setFilterFrom(event.target.value);
                setCursor('');
              }}
            />
          </label>
          <label>
            创建结束时间
            <Input
              type="datetime-local"
              value={filterTo}
              aria-invalid={timeFilterInvalid}
              onChange={(event) => {
                setFilterTo(event.target.value);
                setCursor('');
              }}
            />
          </label>
        </div>
        {(campaignFilterInvalid || userFilterInvalid || codeFilterInvalid || timeFilterInvalid) && (
          <p className="field-error" role="alert">
            {timeFilterInvalid ? '开始时间必须早于结束时间' : '筛选 ID 必须是有效 UUID'}
          </p>
        )}
        {result.loading ? (
          <div className="panel loading-state" role="status">
            正在读取兑换数据…
          </div>
        ) : result.error ? (
          <p className="error-banner" role="alert">
            {result.error}
          </p>
        ) : (
          <div className="panel operation-table-wrap">
            <table className="operation-table">
              <thead>
                <tr>
                  {(claims
                    ? ['兑换时间', '用户', '兑换码', '活动', '积分']
                    : ['兑换码', '活动 ID', '使用量', '状态', '版本', '操作']
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((raw) => {
                  const row = raw as Record<string, unknown>;
                  return (
                    <tr key={String(row.id)}>
                      {claims ? (
                        <>
                          <td>{new Date(String(row.createdAt)).toLocaleString('zh-CN')}</td>
                          <td>{String(row.userEmail)}</td>
                          <td>
                            <code>{String(row.codeMask)}</code>
                          </td>
                          <td>{String(row.campaignName)}</td>
                          <td>{String(row.credits)}</td>
                        </>
                      ) : (
                        <>
                          <td>
                            <code>{String(row.displayMask)}</code>
                          </td>
                          <td>
                            <code>{String(row.campaignId)}</code>
                          </td>
                          <td>
                            {String(row.usedCount)} / {String(row.maxUses)}
                          </td>
                          <td>{String(row.status)}</td>
                          <td>v{String(row.version)}</td>
                          <td>
                            {canWrite && row.status === 'active' && (
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`停用${String(row.displayMask)}`}
                                onClick={() => {
                                  setCodeLifecycle(row as unknown as RedemptionCode);
                                  setReason('');
                                  setReasonInvalid(false);
                                  setError('');
                                }}
                              >
                                停用
                              </Button>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {result.data?.nextCursor && (
          <div className="operation-pagination">
            <Button variant="outline" onClick={() => setCursor(result.data!.nextCursor!)}>
              下一页
            </Button>
          </div>
        )}
        {codeDialog && (
          <CodeBatchDialog
            client={client}
            onClose={() => setCodeDialog(false)}
            onChanged={refresh}
          />
        )}
        {codeLifecycle && (
          <OperationDialog
            title="确认停用兑换码"
            description={`${codeLifecycle.displayMask} 停用后将无法继续兑换。`}
            pending={locked}
            initialFocus={reasonRef}
            onClose={() => {
              setCodeLifecycle(undefined);
              setReason('');
            }}
          >
            <label className="field">
              停用原因
              <Textarea
                ref={reasonRef}
                value={reason}
                aria-invalid={reasonInvalid}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonInvalid(false);
                }}
              />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <OperationDialogActions
              pending={locked}
              onCancel={() => {
                setCodeLifecycle(undefined);
                setReason('');
              }}
              confirmLabel="确认停用"
              onConfirm={() => void disableCode()}
            />
            {commandAttempt.uncertain && lastCommand === 'code-lifecycle' && (
              <UncertainCommandActions
                pending={pending}
                onRetry={() => void disableCode(true)}
                onAbandon={() => {
                  commandAttempt.abandon();
                  setLastCommand(undefined);
                }}
              />
            )}
          </OperationDialog>
        )}
      </section>
    );
  }

  const referrals = (result.data?.rows ?? []) as unknown as Referral[];
  return (
    <section className="operation-page" aria-label="邀请返利">
      <div className="operation-filters panel panel-padding">
        <label>
          邀请人或被邀请人 ID
          <Input
            value={filterUserId}
            pattern="[0-9a-fA-F-]{36}"
            aria-invalid={userFilterInvalid}
            onChange={(event) => {
              setFilterUserId(event.target.value.trim());
              setCursor('');
            }}
          />
        </label>
        <label>
          返利状态
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setCursor('');
            }}
          >
            <option value="">全部</option>
            <option value="pending">待满足</option>
            <option value="rewarded">已奖励</option>
          </select>
        </label>
        <label>
          创建开始时间
          <Input
            type="datetime-local"
            value={filterFrom}
            aria-invalid={timeFilterInvalid}
            onChange={(event) => {
              setFilterFrom(event.target.value);
              setCursor('');
            }}
          />
        </label>
        <label>
          创建结束时间
          <Input
            type="datetime-local"
            value={filterTo}
            aria-invalid={timeFilterInvalid}
            onChange={(event) => {
              setFilterTo(event.target.value);
              setCursor('');
            }}
          />
        </label>
      </div>
      {(userFilterInvalid || timeFilterInvalid) && (
        <p className="field-error" role="alert">
          {timeFilterInvalid ? '开始时间必须早于结束时间' : '筛选 ID 必须是有效 UUID'}
        </p>
      )}
      {result.loading ? (
        <div className="panel loading-state" role="status">
          正在读取邀请记录…
        </div>
      ) : result.error ? (
        <p className="error-banner" role="alert">
          {result.error}
        </p>
      ) : (
        <div className="panel operation-table-wrap">
          <table className="operation-table">
            <thead>
              <tr>
                <th>邀请人</th>
                <th>被邀请人</th>
                <th>状态</th>
                <th>奖励积分</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.inviterEmail}
                    <small>{row.inviterUserId}</small>
                  </td>
                  <td>
                    {row.inviteeEmail}
                    <small>{row.inviteeUserId}</small>
                  </td>
                  <td>{row.status}</td>
                  <td>{row.rewardCredits}</td>
                  <td>{new Date(row.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.data?.nextCursor && (
        <div className="operation-pagination">
          <Button variant="outline" onClick={() => setCursor(result.data!.nextCursor!)}>
            下一页
          </Button>
        </div>
      )}
    </section>
  );
}
