
import React, { useState, useRef, useEffect } from 'react';
import { Agent, ApiProvider, GlobalSettings, AgentType, ChatSession, ChatGroup, AgentRole, GeminiMode, SearchEngine, TTSEngineType, TTSVoice, TTSProvider, UserProfile } from '../types';
import { Trash2, Plus, X, Server, DollarSign, Clock, Eye, EyeOff, MessageSquare, GripVertical, RefreshCw, Sliders, BrainCircuit, User, Upload, Zap, ShieldAlert, Shield, BookOpen, Edit3, ScanEye, Moon, Sun, ChevronDown, ChevronRight, Power, PowerOff, Save, RotateCcw, Search, FolderOpen, Folder, Image as ImageIcon, Volume2, Mic, Dices, Sparkles } from 'lucide-react';
import { getAvatarForModel, AVATAR_MAP } from '../constants';
import { fetchRemoteModels } from '../services/modelFetcher';
import { getBrowserVoices, DEFAULT_TTS_PROVIDERS } from '../services/ttsService';

// TTS Settings Panel Component
const TTSSettingsPanel: React.FC<{
  settings: GlobalSettings;
  setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>;
  agents: Agent[];
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  ttsProviders: TTSProvider[];
  setTTSProviders: React.Dispatch<React.SetStateAction<TTSProvider[]>>;
}> = ({ settings, setSettings, agents, setAgents, ttsProviders, setTTSProviders }) => {
  const [browserVoices, setBrowserVoices] = useState<TTSVoice[]>([]);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [newVoiceName, setNewVoiceName] = useState('');
  const [newVoiceId, setNewVoiceId] = useState('');

  // Load browser voices on mount
  useEffect(() => {
    getBrowserVoices().then(voices => {
      setBrowserVoices(voices);
      // Update browser provider with actual voices
      setTTSProviders(prev => prev.map(p =>
        p.type === 'browser' ? { ...p, voices } : p
      ));
    });
  }, []);

  const ttsSettings = settings.ttsSettings || {
    enabled: false,
    activeProviderId: 'browser',
    rate: 1.0,
    volume: 1.0,
    autoPlayNewMessages: false
  };

  const updateTTSSettings = (updates: Partial<typeof ttsSettings>) => {
    setSettings({
      ...settings,
      ttsSettings: { ...ttsSettings, ...updates }
    });
  };

  const activeProvider = ttsProviders.find(p => p.id === ttsSettings.activeProviderId) || ttsProviders[0];
  const availableVoices = activeProvider?.type === 'browser' ? browserVoices : (activeProvider?.voices || []);

  // Update provider
  const updateProvider = (providerId: string, updates: Partial<TTSProvider>) => {
    setTTSProviders(prev => prev.map(p =>
      p.id === providerId ? { ...p, ...updates } : p
    ));
  };

  // Add custom voice to provider
  const handleAddVoice = (providerId: string) => {
    if (!newVoiceName.trim() || !newVoiceId.trim()) return;
    setTTSProviders(prev => prev.map(p =>
      p.id === providerId
        ? { ...p, voices: [...p.voices, { id: newVoiceId.trim(), name: newVoiceName.trim(), isCustom: true }] }
        : p
    ));
    setNewVoiceName('');
    setNewVoiceId('');
  };

  // Remove custom voice
  const handleRemoveVoice = (providerId: string, voiceId: string) => {
    setTTSProviders(prev => prev.map(p =>
      p.id === providerId
        ? { ...p, voices: p.voices.filter(v => v.id !== voiceId) }
        : p
    ));
  };

  // Auto-assign voices to agents
  const handleAutoAssignVoices = () => {
    if (availableVoices.length === 0) return;
    const updatedAgents = agents.map((agent, idx) => ({
      ...agent,
      voiceId: availableVoices[idx % availableVoices.length].id,
      voiceProviderId: activeProvider.id
    }));
    setAgents(updatedAgents);
  };

  return (
    <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
      <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
        <Volume2 size={16}/> 语音朗读 (TTS)
      </h3>
      <div className="space-y-4">
        {/* Enable TTS */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600 dark:text-gray-300">启用语音朗读</span>
          <input
            type="checkbox"
            className="accent-zinc-900"
            checked={ttsSettings.enabled}
            onChange={(e) => updateTTSSettings({ enabled: e.target.checked })}
          />
        </div>

        {ttsSettings.enabled && (
          <>
            {/* Provider Selection */}
            <div>
              <label className="text-xs text-gray-600 dark:text-gray-300 block mb-1">TTS 服务商</label>
              <select
                className="w-full text-xs p-2 border border-gray-200 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                value={ttsSettings.activeProviderId || 'browser'}
                onChange={(e) => updateTTSSettings({ activeProviderId: e.target.value })}
              >
                {ttsProviders.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.pricePer1MChars ? `($${p.pricePer1MChars}/1M字符)` : '(免费)'}
                  </option>
                ))}
              </select>
            </div>

            {/* Provider Config */}
            {activeProvider && activeProvider.type !== 'browser' && (
              <div className="bg-gray-50 dark:bg-zinc-700/50 p-3 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{activeProvider.name} 配置</span>
                  {activeProvider.freeQuota && (
                    <span className="text-[10px] text-green-600 dark:text-green-400">免费额度: {activeProvider.freeQuota}</span>
                  )}
                </div>

                {/* API Key */}
                <div>
                  <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-1">API Key</label>
                  <input
                    type="password"
                    className="w-full text-xs p-2 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                    placeholder={activeProvider.type === 'minimax' ? 'group_id:api_key' : 'API Key...'}
                    value={activeProvider.apiKey || ''}
                    onChange={(e) => updateProvider(activeProvider.id, { apiKey: e.target.value })}
                  />
                </div>

                {/* Base URL (optional) */}
                <div>
                  <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-1">API 地址 (可选)</label>
                  <input
                    type="text"
                    className="w-full text-xs p-2 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                    placeholder={activeProvider.baseUrl}
                    value={activeProvider.baseUrl || ''}
                    onChange={(e) => updateProvider(activeProvider.id, { baseUrl: e.target.value })}
                  />
                </div>

                {/* Price */}
                <div>
                  <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-1">价格 ($/百万字符)</label>
                  <input
                    type="number"
                    className="w-full text-xs p-2 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                    value={activeProvider.pricePer1MChars || 0}
                    onChange={(e) => updateProvider(activeProvider.id, { pricePer1MChars: parseFloat(e.target.value) || 0 })}
                  />
                </div>

                {/* Voice Management */}
                <div className="border-t border-gray-200 dark:border-zinc-600 pt-2">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedProvider(expandedProvider === activeProvider.id ? null : activeProvider.id)}
                  >
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">
                      音色管理 ({activeProvider.voices.length} 个)
                    </span>
                    {expandedProvider === activeProvider.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </div>

                  {expandedProvider === activeProvider.id && (
                    <div className="mt-2 space-y-2">
                      {/* Existing voices */}
                      <div className="max-h-32 overflow-y-auto space-y-1">
                        {activeProvider.voices.map(v => (
                          <div key={v.id} className="flex items-center justify-between text-[10px] bg-white dark:bg-zinc-700 p-1.5 rounded">
                            <span className="text-gray-700 dark:text-gray-300 truncate flex-1">{v.name}</span>
                            <span className="text-gray-400 mx-2 font-mono">{v.id}</span>
                            {v.isCustom && (
                              <button
                                onClick={() => handleRemoveVoice(activeProvider.id, v.id)}
                                className="text-red-400 hover:text-red-600"
                              >
                                <X size={10} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Add new voice */}
                      <div className="flex gap-1">
                        <input
                          type="text"
                          className="flex-1 text-[10px] p-1.5 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                          placeholder="音色名称"
                          value={newVoiceName}
                          onChange={(e) => setNewVoiceName(e.target.value)}
                        />
                        <input
                          type="text"
                          className="flex-1 text-[10px] p-1.5 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                          placeholder="Voice ID"
                          value={newVoiceId}
                          onChange={(e) => setNewVoiceId(e.target.value)}
                        />
                        <button
                          onClick={() => handleAddVoice(activeProvider.id)}
                          className="px-2 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded text-[10px]"
                        >
                          <Plus size={10} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Speech Rate */}
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-600 dark:text-gray-300">语速</span>
                <span className="font-mono text-gray-500 dark:text-gray-400">{ttsSettings.rate.toFixed(1)}x</span>
              </div>
              <input
                type="range" min="0.5" max="2.0" step="0.1"
                className="w-full accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                value={ttsSettings.rate}
                onChange={(e) => updateTTSSettings({ rate: parseFloat(e.target.value) })}
              />
            </div>

            {/* Volume */}
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-600 dark:text-gray-300">音量</span>
                <span className="font-mono text-gray-500 dark:text-gray-400">{Math.round(ttsSettings.volume * 100)}%</span>
              </div>
              <input
                type="range" min="0" max="1" step="0.1"
                className="w-full accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                value={ttsSettings.volume}
                onChange={(e) => updateTTSSettings({ volume: parseFloat(e.target.value) })}
              />
            </div>

            {/* Auto-assign voices button */}
            <div>
              <button
                onClick={handleAutoAssignVoices}
                disabled={availableVoices.length === 0}
                className="w-full text-xs py-2 px-3 bg-gray-100 dark:bg-zinc-700 hover:bg-gray-200 dark:hover:bg-zinc-600 rounded-lg transition-colors disabled:opacity-50"
              >
                🎲 自动为 {agents.length} 个角色分配不同音色
              </button>
              <p className="text-[10px] text-gray-400 mt-1">
                {availableVoices.length} 种音色可用
              </p>
            </div>

            {/* Agent Voice Assignment */}
            <div className="border-t border-gray-200 dark:border-zinc-600 pt-3">
              <label className="text-xs text-gray-600 dark:text-gray-300 block mb-2">角色音色设置</label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {agents.map(agent => (
                  <div key={agent.id} className="flex items-center gap-2">
                    <img src={agent.avatar} alt="" className="w-6 h-6 rounded-full object-contain bg-white" />
                    <span className="text-xs text-gray-700 dark:text-gray-300 flex-shrink-0 w-20 truncate">{agent.name}</span>
                    <select
                      className="flex-1 text-xs p-1 border border-gray-200 dark:border-zinc-600 rounded bg-white dark:bg-zinc-700 text-gray-900 dark:text-white"
                      value={agent.voiceId || ''}
                      onChange={(e) => {
                        setAgents(prev => prev.map(a =>
                          a.id === agent.id
                            ? { ...a, voiceId: e.target.value, voiceProviderId: activeProvider.id }
                            : a
                        ));
                      }}
                    >
                      <option value="">自动分配</option>
                      {availableVoices.map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

interface SidebarProps {
  agents: Agent[];
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  providers: ApiProvider[];
  setProviders: React.Dispatch<React.SetStateAction<ApiProvider[]>>;
  settings: GlobalSettings;
  setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>;
  // TTS Providers
  ttsProviders: TTSProvider[];
  setTTSProviders: React.Dispatch<React.SetStateAction<TTSProvider[]>>;
  // 群组相关
  groups: ChatGroup[];
  activeGroupId: string;
  onCreateGroup: () => void;
  onSwitchGroup: (id: string) => void;
  onDeleteGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onUpdateGroupScenario: (id: string, scenario: string) => void;
  onUpdateGroupMemoryConfig: (groupId: string, updates: any) => void;
  onUpdateGroupEntertainmentConfig: (groupId: string, updates: any) => void;
  // 会话相关
  sessions: ChatSession[];
  activeSessionId: string;
  onCreateSession: (groupId: string) => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  // Memory
  onUpdateSummary: (sessionId: string, summary: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  agents, setAgents,
  providers, setProviders,
  settings, setSettings,
  ttsProviders, setTTSProviders,
  groups, activeGroupId,
  onCreateGroup, onSwitchGroup, onDeleteGroup, onRenameGroup, onUpdateGroupScenario, onUpdateGroupMemoryConfig, onUpdateGroupEntertainmentConfig,
  sessions, activeSessionId,
  onCreateSession, onSwitchSession, onDeleteSession, onRenameSession,
  onUpdateSummary,
  isOpen, onClose
}) => {
  const [activeTab, setActiveTab] = useState<'agents' | 'providers' | 'settings' | 'sessions'>('sessions');
  const [isFetching, setIsFetching] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const agentAvatarInputRef = useRef<HTMLInputElement>(null);
  const [editingAgentAvatar, setEditingAgentAvatar] = useState<string | null>(null);

  // Agent card collapse state
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());

  // User profile editing state
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  // Draft state for editing agents (changes don't apply until saved)
  const [draftAgents, setDraftAgents] = useState<Record<string, Agent>>({});

  // Get draft or original agent data
  const getAgentData = (agentId: string): Agent | undefined => {
    return draftAgents[agentId] || agents.find(a => a.id === agentId);
  };

  // Check if agent has unsaved changes
  const hasUnsavedChanges = (agentId: string): boolean => {
    return !!draftAgents[agentId];
  };

  // Update draft agent
  const updateDraftAgent = (id: string, updates: Partial<Agent>) => {
    const currentData = getAgentData(id);
    if (!currentData) return;

    let updatedAgent = { ...currentData, ...updates };

    // Smart name/avatar sync logic (same as before)
    if (updates.modelId && updates.modelId !== currentData.modelId) {
      const oldProvider = providers.find(p => p.id === currentData.providerId);
      const oldModelDef = oldProvider?.models.find(m => m.id === currentData.modelId);

      const isDefaultName =
        currentData.name === '新角色' ||
        currentData.name === '' ||
        currentData.name === currentData.modelId ||
        (oldModelDef && currentData.name === oldModelDef.name);

      if (isDefaultName) {
        const targetProviderId = updates.providerId || currentData.providerId;
        const targetProvider = providers.find(p => p.id === targetProviderId);
        const newModelDef = targetProvider?.models.find(m => m.id === updates.modelId);

        if (newModelDef) {
          updatedAgent.name = newModelDef.name || newModelDef.id;
        }
      }
    }

    // Avatar update logic
    if ((updates.modelId || updates.providerId) && !currentData.avatar.startsWith('data:')) {
      const targetProviderId = updates.providerId || currentData.providerId;
      const targetModelId = updates.modelId || currentData.modelId;
      const p = providers.find(p => p.id === targetProviderId);
      if (p) updatedAgent.avatar = getAvatarForModel(targetModelId, p.name);
    }

    setDraftAgents(prev => ({ ...prev, [id]: updatedAgent }));
  };

  // Update draft agent config
  const updateDraftAgentConfig = (id: string, updates: Partial<Agent['config']>) => {
    const currentData = getAgentData(id);
    if (!currentData) return;
    setDraftAgents(prev => ({
      ...prev,
      [id]: { ...currentData, config: { ...currentData.config, ...updates } }
    }));
  };

  // Save draft to actual agents
  const saveDraftAgent = (id: string) => {
    const draft = draftAgents[id];
    if (!draft) return;
    setAgents(prev => prev.map(a => a.id === id ? draft : a));
    setDraftAgents(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Discard draft changes
  const discardDraftAgent = (id: string) => {
    setDraftAgents(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Initialize draft when expanding card
  const toggleAgentCollapse = (id: string) => {
    setCollapsedAgents(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Initialize draft when expanding
        const agent = agents.find(a => a.id === id);
        if (agent && !draftAgents[id]) {
          setDraftAgents(d => ({ ...d, [id]: { ...agent } }));
        }
      } else {
        next.add(id);
        // Optionally discard draft when collapsing (user can choose to save first)
      }
      return next;
    });
  };

  // Drag and drop state
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const handleDragStart = (e: React.DragEvent, agentId: string) => {
    setDraggedAgentId(agentId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (e: React.DragEvent, targetAgentId: string) => {
    e.preventDefault();
    if (!draggedAgentId || draggedAgentId === targetAgentId) return;

    const draggedIdx = agents.findIndex(a => a.id === draggedAgentId);
    const targetIdx = agents.findIndex(a => a.id === targetAgentId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    const newAgents = [...agents];
    const [dragged] = newAgents.splice(draggedIdx, 1);
    newAgents.splice(targetIdx, 0, dragged);
    setAgents(newAgents);
    setDraggedAgentId(null);
  };
  const handleDragEnd = () => setDraggedAgentId(null);
  
  // -- Agent Management --
  const handleAddAgent = () => {
    // Create blank agent without provider/model pre-selected
    const newAgent: Agent = {
      id: Date.now().toString(),
      name: '',
      avatar: AVATAR_MAP.default,
      providerId: '',
      modelId: '',
      systemPrompt: '你是一个有用的助手。',
      color: 'bg-gray-600',
      config: {
        temperature: 0.7,
        maxTokens: 2000,
        enableReasoning: false,
        reasoningBudget: 0
      },
      role: AgentRole.MEMBER,
      isActive: false // New agents start inactive until configured
    };
    setAgents([newAgent, ...agents]); // Add new agent at the beginning
  };

  // Check if agent is properly configured
  const isAgentConfigured = (agent: Agent) => {
    return agent.providerId && agent.modelId;
  };

  const updateAgent = (id: string, updates: Partial<Agent>) => {
    setAgents(prev => prev.map(a => {
        if (a.id !== id) return a;
        
        let updatedAgent = { ...a, ...updates };
        
        // --- Smart Name Sync Logic ---
        if (updates.modelId && updates.modelId !== a.modelId) {
             const oldProvider = providers.find(p => p.id === a.providerId);
             const oldModelDef = oldProvider?.models.find(m => m.id === a.modelId);
             
             const isDefaultName = 
                a.name === '新角色' || 
                a.name === a.modelId || 
                (oldModelDef && a.name === oldModelDef.name);

             if (isDefaultName) {
                const targetProviderId = updates.providerId || a.providerId;
                const targetProvider = providers.find(p => p.id === targetProviderId);
                const newModelDef = targetProvider?.models.find(m => m.id === updates.modelId);
                
                if (newModelDef) {
                    updatedAgent.name = newModelDef.name || newModelDef.id;
                }
             }
        }
        // -----------------------------

        // Avatar Update Logic - only update if not a custom avatar (base64)
        if ((updates.modelId || updates.providerId) && !a.avatar.startsWith('data:')) {
             const targetProviderId = updates.providerId || a.providerId;
             const targetModelId = updates.modelId || a.modelId;
             const p = providers.find(p => p.id === targetProviderId);
             if (p) updatedAgent.avatar = getAvatarForModel(targetModelId, p.name);
        }
        return updatedAgent;
    }));
  };

  const updateAgentConfig = (id: string, updates: Partial<Agent['config']>) => {
    setAgents(prev => prev.map(a => {
        if (a.id !== id) return a;
        return { ...a, config: { ...a.config, ...updates } };
    }));
  };

  const removeAgent = (id: string) => {
    setAgents(agents.filter(a => a.id !== id));
  };

  // -- Provider Management --
  const handleAddProvider = () => {
    const newProvider: ApiProvider = {
      id: Date.now().toString(),
      name: '新供应商',
      type: AgentType.OPENAI_COMPATIBLE,
      baseUrl: '',
      apiKey: '',
      models: [{ id: 'my-model', name: '默认模型', inputPricePer1M: 0, outputPricePer1M: 0 }]
    };
    setProviders([...providers, newProvider]);
  };
  const updateProvider = (id: string, updates: Partial<ApiProvider>) => setProviders(providers.map(p => p.id === id ? { ...p, ...updates } : p));
  const removeProvider = (id: string) => setProviders(providers.filter(p => p.id !== id));
  const addModelToProvider = (providerId: string) => setProviders(providers.map(p => p.id !== providerId ? p : { ...p, models: [...p.models, { id: '', name: '新模型', inputPricePer1M: 0, outputPricePer1M: 0 }] }));
  const updateModelInProvider = (providerId: string, modelIdx: number, field: string, value: any) => setProviders(providers.map(p => { if (p.id !== providerId) return p; const m = [...p.models]; m[modelIdx] = { ...m[modelIdx], [field]: value }; return { ...p, models: m }; }));
  const removeModelFromProvider = (providerId: string, modelIdx: number) => setProviders(providers.map(p => p.id !== providerId ? p : { ...p, models: p.models.filter((_, i) => i !== modelIdx) }));
  
  const handleFetchModels = async (provider: ApiProvider) => {
    if (!provider.apiKey) { alert("请先填写 API Key"); return; }
    setIsFetching(provider.id);
    try {
      const models = await fetchRemoteModels(provider);
      if (models.length > 0) { updateProvider(provider.id, { models }); alert(`成功获取 ${models.length} 个模型！`); }
      else { alert("未获取到任何模型。"); }
    } catch (e: any) { alert(`获取失败: ${e.message}`); } finally { setIsFetching(null); }
  };

  // User Avatar Upload (for profile)
  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          const avatarData = ev.target.result as string;
          // If editing a specific profile, update that profile
          if (editingProfileId) {
            updateUserProfile(editingProfileId, { avatar: avatarData });
            setEditingProfileId(null);
          } else {
            // Legacy: update global settings
            setSettings({ ...settings, userAvatar: avatarData });
          }
        }
      };
      reader.readAsDataURL(file);
    }
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  // User Profile Management
  const updateUserProfile = (profileId: string, updates: Partial<UserProfile>) => {
    const profiles = settings.userProfiles || [];
    const updatedProfiles = profiles.map(p =>
      p.id === profileId ? { ...p, ...updates } : p
    );
    // Also update legacy fields if this is the active profile
    const updatedProfile = updatedProfiles.find(p => p.id === profileId);
    const newSettings: GlobalSettings = { ...settings, userProfiles: updatedProfiles };
    if (settings.activeProfileId === profileId && updatedProfile) {
      newSettings.userName = updatedProfile.name;
      newSettings.userAvatar = updatedProfile.avatar;
      newSettings.userPersona = updatedProfile.persona;
    }
    setSettings(newSettings);
  };

  const addNewUserProfile = () => {
    const newId = `user-${Date.now()}`;
    const newProfile: UserProfile = {
      id: newId,
      name: '新身份',
      avatar: settings.userAvatar || '',
      persona: ''
    };
    const profiles = settings.userProfiles || [];
    setSettings({ ...settings, userProfiles: [...profiles, newProfile] });
    setExpandedProfileId(newId);
  };

  const deleteUserProfile = (profileId: string) => {
    const profiles = settings.userProfiles || [];
    if (profiles.length <= 1) return; // Keep at least one profile
    const newProfiles = profiles.filter(p => p.id !== profileId);
    const newSettings: GlobalSettings = { ...settings, userProfiles: newProfiles };
    // If deleting active profile, switch to first remaining
    if (settings.activeProfileId === profileId && newProfiles.length > 0) {
      newSettings.activeProfileId = newProfiles[0].id;
      newSettings.userName = newProfiles[0].name;
      newSettings.userAvatar = newProfiles[0].avatar;
      newSettings.userPersona = newProfiles[0].persona;
    }
    setSettings(newSettings);
    if (expandedProfileId === profileId) setExpandedProfileId(null);
  };

  // Agent Avatar Upload - updates draft
  const handleAgentAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && editingAgentAvatar) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          updateDraftAgent(editingAgentAvatar, { avatar: ev.target.result as string });
        }
      };
      reader.readAsDataURL(file);
    }
    setEditingAgentAvatar(null);
    if (agentAvatarInputRef.current) agentAvatarInputRef.current.value = '';
  };

  const resetAgentAvatar = (agentId: string) => {
    const agentData = getAgentData(agentId);
    if (agentData) {
      const provider = providers.find(p => p.id === agentData.providerId);
      const defaultAvatar = getAvatarForModel(agentData.modelId || '', provider?.name || '');
      updateDraftAgent(agentId, { avatar: defaultAvatar });
    }
  };

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeGroup = groups.find(g => g.id === activeGroupId);

  // 展开的群组ID集合
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(activeGroupId ? [activeGroupId] : []));

  // Auto-expand group when active session changes
  useEffect(() => {
    if (activeSessionId) {
      const session = sessions.find(s => s.id === activeSessionId);
      if (session?.groupId && !expandedGroups.has(session.groupId)) {
        setExpandedGroups(prev => new Set([...prev, session.groupId]));
      }
    }
  }, [activeSessionId, sessions]);

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  return (
    <div className={`fixed inset-y-0 left-0 w-full sm:w-96 bg-white dark:bg-zinc-800 shadow-2xl border-r border-gray-100 dark:border-zinc-700 transform transition-transform duration-300 z-50 overflow-hidden flex flex-col ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>

      {/* Header */}
      <div className="p-4 border-b border-gray-100 dark:border-zinc-700 flex justify-between items-center bg-white dark:bg-zinc-800">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white">控制面板</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900 dark:hover:text-white"><X size={20} /></button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-100 dark:border-zinc-700">
        <button onClick={() => setActiveTab('sessions')} className={`flex-1 py-3 text-xs font-medium ${activeTab === 'sessions' ? 'text-zinc-900 dark:text-white border-b-2 border-zinc-900 dark:border-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>会话</button>
        <button onClick={() => setActiveTab('agents')} className={`flex-1 py-3 text-xs font-medium ${activeTab === 'agents' ? 'text-zinc-900 dark:text-white border-b-2 border-zinc-900 dark:border-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>角色</button>
        <button onClick={() => setActiveTab('providers')} className={`flex-1 py-3 text-xs font-medium ${activeTab === 'providers' ? 'text-zinc-900 dark:text-white border-b-2 border-zinc-900 dark:border-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>供应商</button>
        <button onClick={() => setActiveTab('settings')} className={`flex-1 py-3 text-xs font-medium ${activeTab === 'settings' ? 'text-zinc-900 dark:text-white border-b-2 border-zinc-900 dark:border-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>设置</button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 bg-gray-50/50 dark:bg-zinc-900/50">
        
        {/* --- SESSIONS TAB (两级结构：群组 > 对话) --- */}
        {activeTab === 'sessions' && (
          <div className="space-y-3">
             {/* 群组列表 */}
             {groups.map(group => {
               const isExpanded = expandedGroups.has(group.id);
               const isActiveGroup = group.id === activeGroupId;
               const groupSessions = sessions.filter(s => s.groupId === group.id);

               return (
                 <div key={group.id} className="rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-800">
                   {/* 群组头部 */}
                   <div
                     className={`p-3 flex items-center gap-2 cursor-pointer transition-colors ${isActiveGroup ? 'bg-zinc-100 dark:bg-zinc-700' : 'hover:bg-gray-50 dark:hover:bg-zinc-700/50'}`}
                     onClick={() => {
                       // Always expand when clicking (don't toggle if not expanded)
                       if (!isExpanded) {
                         setExpandedGroups(prev => new Set([...prev, group.id]));
                       } else if (isActiveGroup) {
                         // Only collapse if clicking on already-active group
                         toggleGroupExpand(group.id);
                       }
                       // Switch to group and select first session if not active
                       if (!isActiveGroup) {
                         onSwitchGroup(group.id);
                         // Select first session in this group
                         if (groupSessions.length > 0) {
                           onSwitchSession(groupSessions[0].id);
                         }
                       }
                     }}
                   >
                     <button
                       className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                       onClick={(e) => { e.stopPropagation(); toggleGroupExpand(group.id); }}
                     >
                       {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                     </button>
                     <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isActiveGroup ? 'bg-zinc-900 dark:bg-zinc-500 text-white' : 'bg-gray-100 dark:bg-zinc-600 text-gray-500 dark:text-gray-400'}`}>
                       {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                     </div>
                     <div className="flex-1 min-w-0">
                       <input
                         className={`w-full bg-transparent text-sm font-semibold focus:outline-none ${isActiveGroup ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}
                         value={group.name}
                         onChange={(e) => onRenameGroup(group.id, e.target.value)}
                         onClick={(e) => e.stopPropagation()}
                       />
                       <div className="text-[10px] text-gray-400">{groupSessions.length} 个对话 • {group.memberIds.length} 位成员</div>
                     </div>
                     {groups.length > 1 && (
                       <button
                         onClick={(e) => { e.stopPropagation(); onDeleteGroup(group.id); }}
                         className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg opacity-0 group-hover:opacity-100"
                       >
                         <Trash2 size={14} />
                       </button>
                     )}
                   </div>

                   {/* 展开的对话列表 */}
                   {isExpanded && (
                     <div className="border-t border-gray-100 dark:border-zinc-700 bg-gray-50/50 dark:bg-zinc-900/30">
                       {groupSessions.map(session => (
                         <div
                           key={session.id}
                           onClick={() => onSwitchSession(session.id)}
                           className={`px-3 py-2 pl-10 flex items-center gap-2 cursor-pointer transition-colors border-b border-gray-100 dark:border-zinc-700 last:border-b-0 ${activeSessionId === session.id ? 'bg-white dark:bg-zinc-700' : 'hover:bg-white dark:hover:bg-zinc-700/50'}`}
                         >
                           <div className={`w-5 h-5 rounded flex items-center justify-center ${activeSessionId === session.id ? 'bg-zinc-900 dark:bg-zinc-500 text-white' : 'bg-gray-200 dark:bg-zinc-600 text-gray-400'}`}>
                             <MessageSquare size={10} />
                           </div>
                           <div className="flex-1 min-w-0">
                             <input
                               className={`w-full bg-transparent text-xs font-medium focus:outline-none ${activeSessionId === session.id ? 'text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}
                               value={session.name}
                               onChange={(e) => onRenameSession(session.id, e.target.value)}
                               onClick={(e) => e.stopPropagation()}
                             />
                           </div>
                           <span className="text-[10px] text-gray-400">{session.messages.length}条</span>
                           {groupSessions.length > 1 && (
                             <button
                               onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                               className="p-1 text-gray-300 hover:text-red-500 rounded"
                             >
                               <Trash2 size={12} />
                             </button>
                           )}
                         </div>
                       ))}
                       {/* 新建对话按钮 */}
                       <button
                         onClick={(e) => { e.stopPropagation(); onCreateSession(group.id); }}
                         className="w-full px-3 py-2 pl-10 text-left text-xs text-gray-400 hover:text-zinc-900 dark:hover:text-white hover:bg-white dark:hover:bg-zinc-700/50 transition-colors flex items-center gap-2"
                       >
                         <Plus size={12} /> 新建对话
                       </button>
                     </div>
                   )}
                 </div>
               );
             })}

             {/* 新建群组按钮 */}
             <button onClick={onCreateGroup} className="w-full py-3 border border-dashed border-gray-300 dark:border-zinc-600 rounded-xl text-gray-500 dark:text-gray-400 text-sm font-medium hover:bg-white dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-white transition-all flex items-center justify-center gap-2">
              <Plus size={16} /> 新建群组
            </button>

             {/* 当前群组配置 */}
             {activeGroup && (
               <div className="mt-4 space-y-4 pt-4 border-t border-gray-200 dark:border-zinc-700">
                 <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">当前群组配置</div>

                 {/* 群组场景设定 */}
                 <div className="bg-white dark:bg-zinc-800 p-3 rounded-xl border border-gray-200 dark:border-zinc-700">
                    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-2 uppercase flex items-center gap-1">
                      <Server size={12}/> 群组剧本 / 世界观
                    </div>
                    <textarea
                      className="w-full text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded-lg p-2 text-gray-600 dark:text-gray-300 h-24 resize-none focus:outline-none focus:border-zinc-300 dark:focus:border-zinc-500 custom-scrollbar"
                      placeholder="例如：现在你们都在一艘即将沉没的泰坦尼克号上..."
                      value={activeGroup.scenario || ''}
                      onChange={(e) => onUpdateGroupScenario(activeGroup.id, e.target.value)}
                    />
                 </div>

                 {/* 群组记忆配置 */}
                 <div className="bg-white dark:bg-zinc-800 p-3 rounded-xl border border-gray-200 dark:border-zinc-700">
                    <div className="flex justify-between items-center mb-2">
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase flex items-center gap-1">
                          <BookOpen size={12}/> 长期记忆系统
                        </div>
                        <div className="flex items-center gap-2">
                           <span className="text-[10px] text-gray-400">{activeGroup.memoryConfig?.enabled ? '已开启' : '已关闭'}</span>
                           <input
                              type="checkbox"
                              className="accent-zinc-900"
                              checked={activeGroup.memoryConfig?.enabled || false}
                              onChange={(e) => onUpdateGroupMemoryConfig(activeGroup.id, { enabled: e.target.checked })}
                           />
                        </div>
                    </div>

                    {activeGroup.memoryConfig?.enabled && (
                      <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                         <div className="grid grid-cols-2 gap-2">
                            <div>
                               <label className="text-[10px] text-gray-400 block mb-1">总结阈值 (条)</label>
                               <input
                                  type="number" min="5" max="500"
                                  className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                  value={activeGroup.memoryConfig?.threshold || 20}
                                  onChange={(e) => onUpdateGroupMemoryConfig(activeGroup.id, { threshold: parseInt(e.target.value) })}
                               />
                            </div>
                            <div>
                               <label className="text-[10px] text-gray-400 block mb-1">总结供应商</label>
                               <select
                                  className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                  value={activeGroup.memoryConfig?.summaryProviderId || ''}
                                  onChange={(e) => {
                                      const prov = providers.find(p => p.id === e.target.value);
                                      onUpdateGroupMemoryConfig(activeGroup.id, {
                                          summaryProviderId: prov?.id,
                                          summaryModelId: prov?.models[0]?.id
                                      });
                                  }}
                               >
                                  <option value="">选择供应商</option>
                                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                               </select>
                            </div>
                         </div>
                         {activeGroup.memoryConfig?.summaryProviderId && (
                            <div>
                               <label className="text-[10px] text-gray-400 block mb-1">总结模型</label>
                               <select
                                  className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                  value={activeGroup.memoryConfig?.summaryModelId || ''}
                                  onChange={(e) => onUpdateGroupMemoryConfig(activeGroup.id, { summaryModelId: e.target.value })}
                               >
                                  <option value="">选择模型</option>
                                  {providers.find(p => p.id === activeGroup.memoryConfig?.summaryProviderId)?.models.map(m => (
                                     <option key={m.id} value={m.id}>{m.name}</option>
                                  ))}
                               </select>
                            </div>
                         )}
                      </div>
                    )}
                 </div>

                 {/* 娱乐功能配置 */}
                 <div className="bg-white dark:bg-zinc-800 p-3 rounded-xl border border-gray-200 dark:border-zinc-700">
                    <div className="flex justify-between items-center mb-3">
                        <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase flex items-center gap-1">
                          <Sparkles size={12}/> 娱乐功能
                        </label>
                    </div>
                    <div className="space-y-2">
                       {/* 骰子开关 */}
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                             <Dices size={14} className="text-gray-400" />
                             <span className="text-xs text-gray-600 dark:text-gray-300">骰子</span>
                             <span className="text-[10px] text-gray-400 font-mono">{'{{ROLL: 2d6+3}}'}</span>
                          </div>
                          <input
                             type="checkbox"
                             className="accent-zinc-900"
                             checked={activeGroup.entertainmentConfig?.enableDice || false}
                             onChange={(e) => onUpdateGroupEntertainmentConfig(activeGroup.id, { enableDice: e.target.checked })}
                          />
                       </div>
                       {/* 塔罗开关 */}
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                             <Sparkles size={14} className="text-gray-400" />
                             <span className="text-xs text-gray-600 dark:text-gray-300">塔罗牌</span>
                             <span className="text-[10px] text-gray-400 font-mono">{'{{TAROT: 3}}'}</span>
                          </div>
                          <input
                             type="checkbox"
                             className="accent-zinc-900"
                             checked={activeGroup.entertainmentConfig?.enableTarot || false}
                             onChange={(e) => onUpdateGroupEntertainmentConfig(activeGroup.id, { enableTarot: e.target.checked })}
                          />
                       </div>
                    </div>
                 </div>

                 {/* 当前对话的摘要 (独立于群组) */}
                 {activeSession && (
                   <div className="bg-white dark:bg-zinc-800 p-3 rounded-xl border border-gray-200 dark:border-zinc-700">
                      <div className="flex justify-between items-center mb-2">
                         <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase flex items-center gap-1">
                           <Edit3 size={12}/> 当前对话摘要
                         </label>
                      </div>
                      <textarea
                        className="w-full text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded-lg p-2 text-gray-600 dark:text-gray-300 h-20 resize-none focus:outline-none focus:border-zinc-300 dark:focus:border-zinc-500 custom-scrollbar"
                        placeholder="暂无对话摘要..."
                        value={activeSession.summary || ''}
                        onChange={(e) => onUpdateSummary(activeSession.id, e.target.value)}
                      />
                      {/* Admin Notes Display */}
                      {activeSession.adminNotes && activeSession.adminNotes.length > 0 && (
                         <div className="bg-amber-50 dark:bg-amber-900/30 p-2 rounded border border-amber-100 dark:border-amber-800 mt-2">
                            <label className="text-[10px] text-amber-500 font-bold block mb-1">管理员便签</label>
                            <ul className="text-[10px] text-amber-700 dark:text-amber-400 list-disc list-inside space-y-1">
                               {activeSession.adminNotes.map((note, i) => <li key={i}>{note}</li>)}
                            </ul>
                         </div>
                      )}
                   </div>
                 )}
               </div>
             )}
          </div>
        )}

        {/* --- AGENTS TAB --- */}
        {activeTab === 'agents' && (
          <div className="space-y-4">
            {/* Header with Add Button */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">角色列表 ({agents.length})</span>
              <button
                onClick={handleAddAgent}
                className="p-1.5 bg-zinc-900 dark:bg-zinc-600 text-white rounded-lg hover:bg-black dark:hover:bg-zinc-500 transition-colors"
                title="添加新角色"
              >
                <Plus size={14} />
              </button>
            </div>
            {agents.map(agent => {
              // Use draft data when editing, otherwise use original
              const isCollapsed = collapsedAgents.has(agent.id);
              const editData = isCollapsed ? agent : (draftAgents[agent.id] || agent);
              const currentProvider = providers.find(p => p.id === editData.providerId);
              const configured = isAgentConfigured(editData);
              const isActive = agent.isActive !== false; // Use original for status display
              const hasDraft = hasUnsavedChanges(agent.id);
              return (
                <div
                  key={agent.id}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, agent.id)}
                  className={`bg-white dark:bg-zinc-800 rounded-xl border shadow-sm relative group transition-all ${draggedAgentId === agent.id ? 'opacity-50 scale-[0.98]' : ''} ${hasDraft ? 'border-blue-400 dark:border-blue-600 ring-1 ring-blue-200 dark:ring-blue-800' : !isActive ? 'border-orange-300 dark:border-orange-700 opacity-70' : 'border-gray-200 dark:border-zinc-700'}`}
                >
                  {/* Badges */}
                  {hasDraft && (
                    <div className="absolute -top-2 left-3 px-2 py-0.5 bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 text-[10px] font-bold rounded-full border border-blue-200 dark:border-blue-800">
                      编辑中
                    </div>
                  )}
                  {!isActive && !hasDraft && (
                    <div className="absolute -top-2 left-3 px-2 py-0.5 bg-orange-100 dark:bg-orange-900/50 text-orange-600 dark:text-orange-400 text-[10px] font-bold rounded-full border border-orange-200 dark:border-orange-800">
                      未启用
                    </div>
                  )}
                  {/* Collapsed Header */}
                  <div className="flex items-center gap-2 p-3 cursor-pointer" onClick={() => toggleAgentCollapse(agent.id)}>
                    <div
                      draggable
                      onDragStart={(e) => handleDragStart(e, agent.id)}
                      onDragEnd={handleDragEnd}
                      className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 dark:text-zinc-600 dark:hover:text-zinc-400 p-1 -m-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GripVertical size={16} />
                    </div>
                    <div className="relative">
                      <img
                        src={editData.avatar}
                        className={`w-8 h-8 rounded-full border bg-gray-50 dark:bg-zinc-700 object-contain p-0.5 ${isActive ? 'border-gray-100 dark:border-zinc-600' : 'border-orange-300 dark:border-orange-600 grayscale'}`}
                      />
                      {isActive && <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white dark:border-zinc-800"></div>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-gray-800 dark:text-white truncate">{editData.name || '未命名角色'}</div>
                      <div className="text-[10px] text-gray-400 truncate">
                        {currentProvider ? `${currentProvider.name} • ${editData.modelId || '未选择'}` : <span className="text-orange-400">未配置供应商</span>}
                      </div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeAgent(agent.id); discardDraftAgent(agent.id); }} className="text-gray-300 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                    {isCollapsed ? <ChevronRight size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                  </div>

                  {/* Expanded Content */}
                  {!isCollapsed && (
                    <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-zinc-700">
                      <div className="flex gap-3 mb-3">
                        <div className="relative group/avatar">
                          <img
                            src={editData.avatar}
                            className="w-12 h-12 rounded-full border border-gray-100 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-700 object-contain p-1 cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => {
                              setEditingAgentAvatar(agent.id);
                              agentAvatarInputRef.current?.click();
                            }}
                            title="点击上传自定义头像"
                          />
                          <div className="absolute -bottom-1 -right-1 bg-zinc-900 text-white rounded-full p-1 pointer-events-none">
                            <Upload size={8} />
                          </div>
                          {editData.avatar.startsWith('data:') && (
                            <button
                              onClick={(e) => { e.stopPropagation(); resetAgentAvatar(agent.id); }}
                              className="absolute -top-1 -left-1 bg-gray-500 text-white rounded-full p-0.5 hover:bg-gray-700 opacity-0 group-hover/avatar:opacity-100 transition-opacity"
                              title="重置为模型默认头像"
                            >
                              <RefreshCw size={8} />
                            </button>
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            className="font-bold text-gray-800 dark:text-white w-full bg-transparent focus:bg-gray-50 dark:focus:bg-zinc-700 rounded px-1 -ml-1 border-transparent focus:border-gray-200 dark:focus:border-zinc-600 border"
                            value={editData.name}
                            onChange={(e) => updateDraftAgent(agent.id, { name: e.target.value })}
                            placeholder="角色名称"
                          />
                          <div className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                            {currentProvider ? (
                              <>
                                <span className="truncate max-w-[100px]">{currentProvider.name}</span>
                                <span>•</span>
                                <span className="truncate max-w-[100px]">{editData.modelId || '未选择模型'}</span>
                              </>
                            ) : (
                              <span className="text-orange-400">未配置供应商</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                     {/* 管理员权限现在在群组成员列表中设置 */}

                     <textarea
                        className="w-full text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded-lg p-2 text-gray-600 dark:text-gray-300 h-16 resize-none focus:outline-none focus:border-zinc-300 dark:focus:border-zinc-500"
                        placeholder="人设 Prompt..."
                        value={editData.systemPrompt}
                        onChange={(e) => updateDraftAgent(agent.id, { systemPrompt: e.target.value })}
                     />
                     
                     <div className="grid grid-cols-2 gap-2">
                       <select
                          className={`text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded-lg p-2 text-gray-700 dark:text-gray-200 ${!editData.providerId ? 'text-gray-400' : ''}`}
                          value={editData.providerId}
                          onChange={(e) => updateDraftAgent(agent.id, { providerId: e.target.value, modelId: providers.find(p => p.id === e.target.value)?.models[0]?.id || '' })}
                       >
                          <option value="">选择供应商</option>
                          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                       </select>
                       <select
                          className={`text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded-lg p-2 text-gray-700 dark:text-gray-200 ${!editData.modelId ? 'text-gray-400' : ''}`}
                          value={editData.modelId}
                          onChange={(e) => updateDraftAgent(agent.id, { modelId: e.target.value })}
                          disabled={!editData.providerId}
                       >
                          <option value="">选择模型</option>
                          {currentProvider?.models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                       </select>
                     </div>

                     {/* Advanced Params */}
                     <div className="border-t border-gray-100 dark:border-zinc-700 pt-3 mt-1">
                        <div className="flex items-center gap-2 text-xs font-bold text-gray-500 dark:text-gray-400 mb-2">
                            <Sliders size={12} /> 高级参数
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 w-12">温度: {editData.config.temperature}</span>
                                <input
                                    type="range" min="0" max="2" step="0.1"
                                    className="flex-1 h-1 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none accent-zinc-800"
                                    value={editData.config.temperature}
                                    onChange={(e) => updateDraftAgentConfig(agent.id, { temperature: parseFloat(e.target.value) })}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 w-12">MaxToken</span>
                                <input
                                    type="number"
                                    className="flex-1 text-xs p-1 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                    value={editData.config.maxTokens}
                                    onChange={(e) => updateDraftAgentConfig(agent.id, { maxTokens: parseInt(e.target.value) })}
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                    <BrainCircuit size={10} /> 推理链模式 (R1/Claude/Gemini)
                                </span>
                                <input
                                    type="checkbox"
                                    className="accent-zinc-900"
                                    checked={editData.config.enableReasoning}
                                    onChange={(e) => updateDraftAgentConfig(agent.id, { enableReasoning: e.target.checked })}
                                />
                            </div>
                            {editData.config.enableReasoning && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 dark:text-gray-400 w-12">推理预算</span>
                                    <input
                                        type="number"
                                        className="flex-1 text-xs p-1 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                        placeholder="如 2048 (仅 Claude 有效)"
                                        value={editData.config.reasoningBudget}
                                        onChange={(e) => updateDraftAgentConfig(agent.id, { reasoningBudget: parseInt(e.target.value) })}
                                    />
                                </div>
                            )}

                            {/* Vision Proxy - Give text-only models "eyes" */}
                            <div className="border-t border-gray-100 dark:border-zinc-700 pt-2 mt-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                        <ScanEye size={10} /> 视觉代理 (借眼睛)
                                    </span>
                                    <input
                                        type="checkbox"
                                        className="accent-zinc-900"
                                        checked={editData.config.visionProxyEnabled || false}
                                        onChange={(e) => updateDraftAgentConfig(agent.id, { visionProxyEnabled: e.target.checked })}
                                    />
                                </div>
                                <p className="text-[9px] text-gray-400 mt-0.5">
                                    让不支持图片的模型借用其他视觉模型来"看"图
                                </p>
                            </div>

                            {editData.config.visionProxyEnabled && (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                                    <div>
                                        <label className="text-[10px] text-gray-400 block mb-1">视觉供应商</label>
                                        <select
                                            className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                            value={editData.config.visionProxyProviderId || ''}
                                            onChange={(e) => {
                                                const prov = providers.find(p => p.id === e.target.value);
                                                updateDraftAgentConfig(agent.id, {
                                                    visionProxyProviderId: prov?.id,
                                                    visionProxyModelId: prov?.models[0]?.id
                                                });
                                            }}
                                        >
                                            <option value="">选择供应商</option>
                                            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                        </select>
                                    </div>
                                    {editData.config.visionProxyProviderId && (
                                        <div>
                                            <label className="text-[10px] text-gray-400 block mb-1">视觉模型</label>
                                            <select
                                                className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                                value={editData.config.visionProxyModelId || ''}
                                                onChange={(e) => updateDraftAgentConfig(agent.id, { visionProxyModelId: e.target.value })}
                                            >
                                                <option value="">选择模型</option>
                                                {providers.find(p => p.id === editData.config.visionProxyProviderId)?.models.map(m => (
                                                    <option key={m.id} value={m.id}>{m.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* 搜索工具配置 */}
                            <div className="border-t border-gray-100 dark:border-zinc-700 pt-2 mt-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                        <Search size={10} /> 搜索工具
                                    </span>
                                    <input
                                        type="checkbox"
                                        className="accent-zinc-900"
                                        checked={editData.searchConfig?.enabled || false}
                                        onChange={(e) => updateDraftAgent(agent.id, {
                                          searchConfig: {
                                            ...editData.searchConfig,
                                            enabled: e.target.checked,
                                            engine: editData.searchConfig?.engine || 'serper',
                                            apiKey: editData.searchConfig?.apiKey || ''
                                          }
                                        })}
                                    />
                                </div>
                                <p className="text-[9px] text-gray-400 mt-0.5">
                                    用户发送 /search 时，此角色可执行网络搜索
                                </p>
                            </div>

                            {editData.searchConfig?.enabled && (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                                    <div>
                                        <label className="text-[10px] text-gray-400 block mb-1">搜索引擎</label>
                                        <select
                                            className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                            value={editData.searchConfig?.engine || 'serper'}
                                            onChange={(e) => updateDraftAgent(agent.id, {
                                              searchConfig: {
                                                ...editData.searchConfig!,
                                                engine: e.target.value as SearchEngine
                                              }
                                            })}
                                        >
                                            <option value="serper">Serper (Google)</option>
                                            <option value="brave">Brave Search</option>
                                            <option value="tavily">Tavily</option>
                                            <option value="metaso">Metaso (秘塔)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-400 block mb-1">API Key</label>
                                        <input
                                            type="password"
                                            placeholder="搜索引擎 API Key"
                                            className="w-full text-xs p-1.5 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                            value={editData.searchConfig?.apiKey || ''}
                                            onChange={(e) => updateDraftAgent(agent.id, {
                                              searchConfig: {
                                                ...editData.searchConfig!,
                                                apiKey: e.target.value
                                              }
                                            })}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Gemini 原生 Google 搜索 (仅 Gemini 模型可用) */}
                            {currentProvider?.type === AgentType.GEMINI && (
                                <div className="border-t border-gray-100 dark:border-zinc-700 pt-2 mt-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                            <Search size={10} /> Google 搜索 (原生)
                                        </span>
                                        <input
                                            type="checkbox"
                                            className="accent-zinc-900"
                                            checked={editData.enableGoogleSearch || false}
                                            onChange={(e) => updateDraftAgent(agent.id, { enableGoogleSearch: e.target.checked })}
                                        />
                                    </div>
                                    <p className="text-[9px] text-gray-400 mt-0.5">
                                        Gemini 内置搜索，无需额外 API Key
                                    </p>
                                </div>
                            )}
                        </div>
                      </div>

                      {/* Save / Discard Buttons */}
                      {hasDraft && (
                        <div className="border-t border-blue-200 dark:border-blue-800 pt-3 mt-3 flex gap-2">
                          <button
                            onClick={() => discardDraftAgent(agent.id)}
                            className="flex-1 py-2 text-xs font-medium text-gray-500 bg-gray-100 dark:bg-zinc-700 dark:text-gray-400 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-600 transition-colors flex items-center justify-center gap-1"
                          >
                            <RotateCcw size={12} /> 放弃更改
                          </button>
                          <button
                            onClick={() => saveDraftAgent(agent.id)}
                            disabled={!configured}
                            className="flex-1 py-2 text-xs font-bold text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1 shadow-sm"
                          >
                            <Save size={12} /> 保存配置
                          </button>
                        </div>
                      )}

                      {/* Activate/Deactivate Button */}
                      <div className="border-t border-gray-100 dark:border-zinc-700 pt-3 mt-3">
                        {!configured ? (
                          <div className="text-center text-xs text-orange-500 py-2 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                            请先选择供应商和模型
                          </div>
                        ) : isActive ? (
                          <button
                            onClick={() => { saveDraftAgent(agent.id); updateAgent(agent.id, { isActive: false }); }}
                            className="w-full py-2 text-xs font-medium text-gray-500 bg-gray-100 dark:bg-zinc-700 dark:text-gray-400 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-600 transition-colors flex items-center justify-center gap-2"
                          >
                            <PowerOff size={14} /> 停用角色
                          </button>
                        ) : (
                          <button
                            onClick={() => { saveDraftAgent(agent.id); updateAgent(agent.id, { isActive: true }); }}
                            className="w-full py-2 text-xs font-bold text-white bg-green-500 rounded-lg hover:bg-green-600 transition-colors flex items-center justify-center gap-2 shadow-sm"
                          >
                            <Power size={14} /> 启用角色
                          </button>
                        )}
                      </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {agents.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                点击右上角 <Plus size={14} className="inline" /> 添加新角色
              </div>
            )}
          </div>
        )}

        {/* --- PROVIDERS TAB --- */}
        {activeTab === 'providers' && (
          <div className="space-y-6">
            {providers.map(provider => (
              <div key={provider.id} className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden shadow-sm">
                 <div className="bg-gray-50/50 dark:bg-zinc-700/50 p-3 border-b border-gray-100 dark:border-zinc-600 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Server size={14} className="text-gray-400" />
                      <input
                        className="bg-transparent font-semibold text-sm text-gray-800 dark:text-white focus:outline-none"
                        value={provider.name}
                        onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
                        placeholder="供应商名称"
                      />
                    </div>
                    <button onClick={() => removeProvider(provider.id)} className="text-gray-300 hover:text-red-500"><Trash2 size={14}/></button>
                 </div>

                 <div className="p-3 space-y-3">
                    <div className="grid gap-2">
                       {/* Provider Type Selector */}
                       <select
                          className="text-xs bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded p-2 w-full text-gray-600 dark:text-gray-200 focus:outline-none"
                          value={provider.type}
                          onChange={(e) => updateProvider(provider.id, { type: e.target.value as AgentType })}
                       >
                          <option value={AgentType.OPENAI_COMPATIBLE}>OpenAI 兼容 (OpenRouter/DeepSeek/OneAPI)</option>
                          <option value={AgentType.GEMINI}>Google Gemini</option>
                          <option value={AgentType.ANTHROPIC}>Anthropic Official (Claude)</option>
                       </select>

                       {provider.type !== AgentType.GEMINI && (
                         <>
                           <input
                              placeholder={provider.type === AgentType.ANTHROPIC ? "https://api.anthropic.com/v1" : "API Base URL"}
                              className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded w-full text-gray-700 dark:text-gray-200"
                              value={provider.baseUrl || ''}
                              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                           />
                           <div className="flex gap-2">
                             <input
                                type="password"
                                placeholder={provider.type === AgentType.ANTHROPIC ? "x-api-key" : "API Key"}
                                className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded flex-1 text-gray-700 dark:text-gray-200"
                                value={provider.apiKey || ''}
                                onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                             />
                             <button
                                onClick={() => handleFetchModels(provider)}
                                disabled={isFetching === provider.id}
                                className="p-2 bg-zinc-100 dark:bg-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-500 text-zinc-900 dark:text-white rounded border border-gray-200 dark:border-zinc-500 transition-colors"
                                title="从服务器获取/刷新模型列表"
                             >
                                <RefreshCw size={14} className={isFetching === provider.id ? 'animate-spin' : ''} />
                             </button>
                           </div>
                         </>
                       )}
                       {provider.type === AgentType.GEMINI && (
                         <div className="space-y-2">
                           {/* Gemini Mode Selector */}
                           <div className="flex gap-1 bg-gray-100 dark:bg-zinc-700 rounded p-0.5">
                             <button
                               onClick={() => updateProvider(provider.id, { geminiMode: 'aistudio' })}
                               className={`flex-1 text-xs py-1.5 rounded transition-all ${(provider.geminiMode || 'aistudio') === 'aistudio' ? 'bg-white dark:bg-zinc-600 shadow-sm text-gray-800 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                             >
                               AI Studio
                             </button>
                             <button
                               onClick={() => updateProvider(provider.id, { geminiMode: 'vertex' })}
                               className={`flex-1 text-xs py-1.5 rounded transition-all ${provider.geminiMode === 'vertex' ? 'bg-white dark:bg-zinc-600 shadow-sm text-gray-800 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                             >
                               Vertex AI
                             </button>
                           </div>

                           {/* AI Studio Mode - Simple API Key */}
                           {(provider.geminiMode || 'aistudio') === 'aistudio' && (
                             <div className="flex gap-2">
                               <input
                                 type="password"
                                 placeholder="Gemini API Key (从 aistudio.google.com 获取)"
                                 className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded flex-1 text-gray-700 dark:text-gray-200"
                                 value={provider.apiKey || ''}
                                 onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                               />
                               <button
                                 onClick={() => handleFetchModels(provider)}
                                 disabled={isFetching === provider.id}
                                 className="p-2 bg-zinc-100 dark:bg-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-500 text-zinc-900 dark:text-white rounded border border-gray-200 dark:border-zinc-500 transition-colors"
                                 title="从服务器获取/刷新模型列表"
                               >
                                 <RefreshCw size={14} className={isFetching === provider.id ? 'animate-spin' : ''} />
                               </button>
                             </div>
                           )}

                           {/* Vertex AI Mode - Project + Location + Optional API Key */}
                           {provider.geminiMode === 'vertex' && (
                             <>
                               <div className="grid grid-cols-2 gap-2">
                                 <input
                                   placeholder="Google Cloud Project ID"
                                   className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                   value={provider.vertexProject || ''}
                                   onChange={(e) => updateProvider(provider.id, { vertexProject: e.target.value })}
                                 />
                                 <input
                                   placeholder="Location (如 us-central1)"
                                   className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                   value={provider.vertexLocation || ''}
                                   onChange={(e) => updateProvider(provider.id, { vertexLocation: e.target.value })}
                                 />
                               </div>
                               <div className="flex gap-2">
                                 <input
                                   type="password"
                                   placeholder="API Key (可选，用于 Express Mode)"
                                   className="text-xs p-2 bg-gray-50 dark:bg-zinc-700 border border-gray-100 dark:border-zinc-600 rounded flex-1 text-gray-700 dark:text-gray-200"
                                   value={provider.apiKey || ''}
                                   onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                                 />
                                 <button
                                   onClick={() => handleFetchModels(provider)}
                                   disabled={isFetching === provider.id}
                                   className="p-2 bg-zinc-100 dark:bg-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-500 text-zinc-900 dark:text-white rounded border border-gray-200 dark:border-zinc-500 transition-colors"
                                   title="从服务器获取/刷新模型列表"
                                 >
                                   <RefreshCw size={14} className={isFetching === provider.id ? 'animate-spin' : ''} />
                                 </button>
                               </div>
                               <div className="text-[10px] text-gray-400">
                                 Vertex AI 需要 Google Cloud 认证。可使用 API Key (Express Mode) 或配置应用默认凭据 (ADC)。
                               </div>
                             </>
                           )}
                         </div>
                       )}
                    </div>

                    <div className="border-t border-gray-100 dark:border-zinc-600 pt-3">
                       <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2 block flex justify-between">
                         <span>可用模型列表 ({provider.models.length})</span>
                       </label>
                       <div className="space-y-3 max-h-64 overflow-y-auto p-2 rounded-lg bg-gray-100 dark:bg-zinc-900/50">
                         {provider.models.map((model, idx) => (
                           <div key={idx} className="space-y-1.5 p-2 bg-white dark:bg-zinc-800 rounded-lg border border-gray-200 dark:border-zinc-600">
                              <div className="grid grid-cols-[1fr_1fr_24px] gap-2 items-center">
                                <input
                                  placeholder="模型ID"
                                  className="w-full text-xs px-2 py-1 bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-500 rounded text-gray-700 dark:text-gray-200 focus:outline-none focus:border-zinc-400"
                                  value={model.id}
                                  onChange={(e) => updateModelInProvider(provider.id, idx, 'id', e.target.value)}
                                />
                                <input
                                  placeholder="显示名称"
                                  className="w-full text-xs px-2 py-1 bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-500 rounded text-gray-700 dark:text-gray-200 focus:outline-none focus:border-zinc-400"
                                  value={model.name}
                                  onChange={(e) => updateModelInProvider(provider.id, idx, 'name', e.target.value)}
                                />
                                <button onClick={() => removeModelFromProvider(provider.id, idx)} className="text-gray-400 hover:text-red-500 flex items-center justify-center"><X size={14}/></button>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">输入$/1M:</span>
                                  <input
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    className="w-full text-xs px-2 py-0.5 bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-500 rounded text-gray-700 dark:text-gray-200 focus:outline-none focus:border-zinc-400"
                                    value={model.inputPricePer1M || ''}
                                    onChange={(e) => updateModelInProvider(provider.id, idx, 'inputPricePer1M', parseFloat(e.target.value) || 0)}
                                  />
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">输出$/1M:</span>
                                  <input
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    className="w-full text-xs px-2 py-0.5 bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-500 rounded text-gray-700 dark:text-gray-200 focus:outline-none focus:border-zinc-400"
                                    value={model.outputPricePer1M || ''}
                                    onChange={(e) => updateModelInProvider(provider.id, idx, 'outputPricePer1M', parseFloat(e.target.value) || 0)}
                                  />
                                </div>
                              </div>
                           </div>
                         ))}
                         <button onClick={() => addModelToProvider(provider.id)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 mt-1">+ 添加模型定义</button>
                       </div>
                    </div>
                 </div>
              </div>
            ))}
            <button onClick={handleAddProvider} className="w-full py-2 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-lg text-sm font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors">添加 API 供应商</button>
          </div>
        )}

        {/* --- GLOBAL SETTINGS TAB --- */}
        {activeTab === 'settings' && (
           <div className="space-y-6 p-1">
             
             {/* USER PROFILES SETTINGS */}
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><User size={16}/> 用户档案 (多身份)</h3>

                {/* Hidden file inputs */}
                <input
                   type="file"
                   ref={avatarInputRef}
                   className="hidden"
                   accept="image/png, image/jpeg, image/svg+xml, image/webp"
                   onChange={handleAvatarUpload}
                />
                <input
                   type="file"
                   ref={agentAvatarInputRef}
                   className="hidden"
                   accept="image/png, image/jpeg, image/svg+xml, image/webp"
                   onChange={handleAgentAvatarUpload}
                />

                <div className="space-y-3">
                  {/* Profile List */}
                  {(settings.userProfiles || []).map((profile, idx) => (
                    <div key={profile.id} className="border border-gray-200 dark:border-zinc-600 rounded-lg overflow-hidden">
                      {/* Profile Header (Collapsible) */}
                      <div
                        className={`flex items-center gap-2 p-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-700 ${
                          settings.activeProfileId === profile.id ? 'bg-zinc-100 dark:bg-zinc-700' : ''
                        }`}
                        onClick={() => setExpandedProfileId(expandedProfileId === profile.id ? null : profile.id)}
                      >
                        <img
                          src={profile.avatar}
                          className="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-zinc-600"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-gray-900 dark:text-white truncate">{profile.name}</div>
                          <div className="text-[10px] text-gray-400 truncate">{profile.persona?.slice(0, 30) || '无人设'}...</div>
                        </div>
                        {settings.activeProfileId === profile.id && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded">当前</span>
                        )}
                        {expandedProfileId === profile.id ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                      </div>

                      {/* Profile Editor (Expanded) */}
                      {expandedProfileId === profile.id && (
                        <div className="p-3 bg-gray-50 dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-600 space-y-3">
                          <div className="flex gap-3 items-start">
                            <div className="relative">
                              <img
                                src={profile.avatar}
                                className="w-12 h-12 rounded-full bg-gray-100 dark:bg-zinc-700 p-0.5 border border-gray-200 dark:border-zinc-600 cursor-pointer object-cover hover:opacity-80 transition-opacity"
                                onClick={() => {
                                  setEditingProfileId(profile.id);
                                  avatarInputRef.current?.click();
                                }}
                                title="点击上传图片"
                              />
                              <div className="absolute -bottom-1 -right-1 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-full p-1 pointer-events-none">
                                <Upload size={10} />
                              </div>
                            </div>
                            <div className="flex-1 space-y-2">
                              <input
                                className="w-full text-xs p-2 bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded text-gray-700 dark:text-gray-200"
                                placeholder="档案名称"
                                value={profile.name}
                                onChange={(e) => updateUserProfile(profile.id, { name: e.target.value })}
                              />
                              <input
                                className="w-full text-xs p-2 bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded text-gray-400"
                                placeholder="头像 URL (或点击头像上传)"
                                value={profile.avatar.length > 50 ? '已上传图片' : profile.avatar}
                                onChange={(e) => updateUserProfile(profile.id, { avatar: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-gray-400 font-bold block mb-1">人设 / 自我介绍 (AI可见)</label>
                            <textarea
                              className="w-full text-xs bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded-lg p-2 text-gray-600 dark:text-gray-300 h-16 resize-none"
                              placeholder="例如：我是一个图灵测试主考官..."
                              value={profile.persona || ''}
                              onChange={(e) => updateUserProfile(profile.id, { persona: e.target.value })}
                            />
                          </div>
                          <div className="flex gap-2">
                            {settings.activeProfileId !== profile.id && (
                              <button
                                className="flex-1 text-xs py-1.5 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded hover:opacity-90"
                                onClick={() => setSettings({ ...settings, activeProfileId: profile.id })}
                              >
                                设为当前
                              </button>
                            )}
                            {(settings.userProfiles || []).length > 1 && (
                              <button
                                className="px-3 text-xs py-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded border border-red-200 dark:border-red-800"
                                onClick={() => deleteUserProfile(profile.id)}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Add New Profile Button */}
                  <button
                    className="w-full py-2 text-xs text-gray-500 dark:text-gray-400 border border-dashed border-gray-300 dark:border-zinc-600 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 flex items-center justify-center gap-1"
                    onClick={addNewUserProfile}
                  >
                    <Plus size={14} /> 添加新档案
                  </button>
                </div>
             </div>

             {/* STABILITY SETTINGS */}
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><ShieldAlert size={16}/> 稳定性与并发</h3>
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1">
                            <Zap size={12} /> 允许并发 (插嘴模式)
                        </span>
                        <input
                            type="checkbox"
                            className="accent-zinc-900"
                            checked={settings.enableConcurrency || false}
                            onChange={(e) => setSettings({...settings, enableConcurrency: e.target.checked})}
                        />
                    </div>
                    <p className="text-[10px] text-gray-400 -mt-2">
                        开启后，AI 不需要等待对方说完即可开始生成（真实吵架模式）。关闭则为礼貌排队模式。
                    </p>

                    <div>
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-gray-600 dark:text-gray-300">超时熔断 (Timeout)</span>
                            <span className="font-mono text-gray-500 dark:text-gray-400">{(settings.timeoutDuration || 30000) / 1000}s</span>
                        </div>
                        <input
                            type="range" min="5000" max="300000" step="5000"
                            className="w-full accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                            value={settings.timeoutDuration || 30000}
                            onChange={(e) => setSettings({...settings, timeoutDuration: parseInt(e.target.value)})}
                        />
                    </div>
                </div>
             </div>

             {/* IMAGE COMPRESSION */}
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                  <ImageIcon size={16}/> 图片压缩
                </h3>
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-300">自动压缩大图</span>
                        <input
                            type="checkbox"
                            className="accent-zinc-900"
                            checked={settings.compressImages ?? true}
                            onChange={(e) => setSettings({...settings, compressImages: e.target.checked})}
                        />
                    </div>
                    <p className="text-[10px] text-gray-400 -mt-2">
                        开启后，超过阈值的图片会自动压缩。Anthropic API 限制 5MB。
                    </p>

                    {settings.compressImages !== false && (
                      <div>
                          <div className="flex justify-between text-xs mb-1">
                              <span className="text-gray-600 dark:text-gray-300">压缩阈值</span>
                              <span className="font-mono text-gray-500 dark:text-gray-400">{settings.maxImageSizeMB ?? 4} MB</span>
                          </div>
                          <input
                              type="range" min="1" max="10" step="1"
                              className="w-full accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                              value={settings.maxImageSizeMB ?? 4}
                              onChange={(e) => setSettings({...settings, maxImageSizeMB: parseInt(e.target.value)})}
                          />
                          <p className="text-[10px] text-gray-400 mt-1">
                              建议设为 4MB 以留安全边际。
                          </p>
                      </div>
                    )}
                </div>
             </div>

             {/* APPEARANCE */}
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                  {settings.darkMode ? <Moon size={16}/> : <Sun size={16}/>} 外观
                </h3>
                <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1">
                        <Moon size={12} /> 深色模式
                    </span>
                    <input
                        type="checkbox"
                        className="accent-zinc-900"
                        checked={settings.darkMode || false}
                        onChange={(e) => setSettings({...settings, darkMode: e.target.checked})}
                    />
                </div>
                <p className="text-[10px] text-gray-400 mt-2">
                    切换深色/浅色主题，深色模式更适合夜间使用。
                </p>
             </div>

             {/* TTS (TEXT-TO-SPEECH) */}
             <TTSSettingsPanel settings={settings} setSettings={setSettings} agents={agents} setAgents={setAgents} ttsProviders={ttsProviders} setTTSProviders={setTTSProviders} />

             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><Clock size={16}/> 思考呼吸时间</h3>
                <div className="flex items-center gap-4">
                  <input
                    type="range" min="500" max="10000" step="500"
                    className="flex-1 accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                    value={settings.breathingTime}
                    onChange={(e) => setSettings({...settings, breathingTime: parseInt(e.target.value)})}
                  />
                  <span className="text-xs font-mono font-medium text-gray-600 dark:text-gray-300 w-16 text-right">
                    {(settings.breathingTime / 1000).toFixed(1)}s
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-2">一位 AI 发言结束后，等待下一位 AI 开始思考的间隔时间。</p>
             </div>
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><GripVertical size={16}/> 上下文历史限制</h3>
                <div className="flex items-center gap-4">
                  <input
                    type="range" min="2" max="521" step="1"
                    className="flex-1 accent-zinc-900 h-2 bg-gray-200 dark:bg-zinc-600 rounded-lg appearance-none"
                    value={settings.contextLimit || 20}
                    onChange={(e) => setSettings({...settings, contextLimit: parseInt(e.target.value)})}
                  />
                  <span className="text-xs font-mono font-medium text-gray-600 dark:text-gray-300 w-16 text-right">
                    {settings.contextLimit || 20} 条
                  </span>
                </div>
             </div>
             <div className="bg-white dark:bg-zinc-800 p-4 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                   {settings.visibilityMode === 'OPEN' ? <Eye size={16}/> : <EyeOff size={16}/>} 可见性模式
                </h3>
                <div className="flex gap-2">
                   <button
                     onClick={() => setSettings({...settings, visibilityMode: 'OPEN'})}
                     className={`flex-1 py-2 text-xs font-medium rounded-lg border ${settings.visibilityMode === 'OPEN' ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white' : 'bg-white dark:bg-zinc-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-zinc-600 hover:bg-gray-50 dark:hover:bg-zinc-600'}`}
                   >
                     公开 (标准)
                   </button>
                   <button
                     onClick={() => setSettings({...settings, visibilityMode: 'BLIND'})}
                     className={`flex-1 py-2 text-xs font-medium rounded-lg border ${settings.visibilityMode === 'BLIND' ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white' : 'bg-white dark:bg-zinc-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-zinc-600 hover:bg-gray-50 dark:hover:bg-zinc-600'}`}
                   >
                     盲盒 (仅见用户)
                   </button>
                </div>
             </div>
           </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
