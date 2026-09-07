// 「管理」抽屉 · 编辑角色（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 只提交改过的键：一次 `agent.update` 带一个最小 patch。原因不是省流量——
// 电脑端对 patch 做的是覆盖写，把没动过的字段一起发回去，等于用手机上这份
// （可能已经过时的）投影去覆盖电脑端的真值，两台设备同时编辑时会互相吃掉改动。
//
// 凭据类字段（searchConfig / voice* / apiKey）压根不在投影里，这里也没有入口。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { ACTION_LIMITS, type AgentPatch } from '../../server/actionContract';
import type { ViewAgent, ViewGroup, ViewProvider } from '../viewerClient';
import { ActionButton, Field, PanelHint, ToggleRow, inputClass, type PanelBaseProps } from './shared';

export interface AgentEditPanelProps extends PanelBaseProps {
  agents: ViewAgent[];
  providers: ViewProvider[];
  /** 电脑端当前群，只用来把成员排在下拉最前面 */
  group: ViewGroup | null;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}

interface Draft {
  name: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  /** 空串 = 跟随供应商默认（对应 config.temperature = null） */
  temperature: string;
  maxTokens: string;
  mentionOnly: boolean;
  enablePM: boolean;
  role: 'MEMBER' | 'ADMIN';
  commandMode: 'text' | 'native';
}

