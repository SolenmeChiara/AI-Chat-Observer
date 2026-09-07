// 「管理」抽屉 · 成员面板（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 作用域是**电脑端当前会话所属的群**，不是手机正在看的那个会话（§2.1：会话级动作只作用于
// 电脑当前会话，否则服务端 409）。手机在看别的会话时顶部给一条提示 + 一键跳过去。

import React, { useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus, Pencil, UserMinus, Volume2 } from 'lucide-react';
import type { MuteInfo } from '../../types';
import type { ViewAgent, ViewGroup } from '../viewerClient';
import { ActionButton, PanelHint, inputClass, type PanelBaseProps, type Translate } from './shared';

export interface MembersPanelProps extends PanelBaseProps {
  /** 全量 agents（含非成员，底部「添加成员」要用） */
  agents: ViewAgent[];
  /** 电脑端当前会话所属的群 */
  group: ViewGroup | null;
  /** 电脑端当前会话 id；为空时所有会话级动作都不可用 */
  sessionId: string | null;
  mutedAgents: MuteInfo[];
  processingAgentIds: string[];
  onEditAgent: (agentId: string) => void;
  /** 手机在看别的会话时的提示 */
  scopeHint: { sessionName: string; onJump: () => void } | null;
}

/** 剩余时间的人话。muteUntil = 0 是永久禁言（types.ts MuteInfo 的约定）。 */
function formatRemaining(muteUntil: number, now: number, t: Translate): string {
  if (muteUntil === 0) return t('永久');
  const ms = muteUntil - now;
  if (ms <= 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('不到 1 分钟');
  if (min < 60) return `${min} ${t('分钟')}`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${t('小时')}`;
  return `${Math.floor(hours / 24)} ${t('天')}`;
}

const MembersPanel: React.FC<MembersPanelProps> = ({
  t,
  lang,
  runAction,
  isPending,
  disabled,
  agents,
  group,
  sessionId,
  mutedAgents,
  processingAgentIds,
  onEditAgent,
  scopeHint,
}) => {
  // 剩余时间要自己走：不刷新的话「剩余 1 分钟」会一直挂在那儿
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [addTarget, setAddTarget] = useState<string>('');

  // 两步确认的第二步别一直挂着：3 秒没点就退回「移出」
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  const members = useMemo<ViewAgent[]>(() => {
    if (!group) return [];
    return group.memberIds.map(id => agents.find(a => a.id === id)).filter((a): a is ViewAgent => !!a);
  }, [group, agents]);

  const outsiders = useMemo<ViewAgent[]>(() => {
    if (!group) return agents;
    const inGroup = new Set(group.memberIds);
    return agents.filter(a => !inGroup.has(a.id));
  }, [group, agents]);

  const muteOf = (agentId: string): MuteInfo | undefined =>
    mutedAgents.find(m => m.agentId === agentId && (m.muteUntil === 0 || m.muteUntil > now));

  const canAct = !disabled && !!sessionId;

  if (!group) {
    return <PanelHint>{t('这个群还没有成员')}</PanelHint>;
  }

  return (
    <div className="px-3 pb-6 pt-2">
      {scopeHint && (
        <div className="mb-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 px-3 pt-2 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
          {/* 标点跟着语言走：英文里塞「」和全角逗号是三期留下的洋泾浜 */}
          <div className="break-words">
            {lang === 'zh'
              ? `${t('电脑端当前在')}「${scopeHint.sessionName}」，${t('这里的操作都作用于那个会话')}。`
              : `${t('电脑端当前在')} “${scopeHint.sessionName}” — ${t('这里的操作都作用于那个会话')}.`}
          </div>
          {/* 44px 高，不是一行下划线小字：这条也算「可点元素」 */}
          <button
            type="button"
            onClick={scopeHint.onJump}
            className="min-h-[44px] px-2 -ml-2 -mt-1 underline underline-offset-2 font-medium"
          >
            {t('跳过去')}
          </button>
        </div>
      )}

      {members.length === 0 && <PanelHint>{t('这个群还没有成员')}</PanelHint>}

      <div className="space-y-2">
        {members.map(agent => {
          const mute = muteOf(agent.id);
          const remaining = mute ? formatRemaining(mute.muteUntil, now, t) : '';
          const busy = processingAgentIds.includes(agent.id);
          const isAdmin = String(agent.role) === 'ADMIN';
          return (
            <div
              key={agent.id}
              className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2.5"
            >
              <div className="flex items-center gap-2.5">
                <img src={agent.avatar} alt="" className="w-9 h-9 rounded-full object-contain shrink-0 bg-gray-100 dark:bg-zinc-800" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{agent.name}</span>
                    {isAdmin && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                        {t('管理员')}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                    {mute ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('禁言中')}
                        {remaining ? ` · ${t('剩余')} ${remaining}` : ''}
                      </span>
                    ) : busy ? (
                      <span className="text-blue-500">{t('正在生成')}…</span>
                    ) : (
                      agent.modelId || t('普通成员')
                    )}
                  </div>
                </div>
              </div>

              {/* 两行固定分工：上行是「对这个人做什么」，下行只管禁言。
                  挤在一行里会折行成「永久」孤零零占一行的样子（第一轮截图就是这么翻车的）。 */}
              <div className="mt-2 flex items-center gap-1.5">
                <ActionButton
                  size="sm"
                  onClick={() =>
                    void runAction({
                      type: 'agent.trigger',
                      payload: { agentId: agent.id },
                      sessionId: sessionId || undefined,
                      key: `trigger:${agent.id}`,
                      label: t('点名发言'),
                    })
                  }
                  pending={isPending(`trigger:${agent.id}`)}
                  disabled={!canAct}
                >
                  <MessageSquarePlus size={13} /> {t('发言')}
                </ActionButton>

                <ActionButton size="sm" onClick={() => onEditAgent(agent.id)} disabled={disabled}>
                  <Pencil size={13} /> {t('编辑')}
                </ActionButton>

                <ActionButton
                  size="sm"
                  tone="danger"
                  className="ml-auto"
                  onClick={() => {
                    if (confirmRemove !== agent.id) {
                      setConfirmRemove(agent.id);
                      return;
                    }
                    setConfirmRemove(null);
                    void runAction({
                      type: 'group.member.remove',
                      payload: { agentId: agent.id },
                      sessionId: sessionId || undefined,
                      key: `remove:${agent.id}`,
                      label: t('移出成员'),
                    });
                  }}
                  pending={isPending(`remove:${agent.id}`)}
                  disabled={!canAct}
                >
                  <UserMinus size={13} />
                  {confirmRemove === agent.id ? t('再点一次确认') : t('移出')}
                </ActionButton>
              </div>

              <div className="mt-1.5 flex items-center gap-1.5">
                {/* 纯标签，不给图标：第二轮截图里带图标的它看着像一颗禁用的按钮 */}
                <span className="shrink-0 text-[11px] text-gray-400 w-8">{t('禁言')}</span>
                {mute ? (
                  <ActionButton
                    size="sm"
                    onClick={() =>
                      void runAction({
                        type: 'agent.unmute',
                        payload: { agentId: agent.id },
                        sessionId: sessionId || undefined,
                        key: `mute:${agent.id}`,
                        label: t('解禁'),
                      })
                    }
                    pending={isPending(`mute:${agent.id}`)}
                    disabled={!canAct}
                  >
                    <Volume2 size={13} /> {t('解禁')}
                  </ActionButton>
                ) : (
                  ([
                    [15, t('15 分钟')],
                    [60, t('1 小时')],
                    [0, t('永久')],
                  ] as Array<[number, string]>).map(([minutes, label]) => (
                    <ActionButton
                      key={minutes}
                      size="sm"
                      onClick={() =>
                        void runAction({
                          type: 'agent.mute',
                          payload: { agentId: agent.id, durationMinutes: minutes },
                          sessionId: sessionId || undefined,
                          key: `mute:${agent.id}`,
                          label: t('禁言'),
                        })
                      }
                      pending={isPending(`mute:${agent.id}`)}
                      disabled={!canAct}
                    >
                      {label}
                    </ActionButton>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 添加成员 */}
      <div className="mt-4 pt-3 border-t border-gray-100 dark:border-zinc-800">
        <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">{t('添加成员')}</div>
        {outsiders.length === 0 ? (
          <div className="text-[12px] text-gray-400 dark:text-gray-500">{t('没有可添加的角色')}</div>
        ) : (
          <div className="flex gap-2">
            <select
              value={addTarget}
              onChange={e => setAddTarget(e.target.value)}
              aria-label={t('添加成员')}
              disabled={!canAct}
              className={`${inputClass} flex-1 min-w-0`}
            >
              <option value="">—</option>
              {outsiders.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <ActionButton
              tone="primary"
              onClick={() => {
                if (!addTarget) return;
                const target = addTarget;
                setAddTarget('');
                void runAction({
                  type: 'group.member.add',
                  payload: { agentId: target },
                  sessionId: sessionId || undefined,
                  key: 'add-member',
                  label: t('添加成员'),
                });
              }}
              pending={isPending('add-member')}
              disabled={!canAct || !addTarget}
            >
              {t('添加成员')}
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  );
};

export default MembersPanel;
