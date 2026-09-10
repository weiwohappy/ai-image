import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { ActionForm } from '../team/ActionForm';
import { FormField } from '../team/FormField';
import type { AdminClient } from '../http';
import { formatValue } from '../format';
import type { ModelPriceRow, PriceAction } from './contracts';

export function PriceEditor({
  row,
  action,
  client,
  onClose,
  onChanged,
  onPermissionsChanged,
}: {
  row: ModelPriceRow;
  action: PriceAction;
  client: AdminClient;
  onClose: () => void;
  onChanged: () => void;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [credits, setCredits] = useState(row.unitCredits === null ? '' : String(row.unitCredits));
  const [enabled, setEnabled] = useState(
    action === 'create' || action === 'enable' ? true : action === 'disable' ? false : row.enabled,
  );
  const [count, setCount] = useState(1);
  const [baseline, setBaseline] = useState(row);
  const stateOnly = action === 'enable' || action === 'disable';
  const canAct = (name: PriceAction) =>
    baseline.allowedActions.some((rule) => rule.action === name && rule.allowed);
  const effectiveAction = baseline.priceId === null ? 'create' : stateOnly ? action : 'edit';
  const canChangeState =
    baseline.priceId === null ? canAct('create') : canAct(baseline.enabled ? 'disable' : 'enable');
  const permitted =
    canAct(effectiveAction) &&
    (baseline.priceId === null ||
      enabled === baseline.enabled ||
      canAct(enabled ? 'enable' : 'disable'));
  const valid = /^\d+$/.test(credits) && Number(credits) >= 1 && Number(credits) <= 1_000_000;
  const path = `/model-pricing/${encodeURIComponent(row.modelId)}/${encodeURIComponent(row.resolution)}`;
  const summary = (price: ModelPriceRow) =>
    price.unitCredits === null
      ? '未配置 · v0'
      : `${formatValue(price.unitCredits, 'credits')} · ${price.enabled ? '已启用' : '已停用'} · v${price.version}`;
  return (
    <ActionForm
      client={client}
      title={
        action === 'create'
          ? '配置积分价格'
          : action === 'disable'
            ? '停用积分价格'
            : action === 'enable'
              ? '启用积分价格'
              : '编辑积分价格'
      }
      description="按模型与分辨率设置单张积分；同分辨率的已支持比例同价，文生图与爆款复刻共用。"
      submitLabel={
        action === 'disable' ? '确认停用' : action === 'enable' ? '确认启用' : '保存价格'
      }
      successText="积分价格已保存"
      method="PUT"
      path={path}
      initialVersion={row.version}
      payload={() => ({ unitCredits: Number(credits), enabled })}
      submitDisabled={!permitted}
      validate={() => (valid ? undefined : { unitCredits: '单张积分需为 1–1,000,000 的整数' })}
      onReload={async () => {
        const latest = await client.get<ModelPriceRow>(path);
        setBaseline(latest);
        // A status-only command must not restore a stale price after a concurrent edit.
        if (stateOnly) setCredits(latest.unitCredits === null ? '' : String(latest.unitCredits));
        return { version: latest.version, summary: summary(latest) };
      }}
      onClose={onClose}
      onChanged={onChanged}
      onPermissionsChanged={onPermissionsChanged}
    >
      <div className="pricing-spec-summary">
        <strong>
          {row.name} · {row.resolution}
        </strong>
        <p className="pricing-secondary">{row.modelId}</p>
        <details>
          <summary>适用比例与像素（{row.specs.length} 项，只读）</summary>
          <ul>
            {row.specs.map((spec) => (
              <li key={spec.id}>
                {spec.ratio} · {spec.width} × {spec.height}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <FormField name="unitCredits" label="单张积分">
        <Input
          inputMode="numeric"
          maxLength={12}
          value={credits}
          readOnly={stateOnly}
          placeholder="请输入整数积分"
          onChange={(e) => setCredits(e.target.value)}
        />
      </FormField>
      <label className="team-choice">
        <input
          type="checkbox"
          aria-label="价格启用"
          checked={enabled}
          disabled={stateOnly || !canChangeState}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          价格启用<small>停用后不再接受此分辨率的新报价，历史记录仍保留。</small>
        </span>
      </label>
      {!permitted && (
        <p className="error-banner" role="alert">
          当前记录已不允许此操作，请关闭后刷新列表。
        </p>
      )}
      <div className="pricing-change-preview">
        <span className="pricing-secondary">本次变更</span>
        <p>
          {summary(baseline)} → {valid ? formatValue(Number(credits), 'credits') : '待填写'} ·{' '}
          {enabled ? '启用' : '停用'}
        </p>
        <div className="pricing-total-preview">
          <label>
            示例张数
            <select
              aria-label="示例张数"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </label>
          <strong>{valid ? formatValue(Number(credits) * count, 'credits') : '—'}</strong>
        </div>
        {!enabled && <p className="pricing-secondary">仅展示计算结果；停用价格不能用于新任务。</p>}
      </div>
      <p className="notices">
        保存后新报价立即生效；旧报价需重新确认，已提交任务不变。积分启用不会自动启用 API 渠道。
      </p>
      <p className="pricing-secondary">
        操作原因中不要填写密码、密钥或客户内容（包括提示词与参考图信息）。
      </p>
    </ActionForm>
  );
}