function toDraft(a: ViewAgent): Draft {
  const cfg = a.config || {};
  return {
    name: a.name || '',
    providerId: a.providerId || '',
    modelId: a.modelId || '',
    systemPrompt: a.systemPrompt || '',
    temperature: cfg.temperature === null || cfg.temperature === undefined ? '' : String(cfg.temperature),
    maxTokens: cfg.maxTokens === undefined ? '' : String(cfg.maxTokens),
    mentionOnly: !!a.mentionOnly,
    enablePM: !!a.enablePM,
    // AgentRole 是字符串枚举，TS 里不能直接赋给 'MEMBER' | 'ADMIN'，过一次 String
    role: String(a.role) === 'ADMIN' ? 'ADMIN' : 'MEMBER',
    commandMode: a.commandMode === 'native' ? 'native' : 'text',
  };
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  (Object.keys(a) as Array<keyof Draft>).every(k => a[k] === b[k]);

const AgentEditPanel: React.FC<AgentEditPanelProps> = ({
  t,
  runAction,
  isPending,
  disabled,
  agents,
  providers,
  group,
  selectedId,
  onSelect,
}) => {
  const selected = useMemo(() => agents.find(a => a.id === selectedId) || null, [agents, selectedId]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const lastIdRef = useRef<string | null>(null);
  // 下面那个 effect 要读「当前草稿」和「上一版基线」，但不能把它们写进依赖
  // （写进去就会自己触发自己）。渲染期同步一份 ref 是这个文件里唯一的 ref 用法。
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const baselineRef = useRef<Draft | null>(null);
  baselineRef.current = baseline;

  /**
   * 表单初始化 / 重新同步。
   * 换人一定重置；同一个人的投影被 catalog 刷新过（比如电脑端自己也在改），
   * 只在本地没有未保存改动时才跟着更新，否则会把用户正在打的字冲掉。
   */
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      setBaseline(null);
      lastIdRef.current = null;
      return;
    }
    const next = toDraft(selected);
    const switched = lastIdRef.current !== selected.id;
    const cur = draftRef.current;
    const base = baselineRef.current;
    const dirty = !switched && !!cur && !!base && !sameDraft(cur, base);
    lastIdRef.current = selected.id;
    setBaseline(next);
    if (!dirty) setDraft(next);
    if (switched) setError('');
  }, [selected]);

  // 提示词 textarea 自动高度：内容变了要重算，换人也要重算
  const autoSize = useCallback(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // 上限压在 40vh：再高的话保存按钮会被推出抽屉可视区，得先滚一段才点得到
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, []);

  useEffect(() => {
    autoSize();
  }, [autoSize, draft?.systemPrompt, selectedId]);

  const sortedAgents = useMemo(() => {
    const memberIds = new Set(group?.memberIds || []);
    return {
      members: agents.filter(a => memberIds.has(a.id)),
      others: agents.filter(a => !memberIds.has(a.id)),
    };
  }, [agents, group]);

  const provider = useMemo(
    () => providers.find(p => p.id === draft?.providerId) || null,
    [providers, draft?.providerId]
  );

  const patch = useMemo<AgentPatch | null>(() => {
    if (!draft || !baseline) return null;
    const p: AgentPatch = {};
    if (draft.name !== baseline.name) p.name = draft.name.trim();
    if (draft.systemPrompt !== baseline.systemPrompt) p.systemPrompt = draft.systemPrompt;
    if (draft.providerId !== baseline.providerId) p.providerId = draft.providerId;
    if (draft.modelId !== baseline.modelId) p.modelId = draft.modelId;
    if (draft.mentionOnly !== baseline.mentionOnly) p.mentionOnly = draft.mentionOnly;
    if (draft.enablePM !== baseline.enablePM) p.enablePM = draft.enablePM;
    if (draft.role !== baseline.role) p.role = draft.role;
    if (draft.commandMode !== baseline.commandMode) p.commandMode = draft.commandMode;

    const config: NonNullable<AgentPatch['config']> = {};
    if (draft.temperature !== baseline.temperature) {
      config.temperature = draft.temperature.trim() === '' ? null : Number(draft.temperature);
    }
    if (draft.maxTokens !== baseline.maxTokens && draft.maxTokens.trim() !== '') {
      config.maxTokens = Number(draft.maxTokens);
    }
    if (Object.keys(config).length > 0) p.config = config;

    return Object.keys(p).length > 0 ? p : null;
  }, [draft, baseline]);

  const validate = (p: AgentPatch): string => {
    if (p.name !== undefined) {
      if (!p.name) return t('名字不能为空');
      if (p.name.length > ACTION_LIMITS.name) return t('名字太长（上限 100 字）');
    }
    if (p.systemPrompt !== undefined && p.systemPrompt.length > ACTION_LIMITS.systemPrompt) {
      return t('提示词太长（上限 64000 字）');
    }
    const temp = p.config?.temperature;
    if (temp !== undefined && temp !== null && (!Number.isFinite(temp) || temp < 0 || temp > 2)) {
      return `${t('温度')} 0 – 2`;
    }
    const max = p.config?.maxTokens;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > ACTION_LIMITS.maxTokensMax)) {
      return `${t('最大输出')} 1 – ${ACTION_LIMITS.maxTokensMax}`;
    }
    return '';
  };

  if (agents.length === 0) {
    return <PanelHint>{t('这个群还没有可编辑的角色')}</PanelHint>;
  }

  const pendingKey = `agent-update:${selectedId || ''}`;

  return (
    <div className="px-3 pb-6 pt-2 space-y-3">
      <Field label={t('选择角色')}>
        <select
          value={selectedId || ''}
          onChange={e => onSelect(e.target.value)}
          className={inputClass}
          aria-label={t('选择角色')}
        >
          <option value="">—</option>
          {sortedAgents.members.length > 0 && (
            <optgroup label={t('本群成员')}>
              {sortedAgents.members.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {sortedAgents.others.length > 0 && (
            <optgroup label={t('其他角色')}>
              {sortedAgents.others.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      {!draft && <PanelHint>{t('选一个角色开始编辑')}</PanelHint>}

      {draft && (
        <>
          <Field label={t('名字')}>
            <input
              type="text"
              value={draft.name}
              maxLength={ACTION_LIMITS.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              className={inputClass}
            />
          </Field>

          {providers.length === 0 ? (
            <div className="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">
              {t('没有可用的供应商')}：{t('这台电脑还没配供应商，或者服务端版本较旧')}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('供应商')}>
                <select
                  value={draft.providerId}
                  onChange={e => {
                    const nextProvider = providers.find(p => p.id === e.target.value);
                    // 换供应商时旧 modelId 多半不在新供应商名下，落到它的第一个模型；
                    // 服务端与电脑端都会校验 modelId 属不属于 provider，留着旧值必被拒。
                    const keep = nextProvider?.models.some(m => m.id === draft.modelId);
                    setDraft({
                      ...draft,
                      providerId: e.target.value,
                      modelId: keep ? draft.modelId : nextProvider?.models[0]?.id || '',
                    });
                  }}
                  className={inputClass}
                >
                  {!providers.some(p => p.id === draft.providerId) && (
                    <option value={draft.providerId}>{draft.providerId || '—'}</option>
                  )}
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('模型')}>
                <select
                  value={draft.modelId}
                  onChange={e => setDraft({ ...draft, modelId: e.target.value })}
                  className={inputClass}
                >
                  {!(provider?.models || []).some(m => m.id === draft.modelId) && (
                    <option value={draft.modelId}>{draft.modelId || '—'}</option>
                  )}
                  {(provider?.models || []).map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          <Field label={t('提示词')}>
            <textarea
              ref={promptRef}
              value={draft.systemPrompt}
              onChange={e => {
                setDraft({ ...draft, systemPrompt: e.target.value });
                autoSize();
              }}
              rows={3}
              className={`${inputClass} resize-none overflow-y-auto`}
              style={{ minHeight: '96px' }}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label={t('温度')}>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                max={2}
                value={draft.temperature}
                placeholder={t('跟随默认')}
                onChange={e => setDraft({ ...draft, temperature: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label={t('最大输出')}>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={draft.maxTokens}
                onChange={e => setDraft({ ...draft, maxTokens: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label={t('身份')}>
              <select
                value={draft.role}
                onChange={e => setDraft({ ...draft, role: e.target.value === 'ADMIN' ? 'ADMIN' : 'MEMBER' })}
                className={inputClass}
              >
                <option value="MEMBER">{t('普通成员')}</option>
                <option value="ADMIN">{t('管理员')}</option>
              </select>
            </Field>
            <Field label={t('指令方式')}>
              <select
                value={draft.commandMode}
                onChange={e => setDraft({ ...draft, commandMode: e.target.value === 'native' ? 'native' : 'text' })}
                className={inputClass}
              >
                <option value="text">{t('文本协议')}</option>
                <option value="native">{t('原生函数调用')}</option>
              </select>
            </Field>
          </div>

          <div className="space-y-2">
            <ToggleRow
              label={t('仅被 @ 时发言')}
              checked={draft.mentionOnly}
              onChange={v => setDraft({ ...draft, mentionOnly: v })}
            />
            <ToggleRow
              label={t('允许私讯')}
              checked={draft.enablePM}
              onChange={v => setDraft({ ...draft, enablePM: v })}
            />
          </div>

          {error && <div className="text-[11px] text-red-500">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <ActionButton
              tone="primary"
              className="flex-1"
              pending={isPending(pendingKey)}
              disabled={disabled || !patch}
              onClick={() => {
                if (!patch || !selectedId) return;
                const msg = validate(patch);
                setError(msg);
                if (msg) return;
                void runAction({
                  type: 'agent.update',
                  payload: { agentId: selectedId, patch },
                  key: pendingKey,
                  label: t('修改角色'),
                });
              }}
            >
              <Save size={15} /> {t('保存')}
            </ActionButton>
            {!patch && <span className="text-[11px] text-gray-400 shrink-0">{t('没有改动')}</span>}
          </div>
        </>
      )}
    </div>
  );
};

export default AgentEditPanel;
