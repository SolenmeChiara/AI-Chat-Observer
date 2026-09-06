
import React, { useState, useMemo, useEffect } from 'react';
import { Message, Agent, AgentRole } from '../types';
import { USER_ID } from '../constants';
import { useT } from '../i18n';
import { Reply, AtSign, FileImage, BrainCircuit, FileText, File, Shield, Search, ChevronDown, ChevronRight, Volume2, Square, Trash2, X } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true, async: false });

// 渲染实际用到的 settings 字段。放宽成结构类型而不是 GlobalSettings，
// 是为了让手机观众端（viewer/ViewerApp.tsx）能直接把 bootstrap 里的裁剪版
// settings 传进来——那边的 userProfiles 只有 id/name/avatar，没有 persona。
// GlobalSettings 依然可赋值给它，App.tsx 侧零改动。
export interface ChatBubbleUserProfile {
  userProfiles?: Array<{ id: string; name: string; avatar: string }>;
  userName?: string;
  userAvatar?: string;
  expandAllReasoning?: boolean;
}

interface ChatBubbleProps {
  message: Message;
  sender?: Agent;
  allAgents?: Agent[]; // All agents for @mention matching
  userProfile?: ChatBubbleUserProfile; // Pass settings to get user name/avatar
  replyToMessage?: Message;
  onReply?: (message: Message) => void;
  onMention?: (name: string) => void;
  isStreaming?: boolean; // If true, skip markdown rendering for performance
  onDelete?: (messageId: string) => void; // Callback to delete this message
  onPlayTTS?: (message: Message) => void; // Callback to play TTS for this message
  onStopTTS?: () => void; // Callback to stop TTS
  isTTSPlaying?: boolean; // Is TTS currently playing this message
  currentPlayingMessageId?: string; // ID of the message currently being played
  readOnly?: boolean; // 只读观看（手机观众端）：不挂 hover、不渲染操作栏、附件按 http URL 直出
  // 手机紧凑模式：时间戳并进名字行、气泡铺满列宽、行间距收紧。
  // 只有 viewer 传 true；为 false / 缺省时渲染结果与电脑端历史版本逐字一致。
  compact?: boolean;
  // 本条与上一条是同一发送者的连续消息（分组规则由调用方算，这里只负责渲染）：
  // 不重复画头像和名字，间距贴紧上一条。只在 compact 下生效。
  continued?: boolean;
}

