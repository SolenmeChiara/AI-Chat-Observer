// 「管理」抽屉 · 新建角色（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 只有五个字段：供应商 / 模型 / 名字 / 提示词 / 是否加入当前群。
// 别的（头像、颜色、搜索、TTS）都留给电脑端——手机上是遥控器，不是完整的编辑器。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { ACTION_LIMITS } from '../../server/actionContract';
import type { ViewProvider } from '../viewerClient';
import { ActionButton, Field, PanelHint, ToggleRow, inputClass, type PanelBaseProps } from './shared';

export interface AgentCreatePanelProps extends PanelBaseProps {
  providers: ViewProvider[];
  /** 电脑端当前会话；为空时「加入当前群」不可用（group.member.add 是会话级动作） */
  sessionId: string | null;
  /** 创建成功后由外层调用，用来把面板切回成员列表 */
  onCreated?: () => void;
}

const AgentCreatePanel: React.FC<AgentCreatePanelProps> = ({
  t,
  runAction,
  isPending,
  disabled,
  providers,
  sessionId,
  onCreated,
}) => {
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [joinActiveGroup, setJoinActiveGroup] = useState(true);
  const [error, setError] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // 供应商列表到位后补一个默认值，省得用户先点两下下拉才能开始
  useEffect(() => {
    if (providerId || providers.length === 0) return;
    setProviderId(providers[0].id);
    setModelId(providers[0].models[0]?.id || '');
  }, [providers, providerId]);

  const provider = useMemo(() => providers.find(p => p.id === providerId) || null, [providers, providerId]);

  const autoSize = useCallback(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, []);

  if (providers.length === 0) {
    return (
      <PanelHint>
        {t('没有可用的供应商')}
        <br />
        {t('这台电脑还没配供应商，或者服务端版本较旧')}
      </PanelHint>
    );
  }

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length > ACTION_LIMITS.name) {
      setError(t('名字太长（上限 100 字）'));
      return;
    }
    if (systemPrompt.length > ACTION_LIMITS.systemPrompt) {
      setError(t('提示词太长（上限 64000 字）'));
      return;
    }
    if (!providerId || !modelId) {
      setError(`${t('供应商')} / ${t('模型')}`);
      return;
    }
    setError('');
    void runAction({
      type: 'agent.create',
      payload: {
        providerId,
        modelId,
        // 名字与提示词留空就不发，让电脑端用它自己那套默认值构造
        ...(trimmed ? { name: trimmed } : {}),
        ...(systemPrompt.trim() ? { systemPrompt } : {}),
        joinActiveGroup: joinActiveGroup && !!sessionId,
      },
      key: 'agent-create',
      label: t('新建角色'),
    }).then(accepted => {
      if (!accepted) return;
      // 202 就清空表单：结果要 8 秒内才回得来，让人对着已提交的内容干等更难受。
      setName('');
      setSystemPrompt('');
      onCreated?.();
    });
  };

  return (
    <div className="px-3 pb-6 pt-2 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('供应商')}>
          <select
            value={providerId}
            onChange={e => {
              const next = providers.find(p => p.id === e.target.value);
              setProviderId(e.target.value);
              setModelId(next?.models[0]?.id || '');
            }}
            className={inputClass}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('模型')}>
          <select value={modelId} onChange={e => setModelId(e.target.value)} className={inputClass}>
            {(provider?.models || []).length === 0 && <option value="">—</option>}
            {(provider?.models || []).map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={t('名字')}>
        <input
          type="text"
          value={name}
          maxLength={ACTION_LIMITS.name}
          onChange={e => setName(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label={t('提示词')} hint={t('留空则用默认提示词')}>
        <textarea
          ref={promptRef}
          value={systemPrompt}
          onChange={e => {
            setSystemPrompt(e.target.value);
            autoSize();
          }}
          rows={3}
          className={`${inputClass} resize-none overflow-y-auto`}
          style={{ minHeight: '96px' }}
        />
      </Field>

      <ToggleRow
        label={t('加入当前群')}
        checked={joinActiveGroup && !!sessionId}
        disabled={!sessionId}
        onChange={setJoinActiveGroup}
      />

      {error && <div className="text-[11px] text-red-500">{error}</div>}

      <ActionButton
        tone="primary"
        className="w-full"
        pending={isPending('agent-create')}
        disabled={disabled || !modelId}
        onClick={submit}
      >
        <Plus size={15} /> {t('创建')}
      </ActionButton>
    </div>
  );
};

export default AgentCreatePanel;
