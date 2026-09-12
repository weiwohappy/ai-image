import { useState, type FormEvent } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AdminActor } from '../contracts';
import { AdminClient, AdminError, errorText } from '../http';
import { useAdminQuery } from '../useQuery';
import { CodeBatchDialog } from './CodeBatchDialog';
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
const localDate = (value: string) => {
  if (!value) return '';
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

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
  const [editing, setEditing] = useState<Campaign | 'new'>();
  const [draft, setDraft] = useState<CampaignDraft>(emptyCampaign);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [lifecycle, setLifecycle] = useState<{ row: Campaign; action: 'disable' | 'archive' }>();
  const [campaignConflict, setCampaignConflict] = useState(false);
  const [codeDialog, setCodeDialog] = useState(false);
  const [codeLifecycle, setCodeLifecycle] = useState<RedemptionCode>();
  const [claims, setClaims] = useState(false);
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
  if (status) params.set('status', status);
  if (queryText.trim() && view !== 'referrals' && !claims) params.set('q', queryText.trim());
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
    setEditing(row ?? 'new');
    setDraft(
      row
        ? {
            name: row.name,
            startsAt: localDate(row.startsAt),
            endsAt: localDate(row.endsAt),
            perUserLimit: row.perUserLimit,
            credits: row.credits,
            totalLimit: row.totalLimit,
          }
        : emptyCampaign,
    );
    setReason('');
    setError('');
    setCampaignConflict(false);
  }

  function safeReason(value: string): boolean {
    if (value.trim().length < 5 || value.trim().length > 500) {
      setError('操作原因需为 5–500 个字符');
      return false;
    }
    if (/api[ _-]?key|\bsk-[a-z0-9]|data:image|base64|prompt|\u63d0\u793a\u8bcd/i.test(value)) {
      setError('原因中不得包含密钥、提示词或图片内容');
      return false;
    }
    return true;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || !safeReason(reason)) return;
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
      await client.command(
        editing === 'new' ? 'POST' : 'PATCH',
        editing === 'new' ? '/redemption-campaigns' : `/redemption-campaigns/${editing.id}`,
        body,
        crypto.randomUUID(),
      );
      setEditing(undefined);
      refresh();
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
      setEditing(latest);
      setCampaignConflict(false);
      setError(`已加载最新版本 v${latest.version}`);
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function changeLifecycle() {
    if (!lifecycle || !safeReason(reason)) return;
    try {
      await client.command(
        'POST',
        `/redemption-campaigns/${lifecycle.row.id}/${lifecycle.action}`,
        { version: lifecycle.row.version, reason: reason.trim() },
        crypto.randomUUID(),
      );
      setLifecycle(undefined);
      setReason('');
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function disableCode() {
    if (!codeLifecycle || !safeReason(reason)) return;
    try {
      await client.command(
        'POST',
        `/redemption-codes/${codeLifecycle.id}/disable`,
        { version: codeLifecycle.version, reason: reason.trim() },
        crypto.randomUUID(),
      );
      setCodeLifecycle(undefined);
      setReason('');
      refresh();
    } catch (failure) {
      setError(errorText(failure));
    }
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
          </div>
          <div className="team-form-actions">
            <Button variant="outline" onClick={refresh}>
              <RefreshCw size={15} />
              刷新
            </Button>
            {canWrite && (
              <Button onClick={() => open()}>
                <Plus size={15} />
                新建兑换活动
              </Button>
            )}
          </div>
        </div>
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
                              aria-label={`编辑${row.name}`}
                              onClick={() => open(row)}
                            >
                              编辑
                            </Button>
                            {row.status === 'active' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`停用${row.name}`}
                                onClick={() => {
                                  setLifecycle({ row, action: 'disable' });
                                  setReason('');
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
                                aria-label={`归档${row.name}`}
                                onClick={() => {
                                  setLifecycle({ row, action: 'archive' });
                                  setReason('');
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
          <div className="operation-confirm operation-form" role="dialog" aria-modal="true">
            <h3>{editing === 'new' ? '新建兑换活动' : `编辑${editing.name}`}</h3>
            <form className="stack" onSubmit={(event) => void save(event)}>
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
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              {campaignConflict && (
                <Button type="button" variant="outline" onClick={() => void reloadCampaign()}>
                  加载最新版本
                </Button>
              )}
              <div className="team-form-actions">
                <Button type="button" variant="outline" onClick={() => setEditing(undefined)}>
                  取消
                </Button>
                <Button type="submit">保存活动</Button>
              </div>
            </form>
          </div>
        )}
        {lifecycle && (
          <div className="operation-confirm" role="dialog" aria-modal="true">
            <h3>确认{lifecycle.action === 'disable' ? '停用' : '归档'}活动</h3>
            <p>将以 v{lifecycle.row.version} 执行状态变更。</p>
            <label className="field">
              {lifecycle.action === 'disable' ? '停用原因' : '归档原因'}
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <div className="team-form-actions">
              <Button variant="outline" onClick={() => setLifecycle(undefined)}>
                取消
              </Button>
              <Button onClick={() => void changeLifecycle()}>
                确认{lifecycle.action === 'disable' ? '停用' : '归档'}
              </Button>
            </div>
          </div>
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
              onClick={() => {
                setClaims(false);
                setCursor('');
              }}
            >
              兑换码
            </Button>
            <Button
              variant={claims ? 'default' : 'outline'}
              onClick={() => {
                setClaims(true);
                setCursor('');
              }}
            >
              兑换记录
            </Button>
          </div>
          {canWrite && !claims && (
            <Button onClick={() => setCodeDialog(true)}>
              <Plus size={15} />
              生成兑换码
            </Button>
          )}
        </div>
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
          <div className="operation-confirm" role="dialog" aria-modal="true">
            <h3>确认停用兑换码</h3>
            <p>{codeLifecycle.displayMask} 停用后将无法继续兑换。</p>
            <label className="field">
              停用原因
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <div className="team-form-actions">
              <Button variant="outline" onClick={() => setCodeLifecycle(undefined)}>
                取消
              </Button>
              <Button onClick={() => void disableCode()}>确认停用</Button>
            </div>
          </div>
        )}
      </section>
    );
  }

  const referrals = (result.data?.rows ?? []) as unknown as Referral[];
  return (
    <section className="operation-page" aria-label="邀请返利">
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
