
import React, { useState } from 'react';
import { Agent, MuteInfo, UserProfile } from '../types';
import { X, Plus, Minus, User, VolumeX, Clock, Shield, ShieldOff, ChevronDown, Megaphone } from 'lucide-react';

// Mute duration options (in minutes)
const MUTE_DURATIONS = [
  { label: '10分钟', value: 10 },
  { label: '30分钟', value: 30 },
  { label: '1小时', value: 60 },
  { label: '1天', value: 60 * 24 },
  { label: '7天', value: 60 * 24 * 7 },
  { label: '30天', value: 60 * 24 * 30 },
  { label: '永久', value: 0 },
  { label: '自定义', value: -1 },
];

interface RightSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];           // 当前在群聊中的角色 (isActive = true)
  inactiveAgents: Agent[];   // 未加入群聊的角色 (isActive = false)
  adminIds: string[];        // 当前群的管理员列表
  mutedAgents: MuteInfo[];
  onRemoveAgent: (id: string) => void;
  onMuteAgent: (agentId: string, durationMinutes: number, mutedBy: string) => void;
  onUnmuteAgent: (agentId: string) => void;
  onActivateAgent: (agentId: string) => void;  // 激活角色加入群聊
  onToggleAdmin: (agentId: string) => void;    // 切换管理员状态
  userName: string;
  // User profile switching
  userProfiles?: UserProfile[];
  activeProfileId?: string | 'narrator';
  onSwitchProfile?: (profileId: string | 'narrator') => void;
}

