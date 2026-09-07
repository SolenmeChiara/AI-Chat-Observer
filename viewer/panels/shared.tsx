// 侧边栏里几个面板共用的类型与小控件（PHONE_ACTIONS_PLAN.md §2.9）。
//
// 存在的理由只有一个：几个面板对「发一个动作 + 显示等待态」的需求完全一样，
// 各写一遍会有几份不一致的按钮尺寸与禁用逻辑。这里不放任何业务判断。
//
// 尺寸约定：所有可点元素高度 ≥ 44px（src/index.css 在 ≤640px 下也给 button 兜了同一条底），
// 输入类 16px 字号（iOS 聚焦时才不会自动放大页面）。
// 四期新增的 SidebarRow / SidebarSwitch 更狠：整行到边、≥52px——Sol 在真机上的原话是
// 「按键太小了 不如侧边栏」，卡片式的行留白会把命中区又缩回去。

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { ActionPayloadMap, ActionType } from '../../server/actionContract';
import type { ViewerLocale } from '../strings';

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

/** 面板都要的那几件东西 */
export interface PanelBaseProps {
  t: Translate;
  /**
   * 当前语言。面板里凡是「翻译片段 + 标点 + 变量」拼出来的句子都要看它：
   * 中文用「」和全角逗号句号，英文用引号、破折号和半角句点。
   * 不看的话英文界面会拼出 `The computer is on「xxx」，actions here…。` 这种东西。
   */
  lang: ViewerLocale;
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
      // sm 三期是 40px。四期一律抬到 44：Sol 在真机上够不着 40 的东西，
      // 「所有可点元素 ≥ 44×44」这条现在也管面板里的小按钮。
      size === 'sm' ? 'min-h-[44px] px-2.5 text-[12px]' : 'min-h-[44px] px-4 text-sm'
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

// ---------------------------------------------------------------------------
// 侧边栏专用的三个大件（四期）
// ---------------------------------------------------------------------------

/** 分区标题。英文下 uppercase 才像分区，中文原样。 */
export const SidebarSection: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
    {children}
  </div>
);

/**
 * 侧边栏的一行。全宽到边、最矮 52px。
 * 副标题用 break-words 不用 truncate：英文文案（"The computer is offline" 之类）
 * 宁可换行也不许被截掉；标题是会话名 / 角色名这类数据，才允许 truncate。
 *
 * `trailing` 是画在主按钮**里面**的装饰（›、转圈之类），`action` 是一颗真按钮，
 * 画在主按钮**外面**——button 套 button 是非法 HTML，浏览器会把内层拆出去，
 * 点击也就落不到该落的地方。两者用途不同，别互相替代。
 */
export const SidebarRow: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  /** 行尾的独立按钮（自己带 44×44 与 aria-label），与整行点击互不干扰 */
  action?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}> = ({ title, subtitle, icon, trailing, action, active, disabled, onClick, ariaLabel }) => {
  const body = (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-current={active ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`${action ? 'flex-1 min-w-0 pl-4 pr-1' : 'w-full px-4'} min-h-[52px] flex items-center gap-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
        active ? 'bg-emerald-50 dark:bg-emerald-900/25' : 'active:bg-gray-100 dark:active:bg-zinc-800'
      }`}
    >
      {icon !== undefined && (
        <span
          className={`shrink-0 w-5 flex items-center justify-center ${
            active ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'
          }`}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block text-[15px] leading-snug truncate ${
            active ? 'font-medium text-emerald-700 dark:text-emerald-300' : 'text-gray-900 dark:text-gray-100'
          }`}
        >
          {title}
        </span>
        {subtitle && (
          <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400 mt-0.5 break-words">
            {subtitle}
          </span>
        )}
      </span>
      {trailing !== undefined && (
        <span className="shrink-0 flex items-center gap-1.5 text-gray-300 dark:text-zinc-600">{trailing}</span>
      )}
    </button>
  );

  if (!action) return body;
  // 高亮铺满整行（含行尾按钮那一格），不然选中的那行右边会缺一块
  return (
    <div className={`flex items-stretch ${active ? 'bg-emerald-50 dark:bg-emerald-900/25' : ''}`}>
      {body}
      <span className="shrink-0 flex items-center pr-2">{action}</span>
    </div>
  );
};

/**
 * 侧边栏的开关行。和 ToggleRow 的区别只有一条：这个是全宽到边的行，不是卡片。
 * pending 时把转圈摆在开关左边而不是替掉开关——替掉的话正在等回执的那几秒
 * 看不出当前是开是关。
 */
export const SidebarSwitch: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  pending?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}> = ({ label, hint, checked, pending, disabled, onToggle }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled || pending}
    onClick={onToggle}
    className="w-full min-h-[52px] flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-40 active:bg-gray-100 dark:active:bg-zinc-800"
  >
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] leading-snug text-gray-900 dark:text-gray-100">{label}</span>
      {hint && (
        <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400 mt-0.5 break-words">{hint}</span>
      )}
    </span>
    {pending && <Loader2 size={15} className="shrink-0 animate-spin text-gray-400" />}
    <span
      className={`shrink-0 w-11 h-6 rounded-full p-0.5 flex transition-colors ${
        checked ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-zinc-600 justify-start'
      }`}
    >
      <span className="w-5 h-5 rounded-full bg-white shadow-sm" />
    </span>
  </button>
);
