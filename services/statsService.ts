
import { Message, Agent } from '../types';
import { USER_ID } from '../constants';
// @ts-ignore
import { Segment, useDefault } from 'segmentit';

// Initialize Chinese segmenter
const segmentit = new Segment();
useDefault(segmentit);

// Stop words to filter out (common words that don't add meaning)
const STOP_WORDS = new Set([
  // Chinese
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '在', '和', '与',
  '就', '都', '而', '及', '着', '或', '一个', '没有', '不是', '什么', '怎么', '这个', '那个',
  '可以', '因为', '所以', '如果', '但是', '然后', '或者', '虽然', '不过', '还是', '已经',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '个', '会', '能', '要', '把',
  '被', '让', '给', '从', '到', '对', '为', '上', '下', '中', '来', '去', '也', '又', '很',
  '太', '更', '最', '好', '多', '少', '大', '小', '长', '短', '高', '低', '新', '旧', '啊',
  '吧', '呢', '吗', '哦', '嗯', '呀', '哈', '嘿', '噢', '哇', '嗨', '喔', '唉', '哎',
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
  'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because',
  'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'am', 'been', 'being', 'did', 'doing', 'having', "i'm", "you're", "it's",
  "don't", "doesn't", "didn't", "won't", "wouldn't", "couldn't", "shouldn't",
  'yeah', 'yes', 'no', 'ok', 'okay', 'well', 'oh', 'ah', 'um', 'uh', 'like',
  // Common AI phrases to filter
  '我认为', '我觉得', '可能', '也许', '大概', '应该', '确实', '当然', '其实', '总之',
]);

export interface AgentStats {
  agentId: string;
  name: string;
  avatar: string;
  messageCount: number;
  totalChars: number;
  avgChars: number;
  passCount: number;
}

export interface WordFrequency {
  text: string;
  value: number;
}

export interface SessionStats {
  totalMessages: number;
  totalChars: number;
  agentStats: AgentStats[];
  wordFrequencies: WordFrequency[];
}

// Calculate statistics for a session
export const calculateSessionStats = (
  messages: Message[],
  agents: Agent[],
  userName?: string
): SessionStats => {
  // Filter out system messages
  const chatMessages = messages.filter(m => !m.isSystem);

  // Agent stats map
  const statsMap = new Map<string, AgentStats>();

  // Initialize stats for all agents + user
  agents.forEach(agent => {
    statsMap.set(agent.id, {
      agentId: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      messageCount: 0,
      totalChars: 0,
      avgChars: 0,
      passCount: 0
    });
  });

  // Add user entry
  statsMap.set(USER_ID, {
    agentId: USER_ID,
    name: userName || 'User',
    avatar: '',
    messageCount: 0,
    totalChars: 0,
    avgChars: 0,
    passCount: 0
  });

  // Word frequency map
  const wordFreqMap = new Map<string, number>();

  // Process each message
  let totalChars = 0;

  chatMessages.forEach(msg => {
    const stats = statsMap.get(msg.senderId);
    if (stats) {
      stats.messageCount++;
      stats.totalChars += msg.text.length;
      totalChars += msg.text.length;

      // Check for PASS (these messages are usually filtered, but just in case)
      if (msg.text.includes('{{PASS}}')) {
        stats.passCount++;
      }
    }

    // Extract words for word cloud
    extractWords(msg.text).forEach(word => {
      if (word.length >= 2 && !STOP_WORDS.has(word.toLowerCase())) {
        const lower = word.toLowerCase();
        wordFreqMap.set(lower, (wordFreqMap.get(lower) || 0) + 1);
      }
    });
  });

  // Calculate averages
  statsMap.forEach(stats => {
    if (stats.messageCount > 0) {
      stats.avgChars = Math.round(stats.totalChars / stats.messageCount);
    }
  });

  // Convert to arrays and sort
  const agentStats = Array.from(statsMap.values())
    .filter(s => s.messageCount > 0)
    .sort((a, b) => b.messageCount - a.messageCount);

  // Get top words for word cloud
  const wordFrequencies = Array.from(wordFreqMap.entries())
    .map(([text, value]) => ({ text, value }))
    .filter(w => w.value >= 2) // At least 2 occurrences
    .sort((a, b) => b.value - a.value)
    .slice(0, 100); // Top 100 words

  return {
    totalMessages: chatMessages.length,
    totalChars,
    agentStats,
    wordFrequencies
  };
};

// Extract words from text (handles both Chinese and English)
const extractWords = (text: string): string[] => {
  const words: string[] = [];

  // Remove special markers and URLs
  const cleanText = text
    .replace(/\{\{[^}]+\}\}/g, '') // Remove {{PASS}}, {{REPLY:...}} etc
    .replace(/https?:\/\/[^\s]+/g, '') // Remove URLs
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`[^`]+`/g, '') // Remove inline code
    .replace(/@[\w\u4e00-\u9fa5\-\s]+/g, '') // Remove @mentions
    .replace(/[#\*_~\[\]()]/g, ' '); // Remove markdown symbols

  // Segment Chinese text
  try {
    const segments = segmentit.doSegment(cleanText, { simple: true });
    segments.forEach((seg: string) => {
      if (seg.trim()) {
        words.push(seg.trim());
      }
    });
  } catch (e) {
    // Fallback: simple split
    cleanText.split(/\s+/).forEach(word => {
      if (word.trim()) {
        words.push(word.trim());
      }
    });
  }

  return words;
};
