// 「管理」抽屉里四个面板共用的类型与小控件（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 存在的理由只有一个：四个面板对「发一个动作 + 显示等待态」的需求完全一样，
// 各写一遍会有四份不一致的按钮尺寸与禁用逻辑。这里不放任何业务判断。
//
// 尺寸约定：所有可点元素高度 ≥ 44px（src/index.css 在 ≤640px 下也给 button 兜了同一条底），
// 输入类 16px 字号（iOS 聚焦时才不会自动放大页面）。

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { ActionPayloadMap, ActionType } from '../../server/actionContract';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface RunActionOptions<T extends ActionType> {
  type: T;
  payload: ActionPayloadMap[T];
  /** 会话级动作必填；agent.update / agent.create 不带 */
  sessionId?: string;
  /** 按钮维度的等待态标识（如 `mute:a3`）。同一个 key 同时只允许一个动作在飞。 */
  key: string;
  /** toast 前缀，用动作名（如「禁言」） */
  label: string;
}

/** 发一个动作。resolve(true) 只代表服务端 202 收下了，成败仍要等 action-result。 */
export type RunAction = <T extends ActionType>(opts: RunActionOptions<T>) => Promise<boolean>;

export type Translate = (key: string) => string;

/** 四个面板都要的那几件东西 */
export interface PanelBaseProps {
  t: Translate;
  runAction: RunAction;
  /** 该 key 是否有动作在飞 */
  isPending: (key: string) => boolean;
  /** 电脑端不可达时整块面板只读 */
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// 小控件
// ---------------------------------------------------------------------------

export const inputClass =
  'w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 ' +
  'px-3 py-2.5 text-[16px] leading-snug text-gray-900 dark:text-gray-100 placeholder-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600 disabled:opacity-50';

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <label className="block">
    <span className="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">{label}</span>
    {children}
    {hint && <span className="block text-[10px] text-gray-400 dark:text-gray-500 mt-1">{hint}</span>}
  </label>
);

/**
 * 开关行。整行可点（44px 高），不用原生 checkbox：
 * 原生的在手机上只有 ~20px，指头点不中。
 */
export const ToggleRow: React.FC<{
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}> = ({ label, checked, disabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="w-full min-h-[44px] flex items-center justify-between gap-3 px-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 disabled:opacity-50"
  >
    <span className="text-sm text-gray-700 dark:text-gray-200 text-left">{label}</span>
    <span
      className={`shrink-0 w-10 h-6 rounded-full p-0.5 flex transition-colors ${
        checked ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-zinc-600 justify-start'
      }`}
    >
      <span className="w-5 h-5 rounded-full bg-white shadow-sm" />
    </span>
  </button>
);

type Tone = 'primary' | 'plain' | 'danger';

const toneClass: Record<Tone, string> = {
  primary: 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-transparent',
  plain:
    'bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-zinc-700',
  danger: 'bg-white dark:bg-zinc-800 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900',
};

/** 带等待态的按钮。pending 时转圈并禁点，尺寸不变（免得一行按钮跳来跳去）。 */
export const ActionButton: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  pending?: boolean;
  disabled?: boolean;
  tone?: Tone;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}> = ({ onClick, children, pending, disabled, tone = 'plain', size = 'md', className = '', ariaLabel }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    disabled={disabled || pending}
    onClick={onClick}
    className={`inline-flex items-center justify-center gap-1.5 rounded-xl border font-medium transition-colors disabled:opacity-40 ${
      size === 'sm' ? 'min-h-[40px] px-2.5 text-[12px]' : 'min-h-[44px] px-4 text-sm'
    } ${toneClass[tone]} ${className}`}
  >
    {pending && <Loader2 size={13} className="animate-spin shrink-0" />}
    {children}
  </button>
);

export const PanelHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-center text-[13px] text-gray-400 dark:text-gray-500 py-10 px-6 leading-relaxed">
    {children}
  </div>
);
