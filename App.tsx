
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Menu, Send, Play, Pause, Trash, MessageSquare, DollarSign, Users, Plus, Paperclip, X, Image as ImageIcon, FileText, RefreshCw, ArrowDown, BarChart3 } from 'lucide-react';
import { Agent, Message, ApiProvider, GlobalSettings, ChatSession, ChatGroup, Attachment, AgentRole, MemoryConfig } from './types';
import { INITIAL_AGENTS, INITIAL_PROVIDERS, USER_ID, DEFAULT_SETTINGS, INITIAL_SESSIONS, INITIAL_GROUPS, getAvatarForModel } from './constants';
import Sidebar from './components/Sidebar';
import RightSidebar from './components/RightSidebar';
import ChatBubble from './components/ChatBubble';
import StatsPanel from './components/StatsPanel';
import { streamGeminiReply } from './services/geminiService';
import { streamOpenAIReply } from './services/openaiService';
import { streamAnthropicReply } from './services/anthropicService';
import { generateSessionName, updateSessionSummary } from './services/summaryService';
import { AgentType } from './types';
import { parseFile } from './services/fileParser';
import { initDB, loadAllData, saveCollection, saveSettings } from './services/db';
import { describeImage } from './services/visionProxyService';
import { performSearch, formatSearchResultsForContext, formatSearchResultsForDisplay } from './services/searchService';

// Helper to format timestamp for error messages (HH:MM:SS)
const formatErrorTimestamp = () => {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
};

