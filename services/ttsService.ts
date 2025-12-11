
import { TTSEngineType, TTSVoice, TTSProvider, TTSSettings } from '../types';

// ============ DEFAULT PROVIDERS ============

export const DEFAULT_TTS_PROVIDERS: TTSProvider[] = [
  {
    id: 'browser',
    name: '浏览器原生',
    type: 'browser',
    voices: [], // Will be populated dynamically
    freeQuota: '无限制 (离线可用)'
  },
  {
    id: 'openai',
    name: 'OpenAI TTS',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    voices: [
      { id: 'alloy', name: 'Alloy (中性)', gender: 'neutral' },
      { id: 'echo', name: 'Echo (男声)', gender: 'male' },
      { id: 'fable', name: 'Fable (英式)', gender: 'male' },
      { id: 'onyx', name: 'Onyx (低沉男声)', gender: 'male' },
      { id: 'nova', name: 'Nova (女声)', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer (柔和女声)', gender: 'female' },
    ],
    pricePer1MChars: 15,
    freeQuota: '无'
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    type: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    voices: [
      { id: 'Rachel', name: 'Rachel (美式女声)', gender: 'female', lang: 'en' },
      { id: 'Drew', name: 'Drew (美式男声)', gender: 'male', lang: 'en' },
      { id: 'Clyde', name: 'Clyde (美式男声)', gender: 'male', lang: 'en' },
      { id: 'Paul', name: 'Paul (新闻播报)', gender: 'male', lang: 'en' },
      { id: 'Domi', name: 'Domi (年轻女声)', gender: 'female', lang: 'en' },
      { id: 'Dave', name: 'Dave (英式男声)', gender: 'male', lang: 'en-GB' },
      { id: 'Fin', name: 'Fin (爱尔兰男声)', gender: 'male', lang: 'en-IE' },
      { id: 'Sarah', name: 'Sarah (柔和女声)', gender: 'female', lang: 'en' },
      { id: 'Antoni', name: 'Antoni (温暖男声)', gender: 'male', lang: 'en' },
      { id: 'Elli', name: 'Elli (年轻女声)', gender: 'female', lang: 'en' },
      { id: 'Josh', name: 'Josh (年轻男声)', gender: 'male', lang: 'en' },
      { id: 'Arnold', name: 'Arnold (浑厚男声)', gender: 'male', lang: 'en' },
      { id: 'Adam', name: 'Adam (深沉男声)', gender: 'male', lang: 'en' },
      { id: 'Sam', name: 'Sam (沙哑男声)', gender: 'male', lang: 'en' },
    ],
    pricePer1MChars: 200, // ~$0.20/1k chars = $200/1M
    freeQuota: '10k 字符/月'
  },
  {
    id: 'minimax',
    name: 'MiniMax (中文最佳)',
    type: 'minimax',
    baseUrl: 'https://api.minimax.chat/v1',
    voices: [
      { id: 'male-qn-qingse', name: '青涩青年 (男)', gender: 'male', lang: 'zh' },
      { id: 'male-qn-jingying', name: '精英青年 (男)', gender: 'male', lang: 'zh' },
      { id: 'male-qn-badao', name: '霸道青年 (男)', gender: 'male', lang: 'zh' },
      { id: 'male-qn-daxuesheng', name: '大学生 (男)', gender: 'male', lang: 'zh' },
      { id: 'female-shaonv', name: '少女 (女)', gender: 'female', lang: 'zh' },
      { id: 'female-yujie', name: '御姐 (女)', gender: 'female', lang: 'zh' },
      { id: 'female-chengshu', name: '成熟女性 (女)', gender: 'female', lang: 'zh' },
      { id: 'female-tianmei', name: '甜美女声 (女)', gender: 'female', lang: 'zh' },
      { id: 'presenter_male', name: '男主播', gender: 'male', lang: 'zh' },
      { id: 'presenter_female', name: '女主播', gender: 'female', lang: 'zh' },
      { id: 'audiobook_male_1', name: '有声书男1', gender: 'male', lang: 'zh' },
      { id: 'audiobook_male_2', name: '有声书男2', gender: 'male', lang: 'zh' },
      { id: 'audiobook_female_1', name: '有声书女1', gender: 'female', lang: 'zh' },
      { id: 'audiobook_female_2', name: '有声书女2', gender: 'female', lang: 'zh' },
    ],
    pricePer1MChars: 30, // Speech-02-Turbo
    freeQuota: '无'
  },
  {
    id: 'fishaudio',
    name: 'Fish Audio',
    type: 'fishaudio',
    baseUrl: 'https://api.fish.audio/v1',
    voices: [
      { id: 'default', name: '默认声音', gender: 'neutral', lang: 'zh' },
      // Fish Audio uses voice cloning, users should add their own voices
    ],
    pricePer1MChars: 15, // ~$15/1M bytes ≈ chars
    freeQuota: '1小时/月'
  },
  {
    id: 'azure',
    name: 'Azure TTS',
    type: 'azure',
    baseUrl: 'https://eastus.tts.speech.microsoft.com',
    voices: [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-YunxiNeural', name: '云希 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunjianNeural', name: '云健 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoyiNeural', name: '晓伊 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-YunyangNeural', name: '云扬 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-XiaochenNeural', name: '晓辰 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaohanNeural', name: '晓涵 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaomengNeural', name: '晓梦 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaomoNeural', name: '晓墨 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoqiuNeural', name: '晓秋 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoruiNeural', name: '晓睿 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoshuangNeural', name: '晓双 (女/童声)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoxuanNeural', name: '晓萱 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoyanNeural', name: '晓颜 (女)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoyouNeural', name: '晓悠 (女/童声)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-YunfengNeural', name: '云枫 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunhaoNeural', name: '云皓 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunxiaNeural', name: '云夏 (男/童声)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunyeNeural', name: '云野 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunzeNeural', name: '云泽 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'en-US-JennyNeural', name: 'Jenny (美式女)', gender: 'female', lang: 'en-US' },
      { id: 'en-US-GuyNeural', name: 'Guy (美式男)', gender: 'male', lang: 'en-US' },
      { id: 'en-US-AriaNeural', name: 'Aria (美式女)', gender: 'female', lang: 'en-US' },
      { id: 'en-US-DavisNeural', name: 'Davis (美式男)', gender: 'male', lang: 'en-US' },
      { id: 'en-GB-SoniaNeural', name: 'Sonia (英式女)', gender: 'female', lang: 'en-GB' },
      { id: 'en-GB-RyanNeural', name: 'Ryan (英式男)', gender: 'male', lang: 'en-GB' },
      { id: 'ja-JP-NanamiNeural', name: '七海 (日语女)', gender: 'female', lang: 'ja-JP' },
      { id: 'ja-JP-KeitaNeural', name: '圭太 (日语男)', gender: 'male', lang: 'ja-JP' },
      { id: 'ko-KR-SunHiNeural', name: '선희 (韩语女)', gender: 'female', lang: 'ko-KR' },
      { id: 'ko-KR-InJoonNeural', name: '인준 (韩语男)', gender: 'male', lang: 'ko-KR' },
    ],
    pricePer1MChars: 16,
    freeQuota: '50万字符/月 (免费层)'
  },
];

