// 侧边栏 · 会话区（四期；五期加了新建群 / 新建对话）。
//
// 三期这里是抽屉里的一叠卡片，每张卡片右端挂一颗 40px 的「切过去」小按钮。
// Sol 在 iPhone 上的原话是「按键太小了 不如侧边栏」，所以四期把整行变成按钮：
// 全宽到边、≥52px、名字与状态各占一行。
//
// 两件事分成两个命中区，别混：
//   · 点**整行** = 手机自己去看这个会话（本地换视图、关「跟随电脑」），不惊动电脑，
//     在线离线一个样——这是二期头部下拉的语义，翻历史用的。
//   · 点**行尾那颗 44×44 的显示器键** = 让电脑端也切过去（`session.switch`）。
//     它才会停掉电脑的自动播放，成功后由 settleAction 把「跟随电脑」打开并收起侧边栏。
// 电脑端当前那一行的显示器键是禁用态（已经在那儿了）；电脑不可达时也禁用。
//
// 五期两个新入口（PHONE_ACTIONS_PLAN §2.3 `group.create` / `session.create`）：
//   · 每个群标题行右侧一颗 44×44 的「+」→ 在这个群新建对话
//   · 整个会话区末尾一行「新建群组」
// 两者都是**就地展开**一个小表单（名字 + 创建 / 取消），不推子页：新建对话是个一步操作，
// 为它跳一层再跳回来比填名字本身还费事。同一时刻只展开一个表单。
// 名字留空就不发 `name`，电脑端用它自己的默认名（「对话 N」/「群组 N」）——输入框的
// placeholder 就是按手机本地数据算出来的那个 N，只是预览：真正的名字由电脑端按它的语言生成。

import React, { useState } from 'react';
import { Loader2, Monitor, Plus, Smartphone } from 'lucide-react';
import { ACTION_LIMITS } from '../../server/actionContract';
import type { ViewGroup, ViewSessionIndex } from '../viewerClient';
import {
  ActionButton,
  PanelHint,
  SidebarRow,
  inputClass,
  type RunAction,
  type Translate,
} from './shared';

/** 「新建群组」的等待态键。整个界面只有一个，不带参数。 */
export const GROUP_CREATE_KEY = 'group-create';
/** 「在这个群新建对话」的等待态键。按群分，两个群可以各自在飞。 */
export const sessionCreateKey = (groupId: string) => `session-create:${groupId}`;

/** 当前展开着的那个表单。null = 都收着。 */
type CreateForm = { kind: 'group' } | { kind: 'session'; groupId: string };

export interface SessionsPanelProps {
  t: Translate;
  groups: ViewGroup[];
  sessions: ViewSessionIndex[];
  /** 电脑端当前会话 */
  activeSessionId: string | null;
  /** 手机正在看的会话 */
  viewingSessionId: string | null;
  /** 电脑端不可达：行尾的显示器键与两个新建入口禁用，整行照常可点 */
  disabled: boolean;
  /** 该行是否有 session.switch 在飞 */
  isPending: (key: string) => boolean;
  /** 发动作。新建群 / 新建对话直接在这儿发，不再绕一层回调。 */
  runAction: RunAction;
  /** 点整行：手机本地看这个会话 */
  onPick: (sessionId: string) => void;
  /** 点行尾显示器键：让电脑端切过去 */
  onSwitchDesktop: (sessionId: string) => void;
}