const App: React.FC = () => {
  // --- STATE ---
  const [agents, setAgents] = useState<Agent[]>(INITIAL_AGENTS);
  const [providers, setProviders] = useState<ApiProvider[]>(INITIAL_PROVIDERS);
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  
  // Group & Session State
  const [groups, setGroups] = useState<ChatGroup[]>(INITIAL_GROUPS);
  const [activeGroupId, setActiveGroupId] = useState<string>(INITIAL_GROUPS[0].id);
  const [sessions, setSessions] = useState<ChatSession[]>(INITIAL_SESSIONS);
  const [activeSessionId, setActiveSessionId] = useState<string>(INITIAL_SESSIONS[0].id);

  // DB Loaded Flag
  const [isDbLoaded, setIsDbLoaded] = useState(false);

  // Derived active session and group data
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];
  const activeGroup = groups.find(g => g.id === activeGroupId) || groups[0];
  const messages = activeSession.messages;

  // 当前群组的成员 (根据 group.memberIds 过滤)
  const sessionMembers = activeGroup?.memberIds
    ? agents.filter(a => activeGroup.memberIds.includes(a.id))
    : agents.filter(a => a.isActive !== false); // 兼容旧数据

  // Input State
  const [inputText, setInputText] = useState('');
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Mention State
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  
  // CONCURRENCY & STABILITY STATE
  // Instead of a single ID, we track a Set of Agent IDs currently thinking
  const [processingAgents, setProcessingAgents] = useState<Set<string>>(new Set());
  const [totalCost, setTotalCost] = useState(0);

  // Refs for Timeout Management
  // Maps agentId -> AbortController to kill stuck requests
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // Cooldown tracking: Maps agentId -> message count when they last spoke
  // Prevents agents from being triggered again until N messages have passed
  const agentLastSpokeAt = useRef<Map<string, number>>(new Map());

  // Queue for multi-mention triggers (e.g., @A @B @C or @全体成员)
  const mentionQueueRef = useRef<string[]>([]);

  // Ref to prevent duplicate triggers (sync check before async state update)
  const pendingTriggerRef = useRef<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll state - track if user is near bottom
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // --- PERSISTENCE (IndexedDB) ---
  
  // 1. Init & Load on Mount
  useEffect(() => {
    const bootstrap = async () => {
      await initDB();
      const data = await loadAllData();

      setAgents(data.agents);
      setProviders(data.providers);
      setGroups(data.groups);
      setSessions(data.sessions);
      // Merge with defaults to ensure new fields like enableConcurrency exist
      setSettings({ ...DEFAULT_SETTINGS, ...data.settings });

      // Ensure activeGroupId and activeSessionId are valid
      const firstGroup = data.groups[0];
      if (!data.groups.find(g => g.id === activeGroupId) && firstGroup) {
         setActiveGroupId(firstGroup.id);
      }
      const firstSession = data.sessions.find(s => s.groupId === (firstGroup?.id || activeGroupId)) || data.sessions[0];
      if (!data.sessions.find(s => s.id === activeSessionId) && firstSession) {
         setActiveSessionId(firstSession.id);
      }

      setIsDbLoaded(true);
    };
    bootstrap();
  }, []);

  // 2. Save Watchers (Immediate)
  useEffect(() => {
    if (isDbLoaded) saveCollection('agents', agents);
  }, [agents, isDbLoaded]);

  useEffect(() => {
    if (isDbLoaded) saveCollection('providers', providers);
  }, [providers, isDbLoaded]);

  useEffect(() => {
    if (isDbLoaded) saveCollection('groups', groups);
  }, [groups, isDbLoaded]);

  useEffect(() => {
    if (isDbLoaded) saveSettings(settings);
  }, [settings, isDbLoaded]);

  // Dark Mode: Apply class to html element
  useEffect(() => {
    if (settings.darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [settings.darkMode]);

  // Clear cooldown and queue when switching sessions
  useEffect(() => {
    agentLastSpokeAt.current.clear();
    mentionQueueRef.current = [];
    pendingTriggerRef.current.clear();
    console.log('[Session] Switched to session:', activeSessionId, '- cleared cooldowns and queues');
  }, [activeSessionId]);

  // 3. Save Watchers (Debounced for Sessions)
  useEffect(() => {
    if (!isDbLoaded) return;
    const timeoutId = setTimeout(() => {
        saveCollection('sessions', sessions);
    }, 1000); // Debounce saves to 1s to handle streaming updates
    return () => clearTimeout(timeoutId);
  }, [sessions, isDbLoaded]);


  // --- HELPERS ---
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Check if user is near bottom of scroll container
  const checkIfNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const threshold = 150; // pixels from bottom
    const isNear = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    return isNear;
  }, []);

  // Handle scroll event
  const handleScroll = useCallback(() => {
    const isNear = checkIfNearBottom();
    setIsNearBottom(isNear);
    setShowScrollButton(!isNear && messages.length > 0);
  }, [checkIfNearBottom, messages.length]);

  // Add scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Auto-scroll only when user is near bottom
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom();
    }
  }, [messages.length, processingAgents.size, isNearBottom]);

  // Session Management Helpers
  const updateActiveSession = (updateFn: (session: ChatSession) => ChatSession) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? updateFn(s) : s));
  };

  const updateActiveSessionMessages = (updateFn: (prev: Message[]) => Message[]) => {
    updateActiveSession(s => ({
        ...s,
        messages: updateFn(s.messages),
        lastUpdated: Date.now()
        // NOTE: yieldedAgentIds is NOT cleared here anymore - only cleared when USER sends a message
    }));
  };

  // --- GROUP MANAGEMENT ---
  const handleCreateGroup = () => {
    const newGroupId = Date.now().toString();
    const newSessionId = `${newGroupId}-session-1`;

    const newGroup: ChatGroup = {
      id: newGroupId,
      name: `群组 ${groups.length + 1}`,
      memberIds: agents.filter(a => a.isActive !== false && a.providerId && a.modelId).map(a => a.id),
      scenario: '这是一个轻松的聊天室。',
      memoryConfig: {
        enabled: false,
        threshold: 20,
        summaryModelId: '',
        summaryProviderId: ''
      },
      createdAt: Date.now()
    };

    const newSession: ChatSession = {
      id: newSessionId,
      groupId: newGroupId,
      name: '对话 1',
      messages: [],
      lastUpdated: Date.now(),
      isAutoRenamed: false,
      mutedAgentIds: [],
      mutedAgents: [],
      yieldedAgentIds: []
    };

    setGroups([...groups, newGroup]);
    setSessions([...sessions, newSession]);
    setActiveGroupId(newGroupId);
    setActiveSessionId(newSessionId);
  };

  const handleDeleteGroup = (id: string) => {
    if (groups.length <= 1) return;
    // Delete group and all its sessions
    setGroups(groups.filter(g => g.id !== id));
    setSessions(sessions.filter(s => s.groupId !== id));

    if (activeGroupId === id) {
      const remainingGroups = groups.filter(g => g.id !== id);
      const newActiveGroup = remainingGroups[0];
      setActiveGroupId(newActiveGroup.id);
      const groupSessions = sessions.filter(s => s.groupId === newActiveGroup.id);
      if (groupSessions.length > 0) {
        setActiveSessionId(groupSessions[0].id);
      }
    }
  };

  const handleSwitchGroup = (id: string) => {
    setActiveGroupId(id);
    // Switch to the first session of this group
    const groupSessions = sessions.filter(s => s.groupId === id);
    if (groupSessions.length > 0) {
      setActiveSessionId(groupSessions[0].id);
    }
  };

  const handleRenameGroup = (id: string, name: string) => {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, name } : g));
  };

  const handleUpdateGroupScenario = (id: string, scenario: string) => {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, scenario } : g));
  };

  const handleUpdateGroupMemoryConfig = (id: string, updates: Partial<MemoryConfig>) => {
    setGroups(prev => prev.map(g => g.id === id ? { ...g, memoryConfig: { ...g.memoryConfig, ...updates } } : g));
  };

  // --- SESSION MANAGEMENT ---
  const handleCreateSession = (groupId: string) => {
    const groupSessions = sessions.filter(s => s.groupId === groupId);
    const newSession: ChatSession = {
      id: Date.now().toString(),
      groupId: groupId,
      name: `对话 ${groupSessions.length + 1}`,
      messages: [],
      lastUpdated: Date.now(),
      isAutoRenamed: false,
      mutedAgentIds: [],
      mutedAgents: [],
      yieldedAgentIds: []
    };
    setSessions([...sessions, newSession]);
    setActiveSessionId(newSession.id);
  };

  const handleDeleteSession = (id: string) => {
    const newSessions = sessions.filter(s => s.id !== id);
    if (newSessions.length === 0) return; 
    setSessions(newSessions);
    if (activeSessionId === id) {
      setActiveSessionId(newSessions[0].id);
    }
  };

  const handleRenameSession = (id: string, name: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, name, isAutoRenamed: true } : s));
  };

  const handleUpdateSummary = (id: string, summary: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, summary } : s));
  };

  const handleStopAll = () => {
    setIsAutoPlay(false);
    // Hard Stop: Abort all active requests
    abortControllers.current.forEach(ctrl => ctrl.abort());
    abortControllers.current.clear();
    setProcessingAgents(new Set());
  };

  const handleClearMessages = () => {
    updateActiveSession(s => ({ ...s, messages: [], yieldedAgentIds: [], adminNotes: [] }));
    setTotalCost(0);
    handleStopAll();
  };

  const calculateCost = (tokens: { input: number, output: number }, provider: ApiProvider, modelId: string): number => {
    const modelConfig = provider.models.find(m => m.id === modelId);
    if (!modelConfig) return 0;
    
    const inputCost = (tokens.input / 1000000) * modelConfig.inputPricePer1M;
    const outputCost = (tokens.output / 1000000) * modelConfig.outputPricePer1M;
    return inputCost + outputCost;
  };

  const handleAddAgentFromRightSidebar = (providerId: string, modelId: string) => {
    const provider = providers.find(p => p.id === providerId);
    const model = provider?.models.find(m => m.id === modelId);

    const newAgentName = model?.name || modelId || '新角色';
    const newAgent: Agent = {
      id: Date.now().toString(),
      name: newAgentName,
      avatar: getAvatarForModel(modelId, provider?.name || ''),
      providerId: providerId,
      modelId: modelId,
      systemPrompt: '你是一个乐于助人的群聊参与者。',
      color: 'bg-gray-600',
      config: { temperature: 0.7, maxTokens: 2000, enableReasoning: false, reasoningBudget: 0 },
      role: AgentRole.MEMBER
    };
    setAgents(prev => [...prev, newAgent]);

    // Add system message for new member joining
    const joinMessage: Message = {
      id: `join-${Date.now()}`,
      senderId: 'system',
      text: `${newAgentName} 加入了群聊`,
      timestamp: Date.now(),
      isSystem: true
    };
    updateActiveSession(s => ({ ...s, messages: [...s.messages, joinMessage] }));
  };

  // 从当前群组中移除成员
  const handleRemoveAgent = (id: string) => {
    setGroups(prev => prev.map(g => g.id === activeGroupId ? {
      ...g,
      memberIds: g.memberIds.filter(mid => mid !== id)
    } : g));
  };

  // 添加角色到当前群组
  const handleActivateAgent = (id: string) => {
    const agent = agents.find(a => a.id === id);
    if (!agent) return;

    setGroups(prev => prev.map(g => g.id === activeGroupId ? {
      ...g,
      memberIds: [...g.memberIds, id]
    } : g));

    // Add system message for new member joining
    const joinMessage: Message = {
      id: `join-${Date.now()}`,
      senderId: 'system',
      text: `${agent.name || '新成员'} 加入了群组`,
      timestamp: Date.now(),
      isSystem: true
    };
    updateActiveSession(s => ({ ...s, messages: [...s.messages, joinMessage] }));
  };

  // 切换群组管理员状态
  const handleToggleAdmin = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    setGroups(prev => prev.map(g => {
      if (g.id !== activeGroupId) return g;
      const currentAdmins = g.adminIds || [];
      const isCurrentlyAdmin = currentAdmins.includes(agentId);

      return {
        ...g,
        adminIds: isCurrentlyAdmin
          ? currentAdmins.filter(id => id !== agentId)
          : [...currentAdmins, agentId]
      };
    }));

    // 添加系统消息
    const isNowAdmin = !(activeGroup?.adminIds || []).includes(agentId);
    const systemMessage: Message = {
      id: `admin-${Date.now()}`,
      senderId: 'system',
      text: isNowAdmin
        ? `${agent.name} 被设为群管理员`
        : `${agent.name} 的管理员权限已撤销`,
      timestamp: Date.now(),
      isSystem: true
    };
    updateActiveSession(s => ({ ...s, messages: [...s.messages, systemMessage] }));
  };

  // Format duration for display
  const formatDuration = (minutes: number): string => {
    if (minutes === 0) return '永久';
    if (minutes < 60) return `${minutes}分钟`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}小时`;
    return `${Math.floor(minutes / (60 * 24))}天`;
  };

  const handleMuteAgent = (agentId: string, durationMinutes: number, mutedBy: string) => {
    updateActiveSession(s => {
        const agentName = agents.find(a => a.id === agentId)?.name || "Unknown";
        const existingMute = (s.mutedAgents || []).find(m => m.agentId === agentId);
        const now = Date.now();

        let muteUntil: number;
        let messageText: string;

        if (durationMinutes === 0) {
            // Permanent mute
            muteUntil = 0;
            messageText = `${mutedBy} 永久禁言了 ${agentName}`;
        } else if (existingMute && (existingMute.muteUntil === 0 || existingMute.muteUntil > now)) {
            // Already muted - add time instead of replacing
            const addMs = durationMinutes * 60 * 1000;
            if (existingMute.muteUntil === 0) {
                // Already permanent, can't add more
                muteUntil = 0;
                messageText = `${agentName} 已被永久禁言`;
            } else {
                // Add time to existing mute
                muteUntil = existingMute.muteUntil + addMs;
                const remainingMs = muteUntil - now;
                const remainingMins = Math.ceil(remainingMs / 60000);
                messageText = `${mutedBy} 追加了 ${agentName} 的禁言时间 +${formatDuration(durationMinutes)}（剩余 ${formatDuration(remainingMins)}）`;
            }
        } else {
            // New mute
            muteUntil = now + durationMinutes * 60 * 1000;
            messageText = `${mutedBy} 禁言了 ${agentName}（${formatDuration(durationMinutes)}）`;
        }

        const newMutedAgents = [...(s.mutedAgents || []).filter(m => m.agentId !== agentId), {
            agentId,
            muteUntil,
            mutedBy
        }];
        const newMutedIds = [...new Set([...(s.mutedAgentIds || []).filter(id => id !== agentId), agentId])];

        const sysMsg: Message = {
            id: Date.now().toString(),
            senderId: 'SYSTEM',
            text: messageText,
            timestamp: Date.now(),
            isSystem: true
        };

        return {
           ...s,
           mutedAgentIds: newMutedIds,
           mutedAgents: newMutedAgents,
           messages: [...s.messages, sysMsg],
           yieldedAgentIds: []
        };
    });
  };

  const handleUnmuteAgent = (agentId: string) => {
    updateActiveSession(s => {
        const agentName = agents.find(a => a.id === agentId)?.name || "Unknown";
        const muteInfo = (s.mutedAgents || []).find(m => m.agentId === agentId);

        const sysMsg: Message = {
            id: Date.now().toString(),
            senderId: 'SYSTEM',
            text: `${settings.userName || 'User'} 解除了 ${agentName} 的禁言`,
            timestamp: Date.now(),
            isSystem: true
        };

        return {
           ...s,
           mutedAgentIds: (s.mutedAgentIds || []).filter(id => id !== agentId),
           mutedAgents: (s.mutedAgents || []).filter(m => m.agentId !== agentId),
           messages: [...s.messages, sysMsg],
           yieldedAgentIds: []
        };
    });
  };

  // Check for expired mutes every minute
  useEffect(() => {
    const checkExpiredMutes = () => {
      const now = Date.now();
      const mutedAgents = activeSession.mutedAgents || [];
      const expiredMutes = mutedAgents.filter(m => m.muteUntil !== 0 && m.muteUntil <= now);

      if (expiredMutes.length > 0) {
        updateActiveSession(s => {
          const expiredIds = expiredMutes.map(m => m.agentId);
          const expiredNames = expiredMutes.map(m => agents.find(a => a.id === m.agentId)?.name || 'Unknown');

          const sysMsg: Message = {
            id: Date.now().toString(),
            senderId: 'SYSTEM',
            text: `${expiredNames.join('、')} 的禁言已到期，已自动解除`,
            timestamp: Date.now(),
            isSystem: true
          };

          return {
            ...s,
            mutedAgentIds: (s.mutedAgentIds || []).filter(id => !expiredIds.includes(id)),
            mutedAgents: (s.mutedAgents || []).filter(m => !expiredIds.includes(m.agentId)),
            messages: [...s.messages, sysMsg]
          };
        });
      }
    };

    const interval = setInterval(checkExpiredMutes, 60000); // Check every minute
    checkExpiredMutes(); // Also check immediately

    return () => clearInterval(interval);
  }, [activeSession.mutedAgents, agents]);

  // --- AUTO-NAMING LOGIC ---
  useEffect(() => {
    const checkAndRename = async () => {
      const chatMsgs = activeSession.messages.filter(m => !m.isSystem);
      if (chatMsgs.length >= 2 && !activeSession.isAutoRenamed && providers.length > 0) {
        console.log("[Auto-Rename] Triggering for session:", activeSessionId, "with", chatMsgs.length, "messages");
        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, isAutoRenamed: true } : s));
        const newName = await generateSessionName(chatMsgs, providers, agents);
        console.log("[Auto-Rename] Generated name:", newName);
        if (newName) {
          setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, name: newName } : s));
        }
      }
    };
    checkAndRename();
  }, [activeSession.messages.length, activeSessionId, activeSession.isAutoRenamed, providers, agents]);

  // --- ONE-TIME RENAME FOR OLD SESSIONS ---
  const hasRenamedOldSessions = useRef(false);
  useEffect(() => {
    if (hasRenamedOldSessions.current || !isDbLoaded || providers.length === 0) return;
    hasRenamedOldSessions.current = true;

    const renameOldSessions = async () => {
      const eligibleSessions = sessions.filter(s => {
        const chatMsgs = s.messages.filter(m => !m.isSystem);
        return chatMsgs.length >= 2 && !s.isAutoRenamed;
      });

      if (eligibleSessions.length === 0) return;
      console.log("[Auto-Rename] Found", eligibleSessions.length, "old sessions to rename");

      for (const session of eligibleSessions) {
        const chatMsgs = session.messages.filter(m => !m.isSystem);
        setSessions(prev => prev.map(s => s.id === session.id ? { ...s, isAutoRenamed: true } : s));
        const newName = await generateSessionName(chatMsgs, providers, agents);
        console.log("[Auto-Rename] Old session", session.id, "->", newName);
        if (newName) {
          setSessions(prev => prev.map(s => s.id === session.id ? { ...s, name: newName } : s));
        }
      }
    };

    renameOldSessions();
  }, [isDbLoaded, providers, agents, sessions]);

  // --- MEMORY SUMMARIZATION TRIGGER ---
  useEffect(() => {
    const checkAndSummarize = async () => {
        // 从群组获取记忆配置
        const conf = activeGroup?.memoryConfig;
        if (!conf || !conf.enabled || !conf.summaryModelId) return;

        const count = activeSession.messages.length;
        if (count > 0 && count % conf.threshold === 0) {
            // Trigger Summarization
            const provider = providers.find(p => p.id === conf.summaryProviderId);
            if (!provider) return;

            // Take recent messages
            const recent = activeSession.messages.slice(-conf.threshold);
            const notes = activeSession.adminNotes;

            console.log("Triggering Automatic Memory Summary...");

            const newSummary = await updateSessionSummary(
                activeSession.summary,
                notes,
                recent,
                provider,
                conf.summaryModelId,
                agents
            );

            if (newSummary) {
                console.log("Memory Updated:", newSummary);
                setSessions(prev => prev.map(s => s.id === activeSessionId ? {
                    ...s,
                    summary: newSummary,
                    adminNotes: [] // Clear notes after processing
                }: s));
            }
        }
    };
    checkAndSummarize();
  }, [activeSession.messages.length, activeGroup?.memoryConfig, activeSessionId, providers, agents]);


  // --- CORE LOGIC ---
  const triggerAgentReply = useCallback(async (agentId: string, disableSearch: boolean = false) => {
    if ((activeSession.mutedAgentIds || []).includes(agentId)) return;

    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    // Skip inactive or unconfigured agents
    if (agent.isActive === false) return;
    if (!agent.providerId || !agent.modelId) return;

    // Synchronous check using ref to prevent race conditions
    if (pendingTriggerRef.current.has(agentId)) return;

    // Concurrency Check (also check pending triggers)
    const totalPending = processingAgents.size + pendingTriggerRef.current.size;
    if (!settings.enableConcurrency && totalPending > 0) return;
    if (processingAgents.has(agentId)) return;

    // Mark as pending immediately (sync) before any async operations
    pendingTriggerRef.current.add(agentId);

    const provider = providers.find(p => p.id === agent.providerId);
    if (!provider) {
      pendingTriggerRef.current.delete(agentId); // Clear pending on error
      updateActiveSessionMessages(prev => [...prev, {
        id: Date.now().toString(), senderId: agent.id, text: `[${formatErrorTimestamp()}] [系统错误] 找不到供应商配置。`, timestamp: Date.now(), isError: true
      }]);
      return;
    }

    // Capture the session ID at the start to prevent closure issues during async operations
    const capturedSessionId = activeSessionId;

    // Local update function that uses the captured session ID
    const updateThisSession = (updateFn: (session: ChatSession) => ChatSession) => {
      setSessions(prev => prev.map(s => s.id === capturedSessionId ? updateFn(s) : s));
    };

    setProcessingAgents(prev => new Set(prev).add(agentId));
    const abortController = new AbortController();
    abortControllers.current.set(agentId, abortController);

    // Use agent ID in message ID to prevent collisions when multiple agents trigger simultaneously
    const newMessageId = `${Date.now()}-${agentId}`;
    const placeholderMessage: Message = {
      id: newMessageId, senderId: agent.id, text: '', timestamp: Date.now(),
      isStreaming: true  // 占位符标记，对其他AI不可见
    };

    updateThisSession(s => ({ ...s, messages: [...s.messages, placeholderMessage], lastUpdated: Date.now() }));

    const timeoutId = setTimeout(() => {
        if (abortControllers.current.has(agentId)) {
            const ctrl = abortControllers.current.get(agentId);
            ctrl?.abort();
            updateThisSession(s => ({
                ...s,
                messages: s.messages.map(m => m.id === newMessageId ? {
                    ...m, isError: true, text: m.text + `\n[${formatErrorTimestamp()}] [系统: 响应超时 (${settings.timeoutDuration/1000}s), 已强制终止]`
                } : m)
            }));
            setProcessingAgents(prev => {
                const next = new Set(prev);
                next.delete(agentId);
                return next;
            });
            abortControllers.current.delete(agentId);
        }
    }, settings.timeoutDuration || 30000);

    try {
      let streamGenerator;
      // 从群组获取场景设定
      const currentGroup = groups.find(g => g.id === activeSession.groupId);
      const scenario = currentGroup?.scenario || "";
      const summary = activeSession.summary;

      // 获取当前群组的成员列表
      const currentSessionMembers = currentGroup?.memberIds
        ? agents.filter(a => currentGroup.memberIds.includes(a.id))
        : agents.filter(a => a.isActive !== false);
      const adminNotes = activeSession.adminNotes;

      // --- VISION PROXY PREPROCESSING ---
      // If agent has vision proxy enabled, convert images to text descriptions
      let processedMessages = messages;

      if (agent.config.visionProxyEnabled && agent.config.visionProxyProviderId) {
        const visionProvider = providers.find(p => p.id === agent.config.visionProxyProviderId);

        if (visionProvider && visionProvider.apiKey) {
          // Find messages with image attachments
          const messagesWithImages = messages.filter(m => m.attachment?.type === 'image');

          if (messagesWithImages.length > 0) {
            // Process images in parallel
            const imageDescriptions = new Map<string, string>();

            await Promise.all(messagesWithImages.map(async (msg) => {
              if (msg.attachment?.content) {
                const base64Data = msg.attachment.content.split(',')[1] || msg.attachment.content;
                const description = await describeImage(base64Data, msg.attachment.mimeType, visionProvider);
                imageDescriptions.set(msg.id, description);
              }
            }));

            // Replace image attachments with text descriptions
            processedMessages = messages.map(msg => {
              if (msg.attachment?.type === 'image' && imageDescriptions.has(msg.id)) {
                return {
                  ...msg,
                  attachment: {
                    ...msg.attachment,
                    type: 'document' as const,
                    textContent: `[图片内容描述]\n${imageDescriptions.get(msg.id)}\n[描述结束]`
                  }
                };
              }
              return msg;
            });
          }
        }
      }
      // --- END VISION PROXY ---

      // Check if agent has search tool enabled (disabled after search to prevent "I'll search" loop)
      const hasSearchTool = !disableSearch && !!(agent.searchConfig?.enabled && agent.searchConfig?.apiKey);

      // Pass userName and userPersona from settings (using processedMessages for vision proxy)
      const groupAdminIds = currentGroup?.adminIds || [];

      if (provider.type === AgentType.GEMINI) {
        streamGenerator = streamGeminiReply(
          agent, agent.modelId, processedMessages, currentSessionMembers, settings.visibilityMode, settings.contextLimit,
          {
            apiKey: provider.apiKey,
            geminiMode: provider.geminiMode,
            vertexProject: provider.vertexProject,
            vertexLocation: provider.vertexLocation
          },
          scenario, summary, adminNotes, settings.userName, settings.userPersona, hasSearchTool,
          agent.enableGoogleSearch, groupAdminIds
        );
      } else if (provider.type === AgentType.ANTHROPIC) {
        streamGenerator = streamAnthropicReply(
          agent, provider.baseUrl || 'https://api.anthropic.com/v1', provider.apiKey || '', agent.modelId, processedMessages, currentSessionMembers, settings.visibilityMode, settings.contextLimit,
          scenario, summary, adminNotes, settings.userName, settings.userPersona, hasSearchTool, groupAdminIds
        );
      } else {
        streamGenerator = streamOpenAIReply(
          agent, provider.baseUrl || '', provider.apiKey || '', agent.modelId, processedMessages, currentSessionMembers, settings.visibilityMode, settings.contextLimit,
          scenario, summary, adminNotes, settings.userName, settings.userPersona, hasSearchTool, groupAdminIds
        );
      }

      let accumulatedText = "";
      let accumulatedReasoning = "";
      let accumulatedUsage = { input: 0, output: 0 };
      let capturedSignature: string | undefined;
      let isPass = false;
      let detectedReplyId: string | undefined = undefined;

      // ADMIN COMMAND STATE
      let detectedAdminAction: { type: 'MUTE' | 'UNMUTE' | 'NOTE' | 'DELNOTE' | 'CLEARNOTES', target: string, duration?: number } | null = null;

      // SEARCH COMMAND STATE
      let detectedSearchQuery: string | null = null;

      for await (const chunk of streamGenerator) {
        if (abortController.signal.aborted) throw new Error("Request aborted");

        if (chunk.reasoning) {
            accumulatedReasoning += chunk.reasoning;
            updateThisSession(s => ({
                ...s,
                messages: s.messages.map(m => m.id === newMessageId ? { ...m, reasoningText: accumulatedReasoning } : m)
            }));
        }

        if (chunk.text) {
          accumulatedText += chunk.text;

          if (accumulatedText.includes("{{PASS}}")) {
             isPass = true;
             break;
          }

          // ADMIN COMMAND PARSING
          if (agent.role === AgentRole.ADMIN) {
             // Support formats: {{MUTE: Name}} or {{MUTE: Name, 30min}} or {{MUTE: Name, 1h}}
             const muteMatch = accumulatedText.match(/\{\{MUTE:\s*([^,}]+)(?:,\s*(\d+)(min|h|d|m))?\}\}/i);
             if (muteMatch) {
               let duration = 30; // Default 30 minutes
               if (muteMatch[2] && muteMatch[3]) {
                 const num = parseInt(muteMatch[2]);
                 const unit = muteMatch[3].toLowerCase();
                 if (unit === 'min' || unit === 'm') duration = num;
                 else if (unit === 'h') duration = num * 60;
                 else if (unit === 'd') duration = num * 60 * 24;
               }
               detectedAdminAction = { type: 'MUTE', target: muteMatch[1].trim(), duration };
             }

             const unmuteMatch = accumulatedText.match(/\{\{UNMUTE:\s*(.+?)\}\}/);
             if (unmuteMatch) detectedAdminAction = { type: 'UNMUTE', target: unmuteMatch[1] };

             const noteMatch = accumulatedText.match(/\{\{NOTE:\s*(.+?)\}\}/);
             if (noteMatch) detectedAdminAction = { type: 'NOTE', target: noteMatch[1] };

             // New: Delete note command
             const delNoteMatch = accumulatedText.match(/\{\{DELNOTE:\s*(.+?)\}\}/);
             if (delNoteMatch) detectedAdminAction = { type: 'DELNOTE', target: delNoteMatch[1] };

             // New: Clear all notes command
             if (accumulatedText.includes('{{CLEARNOTES}}')) {
               detectedAdminAction = { type: 'CLEARNOTES', target: '' };
             }
          }

          // Detect Search command (only if agent has search tool AND search not disabled)
          if (hasSearchTool && !disableSearch && !detectedSearchQuery) {
            const searchMatch = accumulatedText.match(/\{\{SEARCH:\s*(.+?)\}\}/);
            if (searchMatch) {
              detectedSearchQuery = searchMatch[1].trim();
            }
          }

          // Extract content from {{RESPONSE:...}} for streaming display
          let displayText = accumulatedText;

          // Try to extract content from partial {{RESPONSE: ...
          const partialResponseMatch = accumulatedText.match(/\{\{RESPONSE:\s*([\s\S]*?)(\}\})?$/);
          if (partialResponseMatch) {
            displayText = partialResponseMatch[1] || '';
          }

          // Clean Text (Remove commands)
          let cleanText = displayText
             .replace(/^\{\{REPLY:\s*(.+?)\}\}/, '')
             .replace(/\{\{MUTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{UNMUTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{NOTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{DELNOTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{CLEARNOTES\}\}/, '')
             .replace(/\{\{SEARCH:\s*(.+?)\}\}/, '')
             .trimStart();

          const replyMatch = displayText.match(/^\{\{REPLY:\s*(.+?)\}\}/);
          if (replyMatch) detectedReplyId = replyMatch[1];

          // Update streaming message
          updateThisSession(s => ({
              ...s,
              messages: s.messages.map(m => m.id === newMessageId ? { ...m, text: cleanText, replyToId: detectedReplyId } : m)
          }));
        }
        if (chunk.usage) accumulatedUsage = chunk.usage;
        if (chunk.reasoningSignature) capturedSignature = chunk.reasoningSignature;
      }

      clearTimeout(timeoutId);

      // EXECUTE ADMIN ACTIONS
      if (detectedAdminAction) {
         if (detectedAdminAction.type === 'NOTE') {
             const newNote = `[${agent.name}]: ${detectedAdminAction.target}`;
             updateThisSession(s => {
                 // Dedup: Don't add if same note already exists
                 const existingNotes = s.adminNotes || [];
                 if (existingNotes.some(n => n.includes(detectedAdminAction?.target || ''))) {
                     return s; // Skip duplicate
                 }
                 return { ...s, adminNotes: [...existingNotes, newNote] };
             });
         }
         else if (detectedAdminAction.type === 'DELNOTE') {
             // Delete notes containing the target text
             const searchText = detectedAdminAction.target.toLowerCase();
             updateThisSession(s => ({
                 ...s,
                 adminNotes: (s.adminNotes || []).filter(n => !n.toLowerCase().includes(searchText))
             }));
         }
         else if (detectedAdminAction.type === 'CLEARNOTES') {
             // Clear all notes
             updateThisSession(s => ({ ...s, adminNotes: [] }));
         }
         else if (detectedAdminAction.type === 'MUTE') {
             // Find target agent by Name
             const targetName = detectedAdminAction.target.trim();
             const targetAgent = agents.find(a => a.name.toLowerCase().includes(targetName.toLowerCase()));

             if (targetAgent && targetAgent.id !== USER_ID) {
                 // PERMISSION CHECK
                 if (targetAgent.role === AgentRole.ADMIN) {
                     // Can't mute another admin
                 } else {
                     const duration = detectedAdminAction.duration || 30;
                     handleMuteAgent(targetAgent.id, duration, agent.name);
                 }
             }
         }
         else if (detectedAdminAction.type === 'UNMUTE') {
             const targetName = detectedAdminAction.target.trim();
             const targetAgent = agents.find(a => a.name.toLowerCase().includes(targetName.toLowerCase()));

             if (targetAgent) {
                 handleUnmuteAgent(targetAgent.id);
             }
         }
      }

      // === DECISION GATE: Extract content from {{RESPONSE:...}} or treat as PASS ===
      // Match {{RESPONSE: content}} - need to handle nested braces carefully
      const responseMatch = accumulatedText.match(/\{\{RESPONSE:\s*([\s\S]*)\}\}$/);
      let extractedContent = '';

      if (responseMatch) {
        // Extract content from inside {{RESPONSE: ... }}
        extractedContent = responseMatch[1].trim();
        // Handle case where content might have trailing }}
        // Count braces to handle nested ones like {{RESPONSE: {{MUTE: x}} text}}
        let braceCount = 0;
        let endIndex = extractedContent.length;
        for (let i = 0; i < extractedContent.length; i++) {
          if (extractedContent[i] === '{' && extractedContent[i+1] === '{') {
            braceCount++;
            i++;
          } else if (extractedContent[i] === '}' && extractedContent[i+1] === '}') {
            braceCount--;
            i++;
            if (braceCount < 0) {
              endIndex = i - 1;
              break;
            }
          }
        }
        extractedContent = extractedContent.substring(0, endIndex).trim();
      }

      // If no valid RESPONSE content found, treat as PASS
      if (!extractedContent || isPass) {
        isPass = true;
      }

      if (isPass) {
        // Agent passed (or invalid format), remove placeholder message and update yield tracking
        updateThisSession(s => ({
            ...s,
            messages: s.messages.filter(m => m.id !== newMessageId),
            yieldedAgentIds: [...(s.yieldedAgentIds || []), agentId],
            // Track message count when first agent yields (for 5-message cooldown)
            yieldedAtCount: (s.yieldedAgentIds || []).length === 0 ? s.messages.length : s.yieldedAtCount
        }));
      } else {
        const cost = calculateCost(accumulatedUsage, provider, agent.modelId);
        setTotalCost(prev => prev + cost);

        // Final text cleanup - use extracted content from RESPONSE
        let finalText = extractedContent
             .replace(/^\{\{REPLY:\s*(.+?)\}\}/, '')
             .replace(/\{\{MUTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{UNMUTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{NOTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{DELNOTE:\s*(.+?)\}\}/, '')
             .replace(/\{\{CLEARNOTES\}\}/, '')
             .replace(/\{\{SEARCH:\s*(.+?)\}\}/, '')
             .trimStart();

        // Update the placeholder message with final data (clear isStreaming)
        updateThisSession(s => ({
            ...s,
            messages: s.messages.map(m => m.id === newMessageId ? {
                ...m,
                text: finalText,
                reasoningText: accumulatedReasoning || undefined,
                reasoningSignature: capturedSignature,
                tokens: accumulatedUsage,
                cost: cost,
                replyToId: detectedReplyId,
                isStreaming: undefined  // 生成完毕，清除占位符标记
            } : m),
            lastUpdated: Date.now()
            // NOTE: Don't clear yieldedAgentIds here - only USER messages should wake up PASSed agents
        }));

        // EXECUTE SEARCH if detected
        if (detectedSearchQuery && agent.searchConfig) {
          try {
            // Execute search
            const searchResponse = await performSearch(detectedSearchQuery, agent.searchConfig);
            const resultText = formatSearchResultsForDisplay(searchResponse);

            // Add search result as a message from this agent
            const searchResultMsg: Message = {
              id: `search-result-${Date.now()}`,
              senderId: agent.id,
              text: resultText,
              timestamp: Date.now(),
              isSearchResult: true,
              searchQuery: detectedSearchQuery
            };

            updateThisSession(s => ({
              ...s,
              messages: [...s.messages, searchResultMsg],
              lastUpdated: Date.now()
            }));

            // Wait a moment, then trigger the same agent again to respond with search results
            // Pass disableSearch=true to prevent infinite loop
            setTimeout(() => {
              triggerAgentReply(agentId, true);
            }, 500);
          } catch (searchError: any) {
            console.error('Search failed:', searchError);
            // Add error message so AI knows search failed
            const errorMsg: Message = {
              id: `search-error-${Date.now()}`,
              senderId: 'SYSTEM',
              text: `[${formatErrorTimestamp()}] 搜索失败: ${searchError.message || '网络请求错误'}`,
              timestamp: Date.now(),
              isSystem: true
            };
            updateThisSession(s => ({
              ...s,
              messages: [...s.messages, errorMsg],
              lastUpdated: Date.now()
            }));
            // Don't re-trigger AI on search failure
          }
        }
      }

    } catch (error: any) {
      console.error(`[${agent.name}] Error caught:`, error.name, error.message, error);

      if (error.name === 'AbortError' || error.message === 'Request aborted') {
          // User cancelled, remove placeholder
          console.log(`[${agent.name}] Request aborted by user - removing placeholder`);
          updateThisSession(s => ({ ...s, messages: s.messages.filter(m => m.id !== newMessageId) }));
      }
      else if (error.message === "Request aborted by timeout") {
          // Timeout already handled in timeout callback
          console.log(`[${agent.name}] Request aborted by timeout - already handled`);
      }
      else {
          // All other errors - show in chat and keep the message
          const errorMsg = error.message || '未知错误';
          console.error(`[${agent.name}] Showing error in chat:`, errorMsg);
          updateThisSession(s => ({
              ...s,
              messages: s.messages.map(m => m.id === newMessageId ? {
                  ...m,
                  text: m.text ? `${m.text}\n\n[${formatErrorTimestamp()}] [错误: ${errorMsg}]` : `[${formatErrorTimestamp()}] [错误: ${errorMsg}]`,
                  isError: true,
                  isStreaming: false
              } : m)
          }));
      }
    } finally {
      clearTimeout(timeoutId);
      pendingTriggerRef.current.delete(agentId); // Clear pending flag
      // Record message count when this agent finished speaking (for cooldown)
      agentLastSpokeAt.current.set(agentId, messages.length);
      setProcessingAgents(prev => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
      });
      abortControllers.current.delete(agentId);
    }
  }, [agents, providers, groups, messages, settings, processingAgents, activeSession.mutedAgentIds, activeSession.groupId, activeSession.summary, activeSession.adminNotes, activeSessionId]);


  // --- USER ACTION ---
  
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);

    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px'; // Max 150px

    const match = val.match(/@(\S*)$/);
    if (match) {
        const query = match[1].toLowerCase();
        setMentionQuery(query);
        setShowMentionPopup(true);
        setSelectedMentionIndex(0);
    } else {
        setShowMentionPopup(false);
    }
  };

  const handleSelectMention = (name: string) => {
    const newVal = inputText.replace(/@(\S*)$/, `@${name} `);
    setInputText(newVal);
    setShowMentionPopup(false);
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionPopup) {
        const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(mentionQuery));
        if (filteredAgents.length === 0) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedMentionIndex(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedMentionIndex(prev => Math.min(filteredAgents.length - 1, prev + 1));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            handleSelectMention(filteredAgents[selectedMentionIndex].name);
        } else if (e.key === 'Escape') {
            setShowMentionPopup(false);
        }
    } else if (e.key === 'Enter' && !e.shiftKey) {
        // Enter to submit, Shift+Enter for new line
        e.preventDefault();
        handleUserSend();
    }
  };

  const handleUserSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() && !attachment) return;

    // Clear mention queue when user sends a new message (fresh start)
    mentionQueueRef.current = [];

    const trimmedText = inputText.trim();

    // 检测 /search 命令
    const searchMatch = trimmedText.match(/^\/search\s+(.+)$/i);
    if (searchMatch) {
      const query = searchMatch[1].trim();

      // 找到第一个配置了搜索且启用的角色
      const searchAgent = agents.find(a =>
        a.searchConfig?.enabled &&
        a.searchConfig?.apiKey &&
        a.isActive !== false
      );

      if (!searchAgent || !searchAgent.searchConfig) {
        // 没有配置搜索的角色
        const errorMsg: Message = {
          id: Date.now().toString(),
          senderId: 'SYSTEM',
          text: `[${formatErrorTimestamp()}] 无法执行搜索：没有配置搜索工具的角色。请在侧边栏的角色设置中启用搜索功能。`,
          timestamp: Date.now(),
          isSystem: true
        };
        updateActiveSession(s => ({
          ...s,
          messages: [...s.messages, errorMsg],
          lastUpdated: Date.now()
        }));
        setInputText('');
        return;
      }

      // 显示搜索中的消息
      const searchingMsg: Message = {
        id: `search-${Date.now()}`,
        senderId: 'SYSTEM',
        text: `🔍 ${searchAgent.name} 正在搜索: "${query}"...`,
        timestamp: Date.now(),
        isSystem: true
      };
      updateActiveSession(s => ({
        ...s,
        messages: [...s.messages, searchingMsg],
        lastUpdated: Date.now()
      }));

      // 执行搜索
      const searchResponse = await performSearch(query, searchAgent.searchConfig);

      // 移除"搜索中"的消息，添加搜索结果
      const resultText = formatSearchResultsForDisplay(searchResponse);
      const contextText = formatSearchResultsForContext(searchResponse);

      const searchResultMsg: Message = {
        id: `search-result-${Date.now()}`,
        senderId: searchAgent.id,
        text: resultText,
        timestamp: Date.now(),
        isSearchResult: true,
        searchQuery: query
      };

      updateActiveSession(s => ({
        ...s,
        messages: s.messages
          .filter(m => m.id !== searchingMsg.id)
          .concat([searchResultMsg]),
        lastUpdated: Date.now(),
        yieldedAgentIds: [],
        yieldedAtCount: undefined
      }));

      setInputText('');
      setShowMentionPopup(false);
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
      }
      return;
    }

    const newMessage: Message = {
      id: Date.now().toString(),
      senderId: USER_ID,
      text: inputText,
      timestamp: Date.now(),
      replyToId: replyToId || undefined,
      attachment: attachment || undefined
    };

    // User message clears the yielded list - all PASSed agents can speak again
    updateActiveSession(s => ({
      ...s,
      messages: [...s.messages, newMessage],
      lastUpdated: Date.now(),
      yieldedAgentIds: [], // Only USER messages wake up PASSed agents
      yieldedAtCount: undefined // Reset cooldown counter
    }));
    setInputText('');
    setReplyToId(null);
    setAttachment(null);
    setShowMentionPopup(false);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsParsingFile(true);
    try {
        const parsedAttachment = await parseFile(file, {
          enabled: settings.compressImages,
          maxSizeMB: settings.maxImageSizeMB
        });
        setAttachment(parsedAttachment);
    } catch (err) {
        console.error("Failed to parse file", err);
        alert("文件解析失败");
    } finally {
        setIsParsingFile(false);
    }

    e.target.value = '';
  };

  // --- DRAG AND DROP ---
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragging to false if we're leaving the container
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    setIsParsingFile(true);
    try {
      const parsedAttachment = await parseFile(file, {
        enabled: settings.compressImages,
        maxSizeMB: settings.maxImageSizeMB
      });
      setAttachment(parsedAttachment);
    } catch (err) {
      console.error("Failed to parse file", err);
      alert("文件解析失败");
    } finally {
      setIsParsingFile(false);
    }
  };

  // --- AUTOPLAY LOOP ---
  useEffect(() => {
    if (!isAutoPlay) {
      // console.log('[AutoPlay] Disabled');
      return;
    }
    // Check both processing and pending to prevent race conditions
    const totalActive = processingAgents.size + pendingTriggerRef.current.size;
    if (!settings.enableConcurrency && totalActive > 0) {
      // console.log('[AutoPlay] Waiting for current agent to finish');
      return;
    }

    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.isError) return;
    if (lastMessage.isStreaming) return;  // Don't trigger while another agent is still streaming

    // Debug: Log mention detection
    if (lastMessage.text.includes('@')) {
      console.log('[AutoPlay] Message with @ detected:', lastMessage.text.substring(0, 100));
    }

    // For system messages, find the actual last speaker to avoid re-triggering them
    // System messages are visible to AI but shouldn't re-trigger the command sender
    const lastNonSystemMessage = [...messages].reverse().find(m => !m.isSystem);
    const lastSpeakerId = lastNonSystemMessage?.senderId || lastMessage.senderId;

    // 5-MESSAGE COOLDOWN: Clear yielded agents after 5 any messages
    if ((activeSession.yieldedAgentIds || []).length > 0 && activeSession.yieldedAtCount !== undefined) {
        const messagesSinceYield = messages.length - activeSession.yieldedAtCount;
        if (messagesSinceYield >= 5) {
            updateActiveSession(s => ({
                ...s,
                yieldedAgentIds: [],
                yieldedAtCount: undefined
            }));
            return; // Let the next cycle pick up the cleared state
        }
    }

    // Message-based cooldown: agents can't be triggered again until N other messages have been sent
    // Minimum 2 messages must pass before the same agent can speak again
    const cooldownMessages = Math.max(2, Math.floor(sessionMembers.length / 2));

    const eligibleAgents = sessionMembers.filter(a => {
        if (!a.providerId || !a.modelId) return false; // Skip unconfigured agents
        if (processingAgents.has(a.id)) return false;
        if (pendingTriggerRef.current.has(a.id)) return false; // Also check pending
        if ((activeSession.mutedAgentIds || []).includes(a.id)) return false;
        if ((activeSession.yieldedAgentIds || []).includes(a.id)) return false;
        if (sessionMembers.length > 1 && a.id === lastSpeakerId) return false;  // Use lastSpeakerId to handle system messages

        // Message-count cooldown: Don't trigger agents until enough messages have passed
        const spokeAtCount = agentLastSpokeAt.current.get(a.id);
        if (spokeAtCount !== undefined && (messages.length - spokeAtCount) < cooldownMessages) return false;

        return true;
    });

    // Debug: Log why chat might be silent
    if (eligibleAgents.length === 0 && sessionMembers.length > 0) {
        console.warn('[AutoPlay] No eligible agents! Reasons:', sessionMembers.map(a => {
            const reasons = [];
            if (!a.providerId || !a.modelId) reasons.push('unconfigured');
            if (processingAgents.has(a.id)) reasons.push('processing');
            if (pendingTriggerRef.current.has(a.id)) reasons.push('pending');
            if ((activeSession.mutedAgentIds || []).includes(a.id)) reasons.push('muted');
            if ((activeSession.yieldedAgentIds || []).includes(a.id)) reasons.push('yielded');
            if (sessionMembers.length > 1 && a.id === lastSpeakerId) reasons.push('lastSpeaker');
            const spokeAt = agentLastSpokeAt.current.get(a.id);
            if (spokeAt !== undefined && (messages.length - spokeAt) < cooldownMessages) reasons.push(`cooldown(${messages.length - spokeAt}/${cooldownMessages})`);
            return `${a.name}: ${reasons.join(', ') || 'unknown'}`;
        }));
    }

    // --- PROCESS MENTION QUEUE ---
    // If there's a queue from multi-mention, process next in queue
    if (mentionQueueRef.current.length > 0) {
        // In concurrency mode, trigger all remaining queue members at once
        if (settings.enableConcurrency) {
            const agentsToTrigger: string[] = [];
            while (mentionQueueRef.current.length > 0) {
                const nextAgentId = mentionQueueRef.current.shift()!;
                const nextAgent = eligibleAgents.find(a => a.id === nextAgentId);
                if (nextAgent) {
                    agentsToTrigger.push(nextAgent.id);
                }
            }
            if (agentsToTrigger.length > 0) {
                const timeoutId = setTimeout(() => {
                    agentsToTrigger.forEach(id => triggerAgentReply(id));
                }, settings.breathingTime);
                return () => clearTimeout(timeoutId);
            }
            // If no agents were eligible, fall through to normal selection
        } else {
            // Sequential mode: trigger one at a time, skip ineligible agents
            while (mentionQueueRef.current.length > 0) {
                const nextAgentId = mentionQueueRef.current.shift()!;
                const nextAgent = eligibleAgents.find(a => a.id === nextAgentId);
                if (nextAgent) {
                    const timeoutId = setTimeout(() => {
                        triggerAgentReply(nextAgent.id);
                    }, settings.breathingTime);
                    return () => clearTimeout(timeoutId);
                }
                // Agent not eligible, continue to next in queue
            }
            // Queue exhausted with no eligible agents, fall through to normal selection
        }
    }

    if (eligibleAgents.length === 0) return;

    // --- @MENTION PRIORITY: Check for @全体成员 or multiple @mentions ---
    const lastTextLower = lastMessage.text.toLowerCase();
    let selectedAgent = null;
    let agentsToQueue: typeof eligibleAgents = [];

    // Check for @全体成员
    if (lastTextLower.includes('@全体成员') || lastTextLower.includes('@all')) {
        // Shuffle all eligible agents randomly
        agentsToQueue = [...eligibleAgents].sort(() => Math.random() - 0.5);
        console.log('[Mention] @全体成员 detected, queuing', agentsToQueue.length, 'agents:', agentsToQueue.map(a => a.name));
    } else {
        // Extract all @mentions in order
        const mentionMatches = lastMessage.text.matchAll(/@(\S+)/g);
        const mentionedNames: string[] = [];
        for (const match of mentionMatches) {
            mentionedNames.push(match[1].toLowerCase());
        }

        if (mentionedNames.length > 0) {
            // Find agents matching each mention in order (no duplicates)
            const seenIds = new Set<string>();
            for (const mentionName of mentionedNames) {
                const matchedAgent = eligibleAgents.find(a => {
                    if (seenIds.has(a.id)) return false;
                    const nameLower = a.name.toLowerCase();
                    return nameLower === mentionName || nameLower.startsWith(mentionName);
                });
                if (matchedAgent && !seenIds.has(matchedAgent.id)) {
                    agentsToQueue.push(matchedAgent);
                    seenIds.add(matchedAgent.id);
                }
            }
        }
    }

    // If we have multiple agents to trigger
    if (agentsToQueue.length > 1) {
        if (settings.enableConcurrency) {
            // Concurrency mode: trigger all at once
            const timeoutId = setTimeout(() => {
                agentsToQueue.forEach(a => triggerAgentReply(a.id));
            }, settings.breathingTime);
            return () => clearTimeout(timeoutId);
        } else {
            // Sequential mode: put all except first into queue
            mentionQueueRef.current = agentsToQueue.slice(1).map(a => a.id);
            selectedAgent = agentsToQueue[0];
        }
    } else if (agentsToQueue.length === 1) {
        selectedAgent = agentsToQueue[0];
    } else {
        // No mention, pick randomly
        selectedAgent = eligibleAgents[Math.floor(Math.random() * eligibleAgents.length)];
    }

    if (selectedAgent) {
        const timeoutId = setTimeout(() => {
           triggerAgentReply(selectedAgent.id);
        }, settings.breathingTime);
        return () => clearTimeout(timeoutId);
    }

  }, [isAutoPlay, messages, agents, processingAgents, triggerAgentReply, settings.breathingTime, settings.enableConcurrency, activeSession.mutedAgentIds, activeSession.yieldedAgentIds, activeSession.yieldedAtCount]);


  if (!isDbLoaded) {
      return <div className="flex h-screen w-full items-center justify-center bg-gray-50 dark:bg-zinc-900 text-gray-500 dark:text-gray-400">
          <RefreshCw className="animate-spin mr-2"/> 正在从本地数据库恢复数据...
      </div>;
  }

  // Filter agents for mention popup (show current session members)
  const mentionFilteredAgents = showMentionPopup
    ? sessionMembers.filter(a => a.name.toLowerCase().includes(mentionQuery))
    : [];

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-gray-100 font-sans selection:bg-gray-200 dark:selection:bg-zinc-700">
      
      {/* Backdrop for mobile sidebars */}
      {(isSidebarOpen || isRightSidebarOpen) && (
        <div
          className="fixed inset-0 bg-black/30 z-40 sm:hidden backdrop-blur-sm"
          onClick={() => { setIsSidebarOpen(false); setIsRightSidebarOpen(false); }}
        />
      )}

      {/* Left Sidebar (Config & Sessions) */}
      <Sidebar
        agents={agents} setAgents={setAgents}
        providers={providers} setProviders={setProviders}
        settings={settings} setSettings={setSettings}
        groups={groups} activeGroupId={activeGroupId}
        onCreateGroup={handleCreateGroup} onSwitchGroup={handleSwitchGroup}
        onDeleteGroup={handleDeleteGroup} onRenameGroup={handleRenameGroup}
        onUpdateGroupScenario={handleUpdateGroupScenario}
        onUpdateGroupMemoryConfig={handleUpdateGroupMemoryConfig}
        sessions={sessions} activeSessionId={activeSessionId}
        onCreateSession={handleCreateSession} onSwitchSession={setActiveSessionId}
        onDeleteSession={handleDeleteSession} onRenameSession={handleRenameSession}
        onUpdateSummary={handleUpdateSummary}
        isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)}
      />

      {/* Right Sidebar (Group Management) */}
      <RightSidebar
        isOpen={isRightSidebarOpen} onClose={() => setIsRightSidebarOpen(false)}
        agents={sessionMembers}
        inactiveAgents={agents.filter(a => a.providerId && a.modelId && !sessionMembers.some(m => m.id === a.id))}
        adminIds={activeGroup?.adminIds || []}
        mutedAgents={activeSession.mutedAgents || []}
        onRemoveAgent={handleRemoveAgent}
        onMuteAgent={handleMuteAgent}
        onUnmuteAgent={handleUnmuteAgent}
        onActivateAgent={handleActivateAgent}
        onToggleAdmin={handleToggleAdmin}
        userName={settings.userName || 'User'}
      />

      {/* Stats Panel */}
      <StatsPanel
        isOpen={isStatsOpen}
        onClose={() => setIsStatsOpen(false)}
        messages={messages}
        agents={agents}
        userProfile={settings}
      />

      {/* Main Chat Area */}
      <div
        className="flex-1 flex flex-col h-full relative z-0 w-full transition-all duration-300"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag Overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center backdrop-blur-sm pointer-events-none">
            <div className="bg-white px-6 py-4 rounded-xl shadow-lg border border-blue-200 flex items-center gap-3">
              <Paperclip size={24} className="text-blue-500" />
              <span className="text-blue-600 font-medium">松开以上传文件</span>
            </div>
          </div>
        )}
        
        {/* Header */}
        <header className="h-14 bg-white/80 dark:bg-zinc-800/80 backdrop-blur-md border-b border-gray-200 dark:border-zinc-700 flex items-center justify-between px-2 sm:px-6 z-20 sticky top-0 shadow-sm">
          <div className="flex items-center gap-2 sm:gap-4">
             <button onClick={() => setIsSidebarOpen(true)} className="p-2.5 hover:bg-gray-100 dark:hover:bg-zinc-700 rounded-lg transition-colors text-gray-600 dark:text-gray-300">
               <Menu size={22} />
             </button>
             {/* LOGO AND TITLE */}
             <div className="flex items-center gap-1.5 sm:gap-2">
                 <img src="/logo.png" alt="Logo" className="w-6 h-6 sm:w-8 sm:h-8 object-contain" onError={(e) => e.currentTarget.style.display = 'none'} />
                 <h1 className="font-bold text-sm sm:text-base text-gray-900 dark:text-white flex items-center gap-1 sm:gap-2">
                    <span className="hidden sm:inline">AI群聊观察会</span>
                    <span className="sm:hidden">群聊</span>
                    <span className="hidden min-[400px]:inline text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-zinc-700 rounded text-gray-500 dark:text-gray-400 font-medium">V5</span>
                 </h1>
             </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-3">
            {/* Cost - hidden on mobile */}
            <div className="hidden sm:flex items-center gap-1 bg-gray-50 dark:bg-zinc-800 px-3 py-1.5 rounded-md border border-gray-100 dark:border-zinc-700">
               <DollarSign size={14} className="text-gray-400"/>
               <span className="text-xs font-mono text-gray-600 dark:text-gray-300 font-medium">${totalCost.toFixed(6)}</span>
            </div>

            <div className="hidden sm:block h-4 w-px bg-gray-200 dark:bg-zinc-700 mx-1"></div>

            <button
               onClick={() => setIsStatsOpen(true)}
               className="p-2.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg transition-colors"
               title="会话统计"
            >
              <BarChart3 size={20} />
            </button>

            <button
               onClick={handleClearMessages}
               className="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
               title="清空记录"
            >
              <Trash size={20} />
            </button>

            {/* Play/Pause - simplified on mobile */}
            <button
              onClick={isAutoPlay ? handleStopAll : () => setIsAutoPlay(true)}
              className={`flex items-center gap-1 sm:gap-2 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide transition-all
                ${isAutoPlay
                  ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800 animate-pulse'
                  : 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-black dark:hover:bg-gray-100 shadow-sm'
                }
              `}
            >
              {isAutoPlay ? <><Pause size={16}/> <span className="hidden sm:inline">暂停</span></> : <><Play size={16}/> <span className="hidden sm:inline">开始</span></>}
            </button>

            <div className="hidden sm:block h-4 w-px bg-gray-200 dark:bg-zinc-700 mx-1"></div>

            {/* New session - hidden on mobile, accessible via sidebar */}
            <button
               onClick={() => handleCreateSession(activeGroupId)}
               className="hidden sm:flex p-2 items-center justify-center bg-transparent dark:bg-white text-gray-600 dark:text-zinc-900 hover:bg-gray-100 dark:hover:bg-gray-100 rounded-lg transition-colors"
               title="新建对话"
            >
              <Plus size={20} />
            </button>

            <button
               onClick={() => setIsRightSidebarOpen(true)}
               className="p-2.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-700 rounded-lg transition-colors relative"
               title="成员管理"
            >
              <Users size={22} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-emerald-500 rounded-full ring-2 ring-white dark:ring-zinc-800"></span>
            </button>
          </div>
        </header>

        {/* Messages List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-gray-50/50 dark:bg-zinc-900/50" ref={scrollContainerRef}>
           {messages.length === 0 && (
             <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <div className="w-16 h-16 bg-white dark:bg-zinc-800 rounded-2xl border border-gray-200 dark:border-zinc-700 flex items-center justify-center mb-4 shadow-sm">
                  <MessageSquare size={32} className="text-gray-300 dark:text-gray-600" />
                </div>
                <p className="text-gray-500 dark:text-gray-400 font-medium">{activeSession.name} 暂无消息</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">请在左侧侧边栏配置模型和剧本，或直接开始聊天。</p>
             </div>
           )}
           
           <div className="max-w-4xl mx-auto w-full">
             {messages.map((msg) => (
               <ChatBubble
                  key={msg.id}
                  message={msg}
                  sender={agents.find(a => a.id === msg.senderId)}
                  allAgents={sessionMembers}
                  userProfile={settings}
                  replyToMessage={msg.replyToId ? messages.find(m => m.id === msg.replyToId) : undefined}
                  onReply={(targetMsg) => setReplyToId(targetMsg.id)}
                  onMention={(name) => setInputText(prev => `${prev}@${name} `)}
                  isStreaming={processingAgents.has(msg.senderId)}
               />
             ))}
             
             <div ref={messagesEndRef} />
           </div>
        </div>

        {/* Scroll to Bottom Button - positioned relative to main chat area */}
        {showScrollButton && (
          <button
            onClick={() => {
              scrollToBottom();
              setShowScrollButton(false);
              setIsNearBottom(true);
            }}
            className="absolute bottom-28 right-6 bg-zinc-900 dark:bg-zinc-700 text-white p-3 rounded-full shadow-lg hover:bg-black dark:hover:bg-zinc-600 transition-all hover:scale-105 z-30 animate-in fade-in slide-in-from-bottom-2 duration-200"
            title="回到底部"
          >
            <ArrowDown size={20} />
          </button>
        )}

        {/* Input Area */}
        <div className="bg-transparent p-4 pb-4 mb-2 z-20 pb-safe">
          <div className="max-w-4xl mx-auto w-full space-y-3 relative">
            
            {/* Quick Trigger Buttons (Manual) - Only show current session's configured members */}
            {!isAutoPlay && sessionMembers.filter(a => a.providerId && a.modelId).length > 0 && (
               <div className="flex gap-2 pb-2 overflow-x-auto scrollbar-hide flex-nowrap sm:flex-wrap sm:overflow-visible">
                  {sessionMembers.filter(a => a.providerId && a.modelId).map(agent => {
                    const isMuted = (activeSession.mutedAgentIds || []).includes(agent.id);
                    const isYielded = (activeSession.yieldedAgentIds || []).includes(agent.id);
                    const isProcessing = processingAgents.has(agent.id);

                    // Logic check: Can we click this?
                    // If concurrency OFF and ANYONE processing -> disabled
                    // If concurrency ON -> only disabled if THIS agent is processing
                    const canClick = settings.enableConcurrency ? !isProcessing : processingAgents.size === 0;

                    return (
                      <button
                        key={agent.id}
                        onClick={() => triggerAgentReply(agent.id)}
                        disabled={!canClick || isMuted}
                        className={`
                          flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all border shrink-0
                          ${isProcessing ? 'opacity-50 cursor-not-allowed border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 animate-pulse' :
                            isMuted ? 'opacity-40 bg-gray-100 dark:bg-zinc-700 border-gray-200 dark:border-zinc-600 cursor-not-allowed line-through' :
                            isYielded ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50' :
                            'border-gray-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 hover:border-gray-300 dark:hover:border-zinc-500 hover:bg-gray-50 dark:hover:bg-zinc-600 text-gray-700 dark:text-gray-200 shadow-sm hover:shadow'
                          }
                          ${!canClick && !isProcessing && !isMuted ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                      >
                        <img src={agent.avatar} className="w-3.5 h-3.5 rounded-full object-contain bg-white border border-gray-100 dark:border-zinc-600"/>
                        {agent.name} {isYielded && '(放弃)'}
                      </button>
                    );
                  })}
               </div>
            )}

            {/* Reply Preview */}
            {replyToId && (
              <div className="flex items-center justify-between bg-gray-50 dark:bg-zinc-700 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-600 text-xs text-gray-600 dark:text-gray-300">
                 <div className="flex items-center gap-2 truncate">
                    <div className="font-bold text-zinc-800 dark:text-white">回复</div>
                    <div className="truncate max-w-[300px]">{messages.find(m => m.id === replyToId)?.text}</div>
                 </div>
                 <button onClick={() => setReplyToId(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X size={14} /></button>
              </div>
            )}

            {/* Attachment Preview */}
            {attachment && (
              <div className="flex items-center justify-between bg-gray-50 dark:bg-zinc-700 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-600 text-xs text-gray-600 dark:text-gray-300">
                 <div className="flex items-center gap-2 truncate">
                    {attachment.type === 'image' ? <ImageIcon size={14} className="text-blue-500" /> : <FileText size={14} className="text-orange-500" />}
                    <div className="font-bold text-zinc-800 dark:text-white">
                      {attachment.type === 'image' ? '图片已就绪' : `文档: ${attachment.fileName}`}
                    </div>
                 </div>
                 <button onClick={() => setAttachment(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X size={14} /></button>
              </div>
            )}

            {/* Loading Indicator for File Parsing */}
            {isParsingFile && (
               <div className="text-xs text-blue-500 flex items-center gap-1">
                 <RefreshCw size={10} className="animate-spin" /> 解析文件中...
               </div>
            )}

            {/* MENTION POPUP */}
            {showMentionPopup && (mentionFilteredAgents.length > 0 || mentionQuery === '' || '全体成员'.includes(mentionQuery)) && (
                <div className="absolute bottom-full left-4 mb-2 bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 shadow-xl rounded-xl w-64 max-h-48 overflow-y-auto z-50">
                   <div className="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase border-b border-gray-50 dark:border-zinc-700 bg-gray-50/50 dark:bg-zinc-800">
                       提及成员 (@)
                   </div>
                   {/* @全体成员 option */}
                   {(mentionQuery === '' || '全体成员'.includes(mentionQuery) || 'all'.includes(mentionQuery.toLowerCase())) && (
                       <button
                           onClick={() => handleSelectMention('全体成员')}
                           className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors border-b border-gray-50 dark:border-zinc-700
                               ${selectedMentionIndex === 0 && mentionFilteredAgents.length === 0 ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-white' : 'text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-zinc-700'}
                           `}
                       >
                           <Users size={16} className="text-blue-500" />
                           <span className="font-medium">全体成员</span>
                           <span className="text-xs text-gray-400 ml-auto">随机顺序</span>
                       </button>
                   )}
                   {mentionFilteredAgents.map((agent, index) => (
                       <button
                           key={agent.id}
                           onClick={() => handleSelectMention(agent.name)}
                           className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors
                               ${index === selectedMentionIndex ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-white' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700'}
                           `}
                       >
                           <img src={agent.avatar} className="w-5 h-5 rounded-full border border-gray-100 dark:border-zinc-600 object-contain"/>
                           <span>{agent.name}</span>
                       </button>
                   ))}
                </div>
            )}

            <form onSubmit={handleUserSend} className="relative flex items-end">
              <input type="file" ref={fileInputRef} className="hidden" accept="image/*,.pdf,.doc,.docx,.txt,.md,.js,.ts,.py,.json" onChange={handleFileSelect} />
              <button type="button" onClick={() => fileInputRef.current?.click()} className="absolute left-3 bottom-4 text-gray-400 hover:text-gray-300 dark:hover:text-gray-200 transition-colors" title="上传文件 (图片/文档)">
                <Paperclip size={18} />
              </button>

              <textarea
                ref={inputRef}
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                placeholder={processingAgents.size > 0 ? "AI正在输入中..." : `在 "${activeSession.name}" 发言... (Enter发送, Shift+Enter换行)`}
                rows={1}
                className="w-full bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded-xl px-4 py-3.5 pl-10 pr-14 text-gray-900 dark:text-white focus:outline-none focus:bg-white dark:focus:bg-zinc-600 focus:ring-2 focus:ring-zinc-200 dark:focus:ring-zinc-500 focus:border-transparent transition-all placeholder-gray-400 dark:placeholder-gray-500 shadow-inner resize-none overflow-hidden"
                style={{ minHeight: '52px', maxHeight: '150px' }}
              />
              <button type="submit" disabled={(!inputText.trim() && !attachment) || isParsingFile} className="absolute right-2 bottom-2 p-2 bg-zinc-900 dark:bg-white rounded-lg text-white dark:text-zinc-900 hover:bg-black dark:hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-sm">
                <Send size={18} />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