// ============ BROWSER VOICES ============

let browserVoicesCache: TTSVoice[] = [];
let voicesLoaded = false;

export const getBrowserVoices = (): Promise<TTSVoice[]> => {
  return new Promise((resolve) => {
    if (voicesLoaded && browserVoicesCache.length > 0) {
      resolve(browserVoicesCache);
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      browserVoicesCache = voices.map((v, idx) => ({
        id: `browser-${idx}`,
        name: `${v.name}`,
        lang: v.lang,
        gender: v.name.toLowerCase().includes('female') ? 'female' as const :
                v.name.toLowerCase().includes('male') ? 'male' as const : 'neutral' as const,
      }));
      voicesLoaded = true;
      resolve(browserVoicesCache);
    };

    if (window.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    } else {
      window.speechSynthesis.onvoiceschanged = loadVoices;
      setTimeout(() => {
        if (!voicesLoaded) loadVoices();
      }, 1000);
    }
  });
};

// ============ PLAYBACK STATE ============

let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentAudio: HTMLAudioElement | null = null;
let isPlaying = false;
let onPlaybackStateChange: ((playing: boolean) => void) | null = null;

export const setPlaybackStateCallback = (callback: (playing: boolean) => void) => {
  onPlaybackStateChange = callback;
};

const updatePlaybackState = (playing: boolean) => {
  isPlaying = playing;
  onPlaybackStateChange?.(playing);
};

