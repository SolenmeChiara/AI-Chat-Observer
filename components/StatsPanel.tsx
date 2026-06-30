
import React, { useEffect, useRef, useMemo } from 'react';
import { X, MessageSquare, Type, Hash, BarChart3 } from 'lucide-react';
import { Message, Agent, GlobalSettings } from '../types';
import { USER_ID } from '../constants';
import { useT } from '../i18n';
import { calculateSessionStats, SessionStats } from '../services/statsService';
// @ts-ignore
import WordCloud from 'wordcloud';

interface StatsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  messages: Message[];
  agents: Agent[];
  userProfile?: GlobalSettings;
}

const StatsPanel: React.FC<StatsPanelProps> = ({
  isOpen,
  onClose,
  messages,
  agents,
  userProfile
}) => {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Calculate stats
  const stats = useMemo(() => {
    return calculateSessionStats(messages, agents, userProfile?.userName);
  }, [messages, agents, userProfile?.userName]);

  // Render word cloud
  useEffect(() => {
    if (!isOpen || !canvasRef.current || stats.wordFrequencies.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Prepare word list for wordcloud2
    const maxValue = Math.max(...stats.wordFrequencies.map(w => w.value));
    const wordList = stats.wordFrequencies.map(w => [
      w.text,
      Math.max(12, Math.floor((w.value / maxValue) * 60)) // Scale font size 12-60
    ]);

    // Color palette
    const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];

    try {
      WordCloud(canvas, {
        list: wordList,
        gridSize: 8,
        weightFactor: 1,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: () => colors[Math.floor(Math.random() * colors.length)],
        rotateRatio: 0.3,
        rotationSteps: 2,
        backgroundColor: 'transparent',
        shuffle: true,
        drawOutOfBound: false
      });
    } catch (e) {
      console.error('WordCloud render error:', e);
    }
  }, [isOpen, stats.wordFrequencies]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-[90%] max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-700">
          <div className="flex items-center gap-2">
            <BarChart3 size={20} className="text-blue-500" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('会话统计')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-700 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Overview Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4">
              <div className="flex items-center gap-2 text-blue-600 mb-1">
                <MessageSquare size={16} />
                <span className="text-xs font-medium">{t('总消息数')}</span>
              </div>
              <div className="text-2xl font-bold text-blue-700">{stats.totalMessages}</div>
            </div>
            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-4">
              <div className="flex items-center gap-2 text-green-600 mb-1">
                <Type size={16} />
                <span className="text-xs font-medium">{t('总字符数')}</span>
              </div>
              <div className="text-2xl font-bold text-green-700">{stats.totalChars.toLocaleString()}</div>
            </div>
            <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4">
              <div className="flex items-center gap-2 text-purple-600 mb-1">
                <Hash size={16} />
                <span className="text-xs font-medium">{t('参与者')}</span>
              </div>
              <div className="text-2xl font-bold text-purple-700">{stats.agentStats.length}</div>
            </div>
          </div>

          {/* Agent Stats Table */}
          <div>
            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">{t('发言统计')}</h3>
            <div className="bg-gray-100 dark:bg-zinc-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    <th className="px-4 py-3 font-medium">{t('成员')}</th>
                    <th className="px-4 py-3 font-medium text-right">{t('消息数')}</th>
                    <th className="px-4 py-3 font-medium text-right hidden sm:table-cell">{t('总字数')}</th>
                    <th className="px-4 py-3 font-medium text-right hidden sm:table-cell">{t('平均字数')}</th>
                    <th className="px-4 py-3 font-medium text-right">{t('占比')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-zinc-600">
                  {stats.agentStats.map((agent, idx) => (
                    <tr key={agent.agentId} className={idx % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-gray-50/50 dark:bg-zinc-800/50'}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {agent.agentId === USER_ID ? (
                            <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-zinc-700 flex items-center justify-center text-xs">
                              👤
                            </div>
                          ) : (
                            <img
                              src={agent.avatar}
                              alt=""
                              className="w-6 h-6 rounded-full object-contain bg-white border border-gray-200 dark:border-zinc-700"
                            />
                          )}
                          <span className="font-medium text-gray-900 dark:text-white truncate max-w-[120px]">
                            {agent.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-gray-700 dark:text-gray-300">
                        {agent.messageCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-gray-700 dark:text-gray-300 hidden sm:table-cell">
                        {agent.totalChars.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-gray-700 dark:text-gray-300 hidden sm:table-cell">
                        {agent.avgChars}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-2 bg-gray-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full"
                              style={{
                                width: `${stats.totalMessages > 0 ? (agent.messageCount / stats.totalMessages) * 100 : 0}%`
                              }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-right">
                            {stats.totalMessages > 0 ? Math.round((agent.messageCount / stats.totalMessages) * 100) : 0}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stats.agentStats.length === 0 && (
                <div className="text-center py-8 text-gray-400">
                  {t('暂无发言数据')}
                </div>
              )}
            </div>
          </div>

          {/* Word Cloud */}
          <div>
            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">{t('词云图')}</h3>
            <div className="bg-gray-100 dark:bg-zinc-800 rounded-xl p-4 flex items-center justify-center min-h-[250px]">
              {stats.wordFrequencies.length > 0 ? (
                <canvas
                  ref={canvasRef}
                  width={500}
                  height={250}
                  className="max-w-full"
                />
              ) : (
                <div className="text-gray-400 text-sm">
                  {t('消息不足，无法生成词云')}
                </div>
              )}
            </div>
          </div>

          {/* Top Words List */}
          {stats.wordFrequencies.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">{t('高频词汇 Top 20')}</h3>
              <div className="flex flex-wrap gap-2">
                {stats.wordFrequencies.slice(0, 20).map((word, idx) => (
                  <span
                    key={word.text}
                    className={`px-3 py-1 rounded-full text-sm font-medium ${
                      idx < 3
                        ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                        : idx < 10
                        ? 'bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-300'
                        : 'bg-gray-100 dark:bg-zinc-900 text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {word.text}
                    <span className="ml-1 text-xs opacity-60">×{word.value}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatsPanel;
