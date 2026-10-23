// 侧边栏 · 共同往事：查看 / 编辑电脑端当前群的跨会话记忆（ChatGroup.sharedMemory，GROUP_MEMORY_PLAN.md）。
//
// 写法照抄 ProfilesPanel：一份草稿 + 一份基线。group.memory.update 是整段覆盖写，
// 所以 bootstrap 刷新带来新原文（电脑端归档时自动提炼了一版）时，本地没有未保存改动才跟着更新，
// 有改动就保留草稿、提示「电脑端有新版本」，免得冲掉正在打的字。
//
// 这段内容只含公开对话的提炼（私讯、私人记忆从不进来），和群剧本同一级可见性。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { ACTION_LIMITS } from '../../server/actionContract';
import type { ViewGroup } from '../viewerClient';
import { ActionButton, Field, PanelHint, inputClass, type PanelBaseProps } from './shared';

export interface GroupMemoryPanelProps extends PanelBaseProps {
  /** 电脑端当前会话所在的群；null = 还不知道 / 电脑端没开会话 */
  group: ViewGroup | null;
}

const GroupMemoryPanel: React.FC<GroupMemoryPanelProps> = ({ t, lang, runAction, isPending, disabled, group }) => {
  const remote = group?.sharedMemory ?? '';
  const [draft, setDraft] = useState(remote);
  const [baseline, setBaseline] = useState(remote);
  const [error, setError] = useState('');
  const lastGroupIdRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const gid = group?.id ?? null;
    const switched = lastGroupIdRef.current !== gid;
    lastGroupIdRef.current = gid;
    const dirty = !switched && draftRef.current !== baselineRef.current;
    // 有未保存改动时基线不动：这样 remote !== baseline 才能表达「打开之后电脑端又出了新版本」，
    // 下面的 remoteMovedOn 提示才会亮。远端追上了草稿（例如刚保存成功）就视为干净。
    if (!dirty || remote === draftRef.current) {
      setBaseline(remote);
      setDraft(remote);
    }
    if (switched) setError('');
  }, [group?.id, remote]);

  const autoSize = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.55))}px`;
  }, []);

  useEffect(() => {
    autoSize();
  }, [autoSize, draft, group?.id]);

  if (!group) return <PanelHint>{t('电脑端还没打开会话')}</PanelHint>;

  const key = `group-memory:${group.id}`;
  const changed = draft !== baseline;
  // 草稿有改动、而电脑端那份在打开之后又变了：保存会覆盖掉电脑端的新版本，提示一句
  const remoteMovedOn = changed && remote !== baseline;

  const save = (text: string) => {
    if (text.length > ACTION_LIMITS.groupMemory) {
      setError(t('共同往事太长（上限 16000 字）'));
      return;
    }
    setError('');
    void runAction({
      type: 'group.memory.update',
      payload: { groupId: group.id, text },
      key,
      label: t('保存共同往事'),
    });
  };

  const updatedAt = group.sharedMemoryUpdatedAt
    ? new Date(group.sharedMemoryUpdatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <div className="pb-6 px-3 pt-3 space-y-3">
      <div className="text-[11px] leading-snug text-gray-400 dark:text-gray-500 break-words">
        {t('跨会话保留的群组记忆：每次归档时自动从公开对话提炼，也可以手动编辑。私讯不会进来。')}
      </div>

      <Field
        label={`${t('共同往事')} · ${group.name}`}
        hint={updatedAt ? `${t('最后更新')}${lang === 'zh' ? '：' : ': '}${updatedAt}` : undefined}
      >
        <textarea
          ref={areaRef}
          value={draft}
          placeholder={t('还没有共同往事。开启长期记忆后，每次归档会自动提炼。')}
          onChange={e => {
            setDraft(e.target.value);
            autoSize();
          }}
          rows={6}
          className={`${inputClass} resize-none overflow-y-auto`}
          style={{ minHeight: '160px' }}
        />
      </Field>

      {remoteMovedOn && <div className="text-[11px] text-amber-600 dark:text-amber-400">{t('电脑端有新版本，保存会覆盖它')}</div>}
      {error && <div className="text-[11px] text-red-500">{error}</div>}

      <div className="flex items-center gap-2 pt-1">
        <ActionButton
          tone="primary"
          className="flex-1"
          pending={isPending(key)}
          disabled={disabled || !changed}
          onClick={() => save(draft)}
        >
          <Save size={15} /> {t('保存')}
        </ActionButton>
        {changed && (
          <ActionButton onClick={() => { setDraft(remote); setBaseline(remote); }}>
            {t('还原')}
          </ActionButton>
        )}
        <ActionButton
          tone="danger"
          ariaLabel={t('清空')}
          disabled={disabled || (!remote && !draft)}
          pending={isPending(key)}
          onClick={() => {
            if (!window.confirm(t('确定清空本群的共同往事？'))) return;
            setDraft('');
            save('');
          }}
        >
          <Trash2 size={15} />
        </ActionButton>
      </div>
      {!changed && <div className="text-[11px] text-gray-400">{t('没有改动')}</div>}
    </div>
  );
};

export default GroupMemoryPanel;