export const stopTTS = () => {
  if (currentUtterance) {
    window.speechSynthesis.cancel();
    currentUtterance = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  updatePlaybackState(false);
};

export const isTTSPlaying = () => isPlaying;

// ============ CLEAN TEXT ============

const cleanTextForTTS = (text: string): string => {
  return text
    .replace(/```[\s\S]*?```/g, ' 代码块 ')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
};

// ============ ENGINE-SPECIFIC IMPLEMENTATIONS ============

// Browser TTS
const playBrowserTTS = async (
  text: string,
  voiceId: string,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  return new Promise((resolve, reject) => {
    const cleanText = cleanTextForTTS(text);
    if (!cleanText) {
      resolve({ chars: 0 });
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    const voices = window.speechSynthesis.getVoices();
    const voiceIndex = parseInt(voiceId.replace('browser-', '') || '0');
    if (voices[voiceIndex]) {
      utterance.voice = voices[voiceIndex];
    }

    utterance.rate = settings.rate;
    utterance.volume = settings.volume;

    utterance.onend = () => {
      currentUtterance = null;
      updatePlaybackState(false);
      resolve({ chars: cleanText.length });
    };

    utterance.onerror = (e) => {
      currentUtterance = null;
      updatePlaybackState(false);
      reject(e);
    };

    currentUtterance = utterance;
    updatePlaybackState(true);
    window.speechSynthesis.speak(utterance);
  });
};

// OpenAI TTS
const playOpenAITTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('OpenAI API key not configured');

  const response = await fetch(`${provider.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: cleanText,
      voice: voiceId,
      speed: settings.rate,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// ElevenLabs TTS
const playElevenLabsTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('ElevenLabs API key not configured');

  const response = await fetch(`${provider.baseUrl}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': provider.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: cleanText,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: settings.rate,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// MiniMax TTS
const playMiniMaxTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('MiniMax API key not configured');

  // MiniMax uses group_id in the API key format: "group_id:api_key"
  const [groupId, apiKey] = provider.apiKey.includes(':')
    ? provider.apiKey.split(':')
    : ['', provider.apiKey];

  const response = await fetch(`${provider.baseUrl}/t2a_v2?GroupId=${groupId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'speech-01-turbo',
      text: cleanText,
      voice_setting: {
        voice_id: voiceId,
        speed: settings.rate,
        vol: settings.volume,
      },
      audio_setting: {
        format: 'mp3',
        sample_rate: 32000,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`MiniMax TTS error: ${error}`);
  }

  const data = await response.json();
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax TTS error: ${data.base_resp?.status_msg || 'Unknown error'}`);
  }

  // MiniMax returns base64 audio
  const audioData = data.data?.audio;
  if (!audioData) throw new Error('No audio data in response');

  const audioBlob = base64ToBlob(audioData, 'audio/mp3');
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// Fish Audio TTS
const playFishAudioTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('Fish Audio API key not configured');

  const response = await fetch(`${provider.baseUrl}/tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: cleanText,
      reference_id: voiceId !== 'default' ? voiceId : undefined,
      format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fish Audio TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// Azure TTS
const playAzureTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('Azure API key not configured');

  // Azure uses SSML format
  const ssml = `
    <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>
      <voice name='${voiceId}'>
        <prosody rate='${settings.rate}'>
          ${cleanText}
        </prosody>
      </voice>
    </speak>
  `;

  const response = await fetch(`${provider.baseUrl}/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': provider.apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
    },
    body: ssml,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Azure TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// ============ HELPER FUNCTIONS ============

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

const playAudioBlob = (blob: Blob, volume: number, charCount: number): Promise<{ chars: number }> => {
  return new Promise((resolve, reject) => {
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio.volume = volume;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      updatePlaybackState(false);
      resolve({ chars: charCount });
    };

    audio.onerror = (e) => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      updatePlaybackState(false);
      reject(e);
    };

    currentAudio = audio;
    updatePlaybackState(true);
    audio.play().catch(reject);
  });
};

// ============ MAIN SPEAK FUNCTION ============

export const speak = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number; cost: number }> => {
  stopTTS();

  let result: { chars: number };

  switch (provider.type) {
    case 'browser':
      result = await playBrowserTTS(text, voiceId, settings);
      break;
    case 'openai':
      result = await playOpenAITTS(text, voiceId, provider, settings);
      break;
    case 'elevenlabs':
      result = await playElevenLabsTTS(text, voiceId, provider, settings);
      break;
    case 'minimax':
      result = await playMiniMaxTTS(text, voiceId, provider, settings);
      break;
    case 'fishaudio':
      result = await playFishAudioTTS(text, voiceId, provider, settings);
      break;
    case 'azure':
      result = await playAzureTTS(text, voiceId, provider, settings);
      break;
    default:
      result = await playBrowserTTS(text, voiceId, settings);
  }

  // Calculate cost
  const cost = provider.pricePer1MChars
    ? (result.chars / 1000000) * provider.pricePer1MChars
    : 0;

  return { chars: result.chars, cost };
};

// ============ DEFAULT SETTINGS ============

export const DEFAULT_TTS_SETTINGS: TTSSettings = {
  enabled: false,
  activeProviderId: 'browser',
  rate: 1.0,
  volume: 1.0,
  autoPlayNewMessages: false,
};

// Legacy exports for compatibility
export const OPENAI_VOICES = DEFAULT_TTS_PROVIDERS.find(p => p.id === 'openai')?.voices || [];
