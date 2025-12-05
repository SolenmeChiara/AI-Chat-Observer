
import React, { useState, useMemo } from 'react';
import { Message, Agent, GlobalSettings, AgentRole } from '../types';
import { USER_ID } from '../constants';
import { Reply, AtSign, FileImage, BrainCircuit, FileText, File, Shield, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { marked } from 'marked';

interface ChatBubbleProps {
  message: Message;
  sender?: Agent;
  allAgents?: Agent[]; // All agents for @mention matching
  userProfile?: GlobalSettings; // Pass settings to get user name/avatar
  replyToMessage?: Message;
  onReply?: (message: Message) => void;
  onMention?: (name: string) => void;
  isStreaming?: boolean; // If true, skip markdown rendering for performance
}

const ChatBubble: React.FC<ChatBubbleProps> = ({ message, sender, allAgents, userProfile, replyToMessage, onReply, onMention, isStreaming }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);

  // 1. System Message Style
  if (message.isSystem) {
    return (
      <div className="flex w-full mb-6 justify-center">
        <span className="text-xs bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400 px-3 py-1 rounded-full border border-gray-200 dark:border-zinc-700">
           {message.text}
        </span>
      </div>
    );
  }

  // 2. Search Result Style (Collapsible)
  if (message.isSearchResult) {
    return (
      <div className="flex w-full mb-6 justify-start">
        {sender && (
          <div className="flex flex-col items-center mr-3 space-y-1">
            <img
              src={sender.avatar}
              alt="Avatar"
              className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-600 shadow-sm object-contain bg-white p-0.5"
            />
          </div>
        )}
        <div className="max-w-[85%] sm:max-w-[70%] flex flex-col items-start">
          <div className="flex items-center gap-2 mb-1 ml-1">
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1">
              <Search size={12} className="text-blue-500" />
              {sender?.name || '搜索'} 的搜索结果
            </span>
            {message.searchQuery && (
              <span className="text-[10px] bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                "{message.searchQuery}"
              </span>
            )}
          </div>

          <div className="w-full bg-white dark:bg-zinc-800 rounded-2xl border border-blue-200 dark:border-blue-800 shadow-sm overflow-hidden">
            <button
              onClick={() => setIsSearchExpanded(!isSearchExpanded)}
              className="w-full px-4 py-2 flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Search size={14} className="text-blue-500" />
                {isSearchExpanded ? '收起搜索结果' : '展开搜索结果'}
              </span>
              {isSearchExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>

            {isSearchExpanded && (
              <div
                className="px-4 pb-4 prose prose-sm dark:prose-invert max-w-full"
                dangerouslySetInnerHTML={{ __html: marked.parse(message.text) }}
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

  const isUser = message.senderId === USER_ID;
  const avatarSrc = isUser 
     ? (userProfile?.userAvatar || 'https://api.dicebear.com/9.x/micah/svg?seed=user') 
     : (sender?.avatar || 'https://picsum.photos/200');
  const displayName = isUser 
     ? (userProfile?.userName || 'User') 
     : (sender?.name || 'Unknown');
  
  // Configure marked for security and style
  marked.setOptions({
    breaks: true,  // Convert \n to <br>
    gfm: true,     // GitHub Flavored Markdown
  });

  // Lightweight markdown renderer using marked + useMemo for caching
  const renderedMarkdown = useMemo(() => {
    if (isStreaming) return null; // Don't render during streaming

    let processedText = message.text;

    // Highlight @mentions - match known agent names (supports spaces in names)
    if (allAgents && allAgents.length > 0) {
      // Sort by name length descending to match longer names first (e.g., "Claude 3.5" before "Claude")
      const sortedNames = [...allAgents.map(a => a.name), userProfile?.userName || 'User']
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

      for (const name of sortedNames) {
        // Escape special regex characters in name
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionRegex = new RegExp(`@${escapedName}(?=\\s|$|[,，。！？!?.])`, 'gi');
        processedText = processedText.replace(
          mentionRegex,
          `<span class="text-blue-400 font-bold">@${name}</span>`
        );
      }
    } else {
      // Fallback: simple regex for when agents list not available
      processedText = processedText.replace(
        /(@[\w\u4e00-\u9fa5\-]+)/g,
        '<span class="text-blue-400 font-bold">$1</span>'
      );
    }

    return marked.parse(processedText);
  }, [message.text, isStreaming, allAgents, userProfile?.userName]);

  return (
    <div 
      className={`flex w-full mb-6 group ${isUser ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {!isUser && (
        <div className="flex flex-col items-center mr-3 space-y-1">
          <img 
            src={avatarSrc}
            alt="Avatar"
            className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-600 shadow-sm object-contain bg-white p-0.5 cursor-pointer"
            onClick={() => onMention && sender && onMention(sender.name)}
          />
        </div>
      )}
      
      <div className={`max-w-[85%] sm:max-w-[70%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div className="flex items-center gap-2 mb-1 ml-1">
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1">
              {displayName}
              {!isUser && sender?.role === AgentRole.ADMIN && (
                <span className="text-[9px] bg-zinc-800 text-white px-1 py-0.5 rounded flex items-center gap-0.5">
                   <Shield size={8} /> ADMIN
                </span>
              )}
            </span>
        </div>
        
        {/* Reply Context */}
        {replyToMessage && (
           <div className={`text-xs mb-1 px-3 py-1.5 rounded-lg border-l-2 opacity-80 cursor-pointer
             ${isUser ? 'bg-zinc-800 text-gray-300 border-gray-500' : 'bg-gray-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-zinc-500'}
           `}>
              <div className="font-bold mb-0.5 flex items-center gap-1">
                <Reply size={10} /> 引用 {replyToMessage.senderId === USER_ID ? 'User' : 'Bot'}
              </div>
              <div className="line-clamp-1 truncate max-w-[200px]">{replyToMessage.text}</div>
           </div>
        )}

        {/* REASONING CHAIN (Collapsible) */}
        {message.reasoningText && !isUser && (
          <details className="mb-2 max-w-full">
            <summary className="list-none cursor-pointer flex items-center gap-1.5 text-[10px] text-gray-400 font-medium bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-600 hover:text-gray-600 dark:hover:text-gray-300 transition-colors w-fit">
               <BrainCircuit size={12} />
               思考过程 (已折叠)
            </summary>
            <div className="mt-2 p-3 bg-gray-50 dark:bg-zinc-700 rounded-lg border-l-2 border-gray-300 dark:border-zinc-500 text-xs text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-w-full" style={{ wordBreak: 'break-word' }}>
              {message.reasoningText}
            </div>
          </details>
        )}

        <div
          className={`px-5 py-3 rounded-2xl text-[15px] leading-relaxed shadow-sm relative prose prose-sm dark:prose-invert max-w-full overflow-hidden
            ${isUser
              ? 'bg-zinc-900 text-white rounded-br-sm prose-invert'
              : 'bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 rounded-bl-sm border border-gray-100 dark:border-zinc-700'
            }
            ${message.isError ? 'border-red-200 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-300' : ''}
          `}
          style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
        >
          {/* Document Attachment */}
          {message.attachment && message.attachment.type === 'document' && (
             <div className="mb-3 p-3 bg-black/5 rounded-lg border border-black/10 flex items-center gap-3">
                <div className="bg-white p-2 rounded shadow-sm">
                  <FileText size={24} className="text-gray-600" />
                </div>
                <div className="flex-1 min-w-0">
                   <div className="font-bold text-xs truncate max-w-[150px]">{message.attachment.fileName}</div>
                   <div className="text-[10px] opacity-70 uppercase">{message.attachment.mimeType.split('/').pop()} 文件</div>
                </div>
             </div>
          )}

          {/* Image Attachment */}
          {message.attachment && message.attachment.type === 'image' && (
            <div className="mb-3">
              <img 
                src={message.attachment.content} 
                alt="Uploaded" 
                className="max-w-full rounded-lg border border-white/20" 
                style={{ maxHeight: '200px' }}
              />
            </div>
          )}

          {isStreaming ? (
            // Plain text during streaming for performance
            <span className="whitespace-pre-wrap">{message.text}</span>
          ) : (
            // Markdown rendering after complete (using cached result)
            <div
              className="markdown-content"
              dangerouslySetInnerHTML={{ __html: renderedMarkdown || '' }}
            />
          )}
        </div>
        
        <div className="flex items-center gap-2 mt-1 mx-1 h-4">
           <span className="text-[10px] text-gray-400 font-medium">
             {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
           </span>

           {/* Actions */}
           <div className={`flex gap-1 transition-opacity duration-200 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
              <button onClick={() => onReply && onReply(message)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded" title="引用回复">
                 <Reply size={12} />
              </button>
              {!isUser && sender && (
                <button onClick={() => onMention && onMention(sender.name)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded" title="@Ta">
                   <AtSign size={12} />
                </button>
              )}
           </div>
        </div>

      </div>

      {/* User Avatar on Right */}
      {isUser && (
        <div className="flex flex-col items-center ml-3 space-y-1">
          <img
            src={avatarSrc}
            alt="User Avatar"
            className="w-10 h-10 rounded-full border border-gray-200 dark:border-zinc-600 shadow-sm object-contain bg-white p-0.5"
          />
        </div>
      )}
    </div>
  );
};

export default ChatBubble;
