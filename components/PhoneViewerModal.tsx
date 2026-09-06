// 「手机观看」弹窗：把服务端算好的访问入口（Tailscale / 局域网）连同二维码摊开给 Sol 扫。
//
// 数据全部来自 GET /api/live/lan-info（契约见 PHONE_VIEWER_PLAN §3.2）。这个接口只对
// 回环开放，所以二维码只可能出现在电脑本机的这个面板里，扫码之外没有第二条拿到 token 的路。
//
// 三种「没得看」的情况要分清楚，否则 Sol 只会看到一个含糊的报错：
//   1. 接口 404 / 不是 JSON → 服务端还没升级到带 /api/live 的版本
//   2. enabled=false      → 服务端在跑，但只监听回环，得用 npm run dev:lan 起
//   3. entries 为空        → 开了，但一个可用地址都没找到（没连 Tailscale 又没有局域网网卡）
import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Smartphone, Copy, Check, RefreshCw, ShieldAlert } from 'lucide-react';
import { useT } from '../i18n';

type EntryKind = 'tailscale' | 'tailscale-serve' | 'lan';

interface LanEntry {
  kind: EntryKind;
  url: string;
  qrSvg: string;
  note?: string;
}

interface LanInfo {
  enabled: boolean;
  port: number;
  token: string | null;
  entries: LanEntry[];
}

// kind → 显示用的标签 key（i18n 的 key 就是中文文案本身）
const KIND_LABEL: Record<EntryKind, string> = {
  'tailscale': 'Tailscale 直连',
  'tailscale-serve': 'Tailscale HTTPS（需 tailscale serve）',
  'lan': '局域网',
};

// Tailscale 是推荐通路，标签给个更醒目的底色；局域网是退路，弱化
const KIND_BADGE: Record<EntryKind, string> = {
  'tailscale': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'tailscale-serve': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'lan': 'bg-gray-200 text-gray-600 dark:bg-zinc-700 dark:text-gray-300',
};

const PhoneViewerModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  const [state, setState] = useState<'loading' | 'ready' | 'unsupported'>('loading');
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/live/lan-info', { headers: { 'Accept': 'application/json' } });
      // 服务端没升级时 Vite 会给 404；某些情况下 spa fallback 还会回一份 index.html，
      // 所以除了状态码还要看 content-type，别把 HTML 塞进 JSON.parse
      if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) {
        setState('unsupported');
        return;
      }
      const data = await res.json() as LanInfo;
      setInfo({
        enabled: !!data.enabled,
        port: data.port,
        token: data.token ?? null,
        entries: Array.isArray(data.entries) ? data.entries : [],
      });
      setState('ready');
    } catch (err) {
      console.warn('[live] 获取 lan-info 失败', err);
      setState('unsupported');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Esc 关闭，跟侧栏里其它浮层的手感保持一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl(prev => (prev === url ? null : prev)), 1800);
    } catch {
      alert(t('复制失败，请手动选中地址'));
    }
  };

  const renderBody = () => {
    if (state === 'loading') {
      return (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500 dark:text-gray-400">
          <RefreshCw size={16} className="animate-spin" />
          {t('正在获取访问地址...')}
        </div>
      );
    }

    if (state === 'unsupported') {
      return (
        <div className="py-6 text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">{t('服务端未升级')}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t('当前版本的本地服务还没有 /api/live 接口，更新后重启即可使用。')}
          </p>
          <button
            onClick={() => void load()}
            className="px-4 py-2 border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-200 rounded-lg text-xs font-medium hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            {t('重试')}
          </button>
        </div>
      );
    }

    if (!info?.enabled) {
      return (
        <div className="py-6">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">{t('还没开放局域网')}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            {t('当前只监听本机。用下面的命令重新启动，再回来打开这个面板：')}
          </p>
          <code className="block px-3 py-2 rounded-lg bg-gray-100 dark:bg-zinc-800 text-xs font-mono text-gray-800 dark:text-gray-200 select-all">
            npm run dev:lan
          </code>
        </div>
      );
    }

    if (info.entries.length === 0) {
      return (
        <div className="py-6 text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">{t('没找到可用的网络地址')}</p>
          <button
            onClick={() => void load()}
            className="mt-2 px-4 py-2 border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-200 rounded-lg text-xs font-medium hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            {t('重试')}
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('手机扫码，或直接在手机浏览器里打开下面的地址。')}
        </p>

        {info.entries.map(entry => (
          <div key={entry.url} className="p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800/60">
            <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium mb-2 ${KIND_BADGE[entry.kind] || KIND_BADGE.lan}`}>
              {t(KIND_LABEL[entry.kind] || entry.kind)}
            </span>

            {/* 二维码来自本机服务端自己生成的 SVG 字符串，直接内联 */}
            {entry.qrSvg && entry.qrSvg.trim().startsWith('<svg') && (
              <div
                className="w-40 h-40 mx-auto mb-2 bg-white p-1.5 rounded-lg [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: entry.qrSvg }}
              />
            )}

            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-[11px] font-mono text-gray-700 dark:text-gray-300 break-all select-all">
                {entry.url}
              </code>
              <button
                onClick={() => void handleCopy(entry.url)}
                title={t('复制')}
                className="shrink-0 p-2 rounded-lg border border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
              >
                {copiedUrl === entry.url ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>

            {entry.note && (
              <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 break-all">{entry.note}</p>
            )}
          </div>
        ))}

        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60">
          <p className="flex gap-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" />
            <span>
              {t('推荐用 Tailscale：只有你自己的设备能连上，且全程加密；局域网 IP 是退路，别在公共 WiFi 用')}
            </span>
          </p>
          <p className="mt-2 text-[11px] text-amber-800/80 dark:text-amber-300/80">
            {t('想换一把钥匙：删掉 data/lan-token.txt 再重启。')}
          </p>
        </div>
      </div>
    );
  };

  // 侧栏本身带 transform + overflow-hidden，fixed 子元素会被它当成包含块并裁掉，
  // 所以挂到 body 上（portal 不影响 React 树，useT 的 context 照样拿得到）
  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm max-h-[85vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-700">
          <h3 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Smartphone size={16} /> {t('手机观看')}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{renderBody()}</div>
      </div>
    </div>,
    document.body
  );
};

export default PhoneViewerModal;