const ChatBubble: React.FC<ChatBubbleProps> = ({ message, sender, allAgents, userProfile, replyToMessage, onReply, onMention, onDelete, isStreaming, onPlayTTS, onStopTTS, isTTSPlaying, currentPlayingMessageId, readOnly, compact, continued }) => {
  const t = useT();
  const [isHovered, setIsHovered] = useState(false);
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxBlobUrl, setLightboxBlobUrl] = useState<string | null>(null);

  // Convert to blob URL when lightbox opens (for drag support)
  // readOnly（手机观众端）下附件 content 是 http URL 不是 data:，没有转 blob 的必要，直接跳过。
  useEffect(() => {
    if (readOnly || !lightboxSrc?.startsWith('data:')) { setLightboxBlobUrl(null); return; }
    let cancelled = false;
    fetch(lightboxSrc).then(r => r.blob()).then(blob => {
      if (!cancelled) setLightboxBlobUrl(URL.createObjectURL(blob));
    }).catch(() => {});
    return () => { cancelled = true; if (lightboxBlobUrl) URL.revokeObjectURL(lightboxBlobUrl); };
  }, [lightboxSrc]);

  const isThisMessagePlaying = currentPlayingMessageId === message.id;

  // 外层纵向间距。compact 下改用 margin-top 驱动：连续消息贴紧上一条，新的一组之间留一档。
  // 用 mt 而不是 mb，是为了让「组间距」跟着组的首条走——调用方只需要给列表首条一个 mt-0
  // 就不会在列表顶端多出一截空白（viewer/ViewerApp.tsx 的 [&>*:first-child]:mt-0）。
  // 非 compact 一律还是 HEAD 的 mb-6，电脑端观感零变化。
  const outerSpacing = compact ? (continued ? 'mt-1.5' : 'mt-4') : 'mb-6';
  /** compact 下的时间戳文本，跟在名字后面 */
  const clockText = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 1. System Message Style
  if (message.isSystem) {
    return (
      <div className={`flex w-full ${outerSpacing} justify-center group`}>
        <span className="text-xs bg-gray-100 dark:bg-zinc-900 text-gray-500 dark:text-gray-400 px-3 py-1 rounded-full border border-gray-200 dark:border-zinc-700">
           {message.text}
        </span>
        {onDelete && (
          <button onClick={() => onDelete(message.id)} className="ml-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-0.5" title={t("删除消息")}>
            <Trash2 size={10} />
          </button>
        )}
      </div>
    );
  }

  // 2. Search Result Style (Collapsible)
  if (message.isSearchResult) {
    return (
      <div className={`flex w-full ${outerSpacing} justify-start`}>
        {sender && (
          <div className="flex flex-col items-center mr-3 space-y-1">
            <img
              src={sender.avatar}
              alt="Avatar"
              className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-700 shadow-sm object-contain bg-white p-0.5"
            />
          </div>
        )}
        <div className="max-w-[85%] sm:max-w-[70%] flex flex-col items-start">
          <div className="flex items-center gap-2 mb-1 ml-1">
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1">
              <Search size={12} className="text-blue-500" />
              {sender?.name || t('搜索')} {t('的搜索结果')}
            </span>
            {message.searchQuery && (
              <span className="text-[10px] bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                "{message.searchQuery}"
              </span>
            )}
          </div>

          <div className="w-full bg-white dark:bg-zinc-900 rounded-2xl border border-blue-200 dark:border-blue-800 shadow-sm overflow-hidden">
            <button
              onClick={() => setIsSearchExpanded(!isSearchExpanded)}
              className="w-full px-4 py-2 flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Search size={14} className="text-blue-500" />
                {isSearchExpanded ? t('收起搜索结果') : t('展开搜索结果')}
              </span>
              {isSearchExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>

            {isSearchExpanded && (
              <div
                className="px-4 pb-4 prose prose-sm dark:prose-invert max-w-full"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(message.text, { async: false }) as string) }}
              />
            )}
          </div>

          <span className="text-[10px] text-gray-400 font-medium mt-1 ml-1">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    );
  }

  // Check if sender is any of the user profiles (multi-identity support)
  const userProfiles = userProfile?.userProfiles || [];
  const matchedProfile = userProfiles.find(p => p.id === message.senderId);
  const isUser = message.senderId === USER_ID || !!matchedProfile;

  const avatarSrc = isUser
     ? (matchedProfile?.avatar || userProfile?.userAvatar || 'https://api.dicebear.com/9.x/micah/svg?seed=user')
     : (sender?.avatar || 'https://picsum.photos/200');
  const displayName = isUser
     ? (matchedProfile?.name || userProfile?.userName || 'User')
     : (sender?.name || 'Unknown');
  
  // Lightweight markdown renderer using marked + useMemo for caching
  const renderedMarkdown = useMemo(() => {
    if (isStreaming) return null; // Don't render during streaming

    let processedText = message.text;

    // Highlight @mentions - match known agent names (supports spaces in names)
    if (allAgents && allAgents.length > 0) {
      // First, highlight @全体成员 and @all
      processedText = processedText.replace(
        /@(全体成员|all)(?=\s|$|[,，。！？!?.:;：；])/gi,
        '<span class="text-blue-400 font-bold bg-blue-500/10 px-1 rounded">@$1</span>'
      );

      // Sort by name length descending to match longer names first (e.g., "Claude 3.5" before "Claude")
      const sortedNames = [...allAgents.map(a => a.name), userProfile?.userName || 'User']
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

      for (const name of sortedNames) {
        // Escape special regex characters in name (including slash and colon which are common in model names)
        const escapedName = name.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        // Match @name followed by whitespace, end of string, or common punctuation (including colon which may follow mentions)
        const mentionRegex = new RegExp(`@${escapedName}(?=\\s|$|[,，。！？!?.:;：；])`, 'gi');
        processedText = processedText.replace(
          mentionRegex,
          `<span class="text-blue-400 font-bold">@${name}</span>`
        );
      }
    } else {
      // Fallback: simple regex for when agents list not available (supports slashes, colons, dots in names)
      processedText = processedText.replace(
        /(@[\w\u4e00-\u9fa5\-\/:._]+)/g,
        '<span class="text-blue-400 font-bold">$1</span>'
      );
    }

    return marked.parse(processedText) as string;
  }, [message.text, isStreaming, allAgents, userProfile?.userName]);

  // compact 且是连续消息时不重画头像，但要留出同宽占位，否则整组消息的左边缘会错开
  const hideIdentity = !!compact && !!continued;

  return (
    <div
      className={`flex w-full ${outerSpacing} group ${isUser ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={readOnly ? undefined : () => setIsHovered(true)}
      onMouseLeave={readOnly ? undefined : () => setIsHovered(false)}
    >
      {!isUser && (
        hideIdentity ? (
          <div className="w-10 mr-3 shrink-0" aria-hidden="true" />
        ) : (
        <div className="flex flex-col items-center mr-3 space-y-1">
          <img
            src={avatarSrc}
            alt="Avatar"
            className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-700 shadow-sm object-contain bg-white p-0.5 cursor-pointer"
            onClick={() => onMention && sender && onMention(sender.name)}
          />
        </div>
        )
      )}

      <div className={`${compact ? 'flex-1 min-w-0' : 'max-w-[85%] sm:max-w-[70%]'} flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        {!hideIdentity && (
        <div className="flex items-center gap-2 mb-1 ml-1">
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1">
              {displayName}
              {!isUser && sender?.role === AgentRole.ADMIN && (
                <span className="text-[9px] bg-zinc-800 text-white px-1 py-0.5 rounded flex items-center gap-0.5">
                   <Shield size={8} /> ADMIN
                </span>
              )}
              {message.pmTargetId && (
                <span className="text-[9px] bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded">
                  {t('私讯→')}{message.pmTargetId === USER_ID ? (userProfile?.userName || 'User') : (allAgents?.find(a => a.id === message.pmTargetId)?.name || t('未知'))}
                </span>
              )}
            </span>
            {/* compact 下时间戳并进名字行，气泡下方那一整行就此省掉 */}
            {compact && <span className="text-[10px] text-gray-400 font-medium shrink-0">· {clockText}</span>}
        </div>
        )}

        {/* Reply Context */}
        {replyToMessage && (
           <div className={`text-xs mb-1 px-3 py-1.5 rounded-lg border-l-2 opacity-80 cursor-pointer
             ${isUser ? 'bg-zinc-800 text-gray-300 border-gray-500' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-zinc-600'}
           `}>
              <div className="font-bold mb-0.5 flex items-center gap-1">
                <Reply size={10} /> {t('引用')} {replyToMessage.senderId === USER_ID ? (userProfile?.userName || 'User') : (replyToMessage.senderId === 'SYSTEM' || replyToMessage.isSystem ? 'System' : allAgents?.find(a => a.id === replyToMessage.senderId)?.name || 'Unknown')}
              </div>
              <div className="line-clamp-1 truncate max-w-[200px]">{replyToMessage.text}</div>
           </div>
        )}

        {/* REASONING CHAIN (Collapsible) */}
        {message.reasoningText && !isUser && (
          <details className="mb-2 max-w-full" open={userProfile?.expandAllReasoning}>
            <summary className="list-none cursor-pointer flex items-center gap-1.5 text-[10px] text-gray-400 font-medium bg-gray-50 dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-600 hover:text-gray-600 dark:hover:text-gray-300 transition-colors w-fit">
               <BrainCircuit size={12} />
               {t('思考过程')}
               {message.reasoningDuration && (
                 <span className="text-gray-400 dark:text-gray-500">
                   ({(message.reasoningDuration / 1000).toFixed(1)}s)
                 </span>
               )}
            </summary>
            <div className="mt-2 p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg border-l-2 border-gray-300 dark:border-zinc-600 text-xs text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-w-full" style={{ wordBreak: 'break-word' }}>
              {message.reasoningText}
            </div>
          </details>
        )}

        <div
          className={`px-5 py-3 rounded-2xl text-[15px] leading-relaxed shadow-sm relative prose prose-sm dark:prose-invert max-w-full overflow-hidden
            ${isUser
              ? 'bg-zinc-900 text-white rounded-br-sm prose-invert'
              : 'bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-200 rounded-bl-sm border border-gray-100 dark:border-zinc-700'
            }
            ${message.pmTargetId ? 'text-purple-600 dark:text-purple-400' : ''}
            ${message.isError ? 'border-red-200 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-300' : ''}
          `}
          style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
        >
          {/* Attachments (Multiple) */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-3 space-y-2">
              {/* Images */}
              {message.attachments.filter(att => att.type === 'image').length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {message.attachments.filter(att => att.type === 'image').map((att, idx) => (
                    <img
                      key={idx}
                      src={att.content}
                      alt={`Image ${idx + 1}`}
                      draggable={false}
                      className="rounded-lg border border-white/20 cursor-pointer hover:opacity-90 transition-opacity"
                      style={{ maxHeight: '150px', maxWidth: '200px' }}
                      onClick={() => setLightboxSrc(att.content)}
                    />
                  ))}
                </div>
              )}
              {/* Documents */}
              {message.attachments.filter(att => att.type === 'document').map((att, idx) => (
                <div key={idx} className="p-2 bg-black/5 rounded-lg border border-black/10 flex items-center gap-2">
                  <FileText size={18} className="text-gray-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-xs truncate">{att.fileName}</div>
                    <div className="text-[10px] opacity-70 uppercase">{att.mimeType.split('/').pop()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {isStreaming ? (
            // Plain text during streaming for performance.
            // 还一个字都没吐出来时（含只出了思考链的那段时间）气泡是个空壳，看着像卡住了，
            // 所以补一个三点跳动的打字指示。这是唯一一处 compact 之外也会改变的渲染。
            message.text ? (
              <span className="whitespace-pre-wrap">{message.text}</span>
            ) : (
              <span className="flex items-center gap-1 py-1" role="status" aria-label={t('正在输入')}>
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:300ms]" />
              </span>
            )
          ) : (
            // Markdown rendering after complete (using cached result)
            <div
              className="markdown-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderedMarkdown || '') }}
            />
          )}
        </div>
        
        {/* compact 下这一整行不渲染：时间戳已经并进名字行，操作栏在 readOnly 下本来就是空的 */}
        {!compact && (
        <div className="flex items-center gap-2 mt-1 mx-1 h-4">
           <span className="text-[10px] text-gray-400 font-medium">
             {clockText}
           </span>

           {/* Actions —— readOnly 下整条不渲染：触屏没有 hover，opacity-0 的按钮会变成隐形可点区 */}
           {!readOnly && (
           <div className={`flex gap-1 transition-opacity duration-200 ${isHovered || isThisMessagePlaying ? 'opacity-100' : 'opacity-0'}`}>
              {/* TTS Play/Stop Button */}
              {onPlayTTS && (
                <button
                  onClick={() => isThisMessagePlaying ? onStopTTS?.() : onPlayTTS(message)}
                  className={`p-0.5 rounded transition-colors ${isThisMessagePlaying ? 'text-green-500 hover:text-red-500' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                  title={isThisMessagePlaying ? t("停止朗读") : t("朗读此消息")}
                >
                  {isThisMessagePlaying ? <Square size={12} /> : <Volume2 size={12} />}
                </button>
              )}
              <button onClick={() => onReply && onReply(message)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded" title={t("引用回复")}>
                 <Reply size={12} />
              </button>
              {!isUser && sender && (
                <button onClick={() => onMention && onMention(sender.name)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded" title={t("@Ta")}>
                   <AtSign size={12} />
                </button>
              )}
              {onDelete && (
                <button onClick={() => onDelete(message.id)} className="text-gray-400 hover:text-red-500 p-0.5 rounded" title={t("删除消息")}>
                   <Trash2 size={12} />
                </button>
              )}
           </div>
           )}
        </div>
        )}

      </div>

      {/* User Avatar on Right */}
      {isUser && (
        hideIdentity ? (
          <div className="w-10 ml-3 shrink-0" aria-hidden="true" />
        ) : (
        <div className="flex flex-col items-center ml-3 space-y-1">
          <img
            src={avatarSrc}
            alt="User Avatar"
            className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-700 shadow-sm object-contain bg-white p-0.5"
          />
        </div>
        )
      )}
      {/* Image Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxBlobUrl || lightboxSrc}
            alt="Full size"
            draggable={false}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute top-4 right-4 flex gap-2">
            {lightboxBlobUrl && (
              <a
                href={lightboxBlobUrl}
                download="image.png"
                className="text-white/70 hover:text-white bg-black/40 rounded-full p-2"
                onClick={(e) => e.stopPropagation()}
              >
                <FileImage size={20} />
              </a>
            )}
            <button
              className="text-white/70 hover:text-white bg-black/40 rounded-full p-2"
              onClick={() => setLightboxSrc(null)}
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(ChatBubble, (prev, next) => {
  if (prev.message !== next.message) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.currentPlayingMessageId !== next.currentPlayingMessageId) return false;
  if (prev.readOnly !== next.readOnly) return false;
  // 漏了这两条的话，分组结果变化（比如中间插进一条别人的消息）不会触发重渲，
  // 头像/名字会停在旧的显隐状态上
  if (prev.compact !== next.compact) return false;
  if (prev.continued !== next.continued) return false;
  if (prev.sender?.name !== next.sender?.name) return false;
  if (prev.sender?.avatar !== next.sender?.avatar) return false;
  return true;
});