const RightSidebar: React.FC<RightSidebarProps> = ({
  isOpen, onClose, agents, inactiveAgents, adminIds, mutedAgents, onRemoveAgent, onMuteAgent, onUnmuteAgent, onActivateAgent, onToggleAdmin, userName,
  userProfiles, activeProfileId, onSwitchProfile
}) => {
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showMuteMenu, setShowMuteMenu] = useState<string | null>(null); // agentId being muted
  const [customDuration, setCustomDuration] = useState('60'); // minutes
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // Get current profile info
  const currentProfile = userProfiles?.find(p => p.id === activeProfileId);
  const isNarrator = activeProfileId === 'narrator';

  const handleActivateAgent = (agentId: string) => {
    onActivateAgent(agentId);
    setShowAddMenu(false);
  };

  const getMuteInfo = (agentId: string): MuteInfo | undefined => {
    return mutedAgents.find(m => m.agentId === agentId);
  };

  const getRemainingTime = (muteUntil: number): string => {
    if (muteUntil === 0) return '永久';
    const remaining = muteUntil - Date.now();
    if (remaining <= 0) return '已过期';

    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}天${hours % 24}小时`;
    if (hours > 0) return `${hours}小时${minutes % 60}分`;
    return `${minutes}分钟`;
  };

  const handleMute = (agentId: string, durationMinutes: number) => {
    if (durationMinutes === -1) {
      // Custom: use the input value
      const mins = parseInt(customDuration) || 60;
      onMuteAgent(agentId, mins, userName || 'User');
    } else {
      onMuteAgent(agentId, durationMinutes, userName || 'User');
    }
    setShowMuteMenu(null);
    setCustomDuration('60');
  };

  return (
    <div className={`fixed inset-y-0 right-0 w-full sm:w-80 bg-white dark:bg-zinc-800 shadow-2xl border-l border-gray-100 dark:border-zinc-700 transform transition-transform duration-300 z-50 overflow-hidden flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>

      {/* Header */}
      <div className="p-4 border-b border-gray-100 dark:border-zinc-700 flex justify-between items-center bg-white dark:bg-zinc-800">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
          群聊成员 <span className="bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 text-xs px-2 py-1 rounded-full">{agents.length}</span>
        </h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900 dark:hover:text-white"><X size={20} /></button>
      </div>

      {/* Agents List */}
      <div className="flex-1 overflow-y-auto p-4 bg-gray-50/50 dark:bg-zinc-900/50 space-y-3 relative">

        {/* USER PROFILE SWITCHER - First in list */}
        {userProfiles && onSwitchProfile && (
          <div className={`bg-white dark:bg-zinc-800 p-3 rounded-xl border shadow-sm relative transition-all hover:shadow-md ${
            isNarrator ? 'border-amber-300 dark:border-amber-600 ring-1 ring-amber-200 dark:ring-amber-700' : 'border-blue-200 dark:border-blue-700 ring-1 ring-blue-100 dark:ring-blue-800'
          }`}>
            <div className="flex items-center gap-3">
              <div className="relative">
                {isNarrator ? (
                  <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center border border-amber-300 dark:border-amber-600">
                    <Megaphone size={20} className="text-amber-600 dark:text-amber-400" />
                  </div>
                ) : (
                  <img
                    src={currentProfile?.avatar || ''}
                    className="w-10 h-10 rounded-full bg-white object-cover border border-blue-200 dark:border-blue-600 p-0.5"
                  />
                )}
                <div className="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 text-white rounded-full flex items-center justify-center shadow-sm">
                  <User size={10} />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm text-gray-900 dark:text-white truncate flex items-center gap-2">
                  {isNarrator ? '旁白' : (currentProfile?.name || userName)}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    isNarrator
                      ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                      : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  }`}>
                    {isNarrator ? '系统消息' : '玩家'}
                  </span>
                </h4>
                <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                  {isNarrator ? '发送的消息会显示为系统提示' : (currentProfile?.persona?.slice(0, 30) || '点击切换身份') + '...'}
                </p>
              </div>
              <button
                onClick={() => setShowProfileMenu(!showProfileMenu)}
                className="px-2 py-1 text-[10px] bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-zinc-600 transition-colors flex items-center gap-1"
              >
                切换 <ChevronDown size={10} />
              </button>
            </div>

            {/* Profile Dropdown Menu */}
            {showProfileMenu && (
              <div className="mt-3 pt-3 border-t border-gray-100 dark:border-zinc-700 space-y-1">
                {/* Narrator Option */}
                <button
                  onClick={() => { onSwitchProfile('narrator'); setShowProfileMenu(false); }}
                  className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs transition-colors ${
                    isNarrator ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : 'hover:bg-gray-50 dark:hover:bg-zinc-700 text-gray-600 dark:text-gray-300'
                  }`}
                >
                  <Megaphone size={14} className="text-amber-500" />
                  <span>旁白模式</span>
                  {isNarrator && <span className="ml-auto text-[9px] bg-amber-500 text-white px-1 rounded">当前</span>}
                </button>
                {/* User Profiles */}
                {userProfiles.map(profile => (
                  <button
                    key={profile.id}
                    onClick={() => { onSwitchProfile(profile.id); setShowProfileMenu(false); }}
                    className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs transition-colors ${
                      activeProfileId === profile.id ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'hover:bg-gray-50 dark:hover:bg-zinc-700 text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    <img src={profile.avatar} className="w-4 h-4 rounded-full object-cover border border-gray-200 dark:border-zinc-600" />
                    <span className="truncate">{profile.name}</span>
                    {activeProfileId === profile.id && <span className="ml-auto text-[9px] bg-blue-500 text-white px-1 rounded">当前</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Divider if user profiles exist */}
        {userProfiles && onSwitchProfile && agents.length > 0 && (
          <div className="flex items-center gap-2 py-1">
            <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-700"></div>
            <span className="text-[10px] text-gray-400 dark:text-gray-500">AI 成员</span>
            <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-700"></div>
          </div>
        )}

        {agents.map(agent => {
          const muteInfo = getMuteInfo(agent.id);
          const isMuted = !!muteInfo;
          const isAdmin = adminIds.includes(agent.id);
          return (
            <div key={agent.id} className={`bg-white dark:bg-zinc-800 p-3 rounded-xl border shadow-sm relative group transition-all hover:shadow-md ${isMuted ? 'opacity-60 border-gray-100 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-700' : 'border-gray-100 dark:border-zinc-700'} ${isAdmin ? 'ring-1 ring-amber-300 dark:ring-amber-600' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <img src={agent.avatar} className="w-10 h-10 rounded-full bg-white object-contain border border-gray-200 dark:border-zinc-600 p-1" />
                  {isDeleteMode && (
                    <button
                      onClick={() => onRemoveAgent(agent.id)}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 shadow-sm animate-in zoom-in duration-200"
                    >
                      <Minus size={12} strokeWidth={4} />
                    </button>
                  )}
                  {isAdmin && !isDeleteMode && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 bg-amber-500 text-white rounded-full flex items-center justify-center shadow-sm">
                      <Shield size={10} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-sm text-gray-900 dark:text-white truncate flex items-center gap-2">
                    {agent.name}
                    {isAdmin && (
                      <span className="text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <Shield size={10} /> 管理员
                      </span>
                    )}
                    {isMuted && (
                      <span className="text-[10px] bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <VolumeX size={10} /> 禁言中
                      </span>
                    )}
                  </h4>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{agent.modelId}</p>
                  {isMuted && muteInfo && (
                    <p className="text-[10px] text-orange-500 flex items-center gap-1 mt-0.5">
                      <Clock size={10} />
                      剩余: {getRemainingTime(muteInfo.muteUntil)}
                      <span className="text-gray-400">• 由 {muteInfo.mutedBy}</span>
                    </p>
                  )}
                </div>
                {!isDeleteMode && (
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => onToggleAdmin(agent.id)}
                      className={`px-2 py-1 text-[10px] rounded transition-colors flex items-center gap-1 ${isAdmin ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50' : 'bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-600'}`}
                    >
                      {isAdmin ? <ShieldOff size={10} /> : <Shield size={10} />}
                      {isAdmin ? '撤销' : '管理'}
                    </button>
                    {isMuted ? (
                      <button
                        onClick={() => onUnmuteAgent(agent.id)}
                        className="px-2 py-1 text-[10px] bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded hover:bg-green-100 dark:hover:bg-green-900/50 transition-colors"
                      >
                        解禁
                      </button>
                    ) : (
                      <button
                        onClick={() => setShowMuteMenu(showMuteMenu === agent.id ? null : agent.id)}
                        className="px-2 py-1 text-[10px] bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-zinc-600 transition-colors"
                      >
                        禁言
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Mute Duration Menu */}
              {showMuteMenu === agent.id && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-zinc-700">
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">选择禁言时长:</div>
                  <div className="grid grid-cols-4 gap-1">
                    {MUTE_DURATIONS.filter(d => d.value !== -1).map(duration => (
                      <button
                        key={duration.value}
                        onClick={() => handleMute(agent.id, duration.value)}
                        className="px-2 py-1.5 text-[10px] bg-gray-50 dark:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded hover:bg-zinc-900 hover:text-white transition-colors"
                      >
                        {duration.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input
                      type="number"
                      min="1"
                      max="525600"
                      value={customDuration}
                      onChange={(e) => setCustomDuration(e.target.value)}
                      placeholder="分钟"
                      className="flex-1 px-2 py-1.5 text-[10px] bg-gray-50 dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 rounded focus:outline-none focus:border-zinc-400 text-gray-700 dark:text-gray-200"
                    />
                    <button
                      onClick={() => handleMute(agent.id, -1)}
                      className="px-3 py-1.5 text-[10px] bg-zinc-900 dark:bg-zinc-600 text-white rounded hover:bg-black dark:hover:bg-zinc-500 transition-colors"
                    >
                      自定义
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {agents.length === 0 && (
          <div className="text-center py-10 text-gray-400">
            <User size={40} className="mx-auto mb-2 opacity-20" />
            <p className="text-sm">暂无成员</p>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-4 bg-white dark:bg-zinc-800 border-t border-gray-100 dark:border-zinc-700 relative">

        {/* Add Menu Popover - 显示未激活的角色 */}
        {showAddMenu && (
          <div className="absolute bottom-full left-0 w-full bg-white dark:bg-zinc-800 border-t border-gray-100 dark:border-zinc-700 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] rounded-t-2xl max-h-80 overflow-y-auto z-10 p-2">
            <div className="flex justify-between items-center px-2 py-2 sticky top-0 bg-white dark:bg-zinc-800 border-b border-gray-50 dark:border-zinc-700 mb-2">
              <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">选择角色加入群聊</span>
              <button onClick={() => setShowAddMenu(false)}><X size={14} className="text-gray-400" /></button>
            </div>
            <div className="space-y-1 px-2">
              {inactiveAgents.map(agent => (
                <button
                  key={agent.id}
                  onClick={() => handleActivateAgent(agent.id)}
                  className="w-full text-left px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-zinc-700 hover:bg-zinc-900 hover:text-white rounded-lg transition-colors flex items-center gap-3 group"
                >
                  <img src={agent.avatar} className="w-6 h-6 rounded-full bg-white object-contain border border-gray-200 dark:border-zinc-600" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{agent.name || '未命名角色'}</div>
                    <div className="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{agent.modelId || '未配置模型'}</div>
                  </div>
                </button>
              ))}
            </div>
            {inactiveAgents.length === 0 && (
              <div className="text-xs text-center p-4 text-gray-400">
                没有可添加的角色<br/>
                <span className="text-[10px]">请在左侧"角色"标签页创建新角色</span>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => {
              if (showAddMenu) setShowAddMenu(false);
              else setShowAddMenu(true);
              setIsDeleteMode(false);
              setShowMuteMenu(null);
            }}
            className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-all ${showAddMenu ? 'bg-zinc-900 text-white' : 'bg-gray-50 dark:bg-zinc-700 text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-zinc-600'}`}
          >
            <Plus size={18} /> 添加
          </button>

          <button
            onClick={() => {
              setIsDeleteMode(!isDeleteMode);
              setShowAddMenu(false);
              setShowMuteMenu(null);
            }}
            className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-all ${isDeleteMode ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800' : 'bg-gray-50 dark:bg-zinc-700 text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-zinc-600'}`}
          >
            {isDeleteMode ? '完成' : <><Minus size={18} /> 移除</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RightSidebar;
