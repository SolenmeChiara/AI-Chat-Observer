// 「管理」抽屉 · 会话列表（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 这里的「切过去」是把**电脑端**切过去（`session.switch`），不是手机本地换个视图——
// 头部那个下拉才是本地切换。两件事不一样：远程切会让电脑端停掉自动播放（与电脑上手点一致）。

import React from 'react';
import { CornerDownRight, Monitor } from 'lucide-react';
import type { ViewGroup, ViewSessionIndex } from '../viewerClient';
import { ActionButton, PanelHint, type PanelBaseProps } from './shared';

export interface SessionsPanelProps extends PanelBaseProps {
  groups: ViewGroup[];
  sessions: ViewSessionIndex[];
  /** 电脑端当前会话 */
  activeSessionId: string | null;
  /** 手机正在看的会话 */
  viewingSessionId: string | null;
}

const SessionsPanel: React.FC<SessionsPanelProps> = ({
  t,
  runAction,
  isPending,
  disabled,
  groups,
  sessions,
  activeSessionId,
  viewingSessionId,
}) => {
  const grouped = groups
    .map(g => ({ group: g, items: sessions.filter(s => s.groupId === g.id) }))
    .filter(entry => entry.items.length > 0);

  if (grouped.length === 0) {
    return <PanelHint>{t('还没有任何会话')}</PanelHint>;
  }

  return (
    <div className="px-3 pb-6 pt-2 space-y-4">
      {grouped.map(({ group, items }) => (
        <div key={group.id}>
          <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500 mb-1.5 px-0.5">{group.name}</div>
          <div className="space-y-1.5">
            {items.map(s => {
              const isActive = s.id === activeSessionId;
              const isViewing = s.id === viewingSessionId;
              return (
                <div
                  key={s.id}
                  className={`rounded-2xl border p-2.5 flex items-center gap-2 ${
                    isActive
                      ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20'
                      : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {s.name || t('未命名会话')}
                    </div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5 flex-wrap">
                      <span>
                        {s.messageCount} {t('条')}
                      </span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <Monitor size={11} /> {t('电脑端正在看')}
                        </span>
                      )}
                      {isViewing && !isActive && <span>· {t('正在看')}</span>}
                    </div>
                  </div>
                  <ActionButton
                    size="sm"
                    tone={isActive ? 'plain' : 'primary'}
                    pending={isPending(`switch:${s.id}`)}
                    disabled={disabled || isActive}
                    onClick={() =>
                      void runAction({
                        type: 'session.switch',
                        payload: {},
                        sessionId: s.id,
                        key: `switch:${s.id}`,
                        label: t('切换会话'),
                      })
                    }
                  >
                    <CornerDownRight size={13} /> {t('切过去')}
                  </ActionButton>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default SessionsPanel;