const SessionsPanel: React.FC<SessionsPanelProps> = ({
  t,
  groups,
  sessions,
  activeSessionId,
  viewingSessionId,
  disabled,
  isPending,
  runAction,
  onPick,
  onSwitchDesktop,
}) => {
  const [form, setForm] = useState<CreateForm | null>(null);
  const [draftName, setDraftName] = useState('');

  const openForm = (next: CreateForm) => {
    setForm(next);
    setDraftName('');
  };
  const closeForm = () => {
    setForm(null);
    setDraftName('');
  };

  // 成功时 settleAction 会收起整个侧边栏，侧边栏一卸载这里的 state 全部归零，
  // 所以不用手动收表单；失败时表单留着、字还在，改完直接再点一次「创建」。
  const submit = () => {
    if (!form) return;
    const name = draftName.trim();
    if (form.kind === 'group') {
      void runAction({
        type: 'group.create',
        payload: name ? { name } : {},
        key: GROUP_CREATE_KEY,
        label: t('新建群组'),
      });
    } else {
      void runAction({
        type: 'session.create',
        payload: name ? { groupId: form.groupId, name } : { groupId: form.groupId },
        key: sessionCreateKey(form.groupId),
        label: t('新建对话'),
      });
    }
  };

  const renderForm = (placeholder: string, pendingKey: string) => {
    const pending = isPending(pendingKey);
    return (
      <div className="px-4 py-3 bg-gray-50 dark:bg-zinc-800/40 border-y border-gray-100 dark:border-zinc-800">
        <input
          type="text"
          value={draftName}
          maxLength={ACTION_LIMITS.name}
          placeholder={placeholder}
          onChange={e => setDraftName(e.target.value)}
          className={inputClass}
        />
        <div className="flex gap-2 mt-2">
          <ActionButton
            tone="primary"
            className="flex-1"
            pending={pending}
            disabled={disabled}
            onClick={submit}
          >
            {t('创建')}
          </ActionButton>
          <ActionButton tone="plain" className="flex-1" onClick={closeForm}>
            {t('取消')}
          </ActionButton>
        </div>
      </div>
    );
  };

  // 四期这里过滤掉了没有会话的群（`items.length > 0`）。五期不能再滤：每个群标题行
  // 都挂着「+」，滤掉的话空群就再也建不出会话来了。
  const grouped = groups.map(g => ({ group: g, items: sessions.filter(s => s.groupId === g.id) }));

  return (
    <div>
      {grouped.length === 0 && <PanelHint>{t('还没有任何会话')}</PanelHint>}

      {grouped.map(({ group, items }) => {
        const createKey = sessionCreateKey(group.id);
        const creating = isPending(createKey);
        return (
          <div key={group.id}>
            <div className="flex items-center gap-1 pl-4 pr-2 pt-1.5">
              <span className="flex-1 min-w-0 truncate text-[11px] text-gray-400 dark:text-gray-500">
                {group.name}
              </span>
              <button
                type="button"
                aria-label={t('在这个群新建对话')}
                title={t('在这个群新建对话')}
                disabled={disabled || creating}
                onClick={() => openForm({ kind: 'session', groupId: group.id })}
                className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center text-gray-400 dark:text-gray-500 active:bg-gray-100 dark:active:bg-zinc-800 disabled:opacity-40"
              >
                <Plus size={18} />
              </button>
            </div>

            {form?.kind === 'session' && form.groupId === group.id &&
              renderForm(`${t('对话')} ${items.length + 1}`, createKey)}

            {items.map(s => {
              const isActive = s.id === activeSessionId;
              const isViewing = s.id === viewingSessionId;
              const pending = isPending(`switch:${s.id}`);
              const marks: string[] = [`${s.messageCount} ${t('条')}`];
              if (isActive) marks.push(t('电脑端正在看'));
              else if (isViewing) marks.push(t('正在看'));
              return (
                <SidebarRow
                  key={s.id}
                  active={isActive}
                  onClick={() => onPick(s.id)}
                  title={s.name || t('未命名会话')}
                  subtitle={marks.join(' · ')}
                  icon={isViewing ? <Smartphone size={16} /> : <span className="w-4" />}
                  action={
                    <button
                      type="button"
                      aria-label={t('让电脑切到这个会话')}
                      title={t('让电脑切到这个会话')}
                      disabled={disabled || isActive || pending}
                      onClick={() => onSwitchDesktop(s.id)}
                      className={`w-11 h-11 rounded-xl flex items-center justify-center transition-colors disabled:opacity-40 ${
                        isActive
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-gray-400 dark:text-gray-500 active:bg-gray-100 dark:active:bg-zinc-800'
                      }`}
                    >
                      {pending ? <Loader2 size={18} className="animate-spin" /> : <Monitor size={18} />}
                    </button>
                  }
                />
              );
            })}
          </div>
        );
      })}

      <SidebarRow
        icon={<Plus size={16} />}
        title={t('新建群组')}
        disabled={disabled || isPending(GROUP_CREATE_KEY)}
        onClick={() => openForm({ kind: 'group' })}
      />
      {form?.kind === 'group' && renderForm(`${t('群组')} ${groups.length + 1}`, GROUP_CREATE_KEY)}
    </div>
  );
};

export default SessionsPanel;
