// 侧边栏 · 会话区（四期）。
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

import React from 'react';
import { Loader2, Monitor, Smartphone } from 'lucide-react';
import type { ViewGroup, ViewSessionIndex } from '../viewerClient';
import { PanelHint, SidebarRow, type Translate } from './shared';

export interface SessionsPanelProps {
  t: Translate;
  groups: ViewGroup[];
  sessions: ViewSessionIndex[];
  /** 电脑端当前会话 */
  activeSessionId: string | null;
  /** 手机正在看的会话 */
  viewingSessionId: string | null;
  /** 电脑端不可达：行尾的显示器键禁用，整行照常可点 */
  disabled: boolean;
  /** 该行是否有 session.switch 在飞 */
  isPending: (key: string) => boolean;
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
  onPick,
  onSwitchDesktop,
}) => {
  const grouped = groups
    .map(g => ({ group: g, items: sessions.filter(s => s.groupId === g.id) }))
    .filter(entry => entry.items.length > 0);

  if (grouped.length === 0) {
    return <PanelHint>{t('还没有任何会话')}</PanelHint>;
  }

  return (
    <div>
      {grouped.map(({ group, items }) => (
        <div key={group.id}>
          <div className="px-4 pt-3 pb-1 text-[11px] text-gray-400 dark:text-gray-500 truncate">{group.name}</div>
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
      ))}
    </div>
  );
};

export default SessionsPanel;
