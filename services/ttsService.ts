
import { TTSEngineType, TTSVoice, TTSProvider, TTSSettings } from '../types';

// ============ DEFAULT PROVIDERS ============

export const DEFAULT_TTS_PROVIDERS: TTSProvider[] = [
  // ===== 免费 / 离线 =====
  {
    id: 'browser',
    name: '浏览器原生',
    type: 'browser',
    voices: [], // Will be populated dynamically
    freeQuota: '无限制 (离线可用)',
    description: '使用浏览器内置语音合成，免费且离线可用'
  },

  // ===== 顶级质量 =====
  {
    id: 'elevenlabs',
    name: 'ElevenLabs ⭐',
    type: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    voices: [
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (美式女)', gender: 'female', lang: 'en' },
      { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (年轻女)', gender: 'female', lang: 'en' },
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (年轻女)', gender: 'female', lang: 'en' },
      { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (温暖男)', gender: 'male', lang: 'en' },
      { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli (年轻女)', gender: 'female', lang: 'en' },
      { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh (年轻男)', gender: 'male', lang: 'en' },
      { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold (浑厚男)', gender: 'male', lang: 'en' },
      { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (深沉男)', gender: 'male', lang: 'en' },
      { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam (沙哑男)', gender: 'male', lang: 'en' },
    ],
    pricePer1MChars: 300, // $0.30/1k chars (Turbo v2.5)
    freeQuota: '10k 字符/月',
    description: '公认最自然、情感最丰富，32种语言，延迟~75ms'
  },
  {
    id: 'cartesia',
    name: 'Cartesia Sonic ⚡',
    type: 'cartesia',
    baseUrl: 'https://api.cartesia.ai',
    voices: [
      { id: 'a0e99841-438c-4a64-b679-ae501e7d6091', name: 'Barbershop Man', gender: 'male', lang: 'en' },
      { id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'British Lady', gender: 'female', lang: 'en-GB' },
      { id: '638efaaa-4d0c-442e-b701-3fae16aad012', name: 'California Girl', gender: 'female', lang: 'en' },
      { id: '41534e16-2966-4c6b-9670-111411def906', name: 'Confident Man', gender: 'male', lang: 'en' },
      { id: 'bf991597-6c13-47e4-8411-91ec2de5c466', name: 'Friendly Sidekick', gender: 'male', lang: 'en' },
      { id: '71a7ad14-091c-4e8e-a314-022ece01c121', name: 'Gentle Lady', gender: 'female', lang: 'en' },
      { id: '95856005-0332-41b0-935f-352e296aa0df', name: 'Laidback Woman', gender: 'female', lang: 'en' },
      { id: '996a8b96-4804-46c0-8e82-f5f35f5e9eac', name: 'Midwestern Man', gender: 'male', lang: 'en' },
      { id: 'c45bc5ec-dc68-4feb-8829-6e6b2748095d', name: 'Narrator Lady', gender: 'female', lang: 'en' },
      { id: 'd46abd1d-2f02-43a8-b7f5-e8f8e01e9f4a', name: 'Chinese Lady', gender: 'female', lang: 'zh' },
      { id: 'eda5bbff-1ff1-4886-8ef1-4e69a77640a0', name: 'Chinese Man', gender: 'male', lang: 'zh' },
    ],
    pricePer1MChars: 100, // ~$0.10/1k chars
    freeQuota: '无',
    description: '超低延迟40-90ms，支持emotion tags和[laughter]等非语言表达'
  },

  // ===== 性价比 =====
  {
    id: 'openai',
    name: 'OpenAI TTS',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    voices: [
      { id: 'alloy', name: 'Alloy (中性)', gender: 'neutral' },
      { id: 'ash', name: 'Ash (男)', gender: 'male' },
      { id: 'coral', name: 'Coral (女)', gender: 'female' },
      { id: 'echo', name: 'Echo (男)', gender: 'male' },
      { id: 'fable', name: 'Fable (英式男)', gender: 'male' },
      { id: 'onyx', name: 'Onyx (低沉男)', gender: 'male' },
      { id: 'nova', name: 'Nova (女)', gender: 'female' },
      { id: 'sage', name: 'Sage (女)', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer (柔和女)', gender: 'female' },
    ],
    pricePer1MChars: 15, // tts-1: $0.015/1k chars
    freeQuota: '无',
    description: 'OpenAI生态，简单易用，tts-1-hd更高质量$30/1M'
  },
  {
    id: 'fishaudio',
    name: 'Fish Audio 🐟',
    type: 'fishaudio',
    baseUrl: 'https://api.fish.audio/v1',
    voices: [
      { id: '7f92f8afb8ec43bf81429cc1c9199cb1', name: '丁真', gender: 'male', lang: 'zh' },
      { id: '54a5170264694bfc8e9ad98df7bd89c3', name: 'AD学姐', gender: 'female', lang: 'zh' },
      { id: '0eb38bc974e1459facca38b359e13511', name: '雷军', gender: 'male', lang: 'zh' },
      { id: 'e58b0d7efca34eb38d5c4985e378abcb', name: '可莉', gender: 'female', lang: 'zh' },
      { id: '3a558a19a7e4497186e5ece1c88da6da', name: '派蒙', gender: 'female', lang: 'zh' },
    ],
    pricePer1MChars: 15, // ~$15/1M bytes
    freeQuota: '100次/天 (免费)',
    description: '开源TTS，中文最佳，20万+社区音色，支持voice clone'
  },

  // ===== 中文专属 =====
  {
    id: 'minimax',
    name: 'MiniMax 语音',
    type: 'minimax',
    baseUrl: 'https://api.minimax.chat/v1',
    voices: [
      { id: 'male-qn-qingse', name: '青涩青年', gender: 'male', lang: 'zh' },
      { id: 'male-qn-jingying', name: '精英青年', gender: 'male', lang: 'zh' },
      { id: 'male-qn-badao', name: '霸道青年', gender: 'male', lang: 'zh' },
      { id: 'male-qn-daxuesheng', name: '大学生', gender: 'male', lang: 'zh' },
      { id: 'female-shaonv', name: '少女', gender: 'female', lang: 'zh' },
      { id: 'female-yujie', name: '御姐', gender: 'female', lang: 'zh' },
      { id: 'female-chengshu', name: '成熟女性', gender: 'female', lang: 'zh' },
      { id: 'female-tianmei', name: '甜美女声', gender: 'female', lang: 'zh' },
      { id: 'presenter_male', name: '男主播', gender: 'male', lang: 'zh' },
      { id: 'presenter_female', name: '女主播', gender: 'female', lang: 'zh' },
      { id: 'audiobook_male_1', name: '有声书男1', gender: 'male', lang: 'zh' },
      { id: 'audiobook_female_1', name: '有声书女1', gender: 'female', lang: 'zh' },
    ],
    pricePer1MChars: 30, // Speech-02-Turbo
    freeQuota: '无',
    description: '中文表现力佳，适合有声书和播客'
  },

  // ===== 内容创作 =====
  {
    id: 'playht',
    name: 'PlayHT',
    type: 'playht',
    baseUrl: 'https://api.play.ht/api/v2',
    voices: [
      { id: 's3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json', name: 'Jennifer (美式女)', gender: 'female', lang: 'en' },
      { id: 's3://voice-cloning-zero-shot/820da3d2-3a3b-42e7-844d-e68db835a206/sarah/manifest.json', name: 'Sarah (年轻女)', gender: 'female', lang: 'en' },
      { id: 's3://voice-cloning-zero-shot/65f4e31f-c0c4-4b0b-a7c8-f98b99b3f3e6/male/manifest.json', name: 'Michael (美式男)', gender: 'male', lang: 'en' },
    ],
    pricePer1MChars: 50,
    freeQuota: '2500字符/月',
    description: '适合Podcast和视频配音，支持WebSocket流式'
  },

  // ===== 企业级 =====
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
      { id: 'zh-CN-YunfengNeural', name: '云枫 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'zh-CN-YunhaoNeural', name: '云皓 (男)', gender: 'male', lang: 'zh-CN' },
      { id: 'en-US-JennyNeural', name: 'Jenny (美式女)', gender: 'female', lang: 'en-US' },
      { id: 'en-US-GuyNeural', name: 'Guy (美式男)', gender: 'male', lang: 'en-US' },
      { id: 'en-US-AriaNeural', name: 'Aria (美式女)', gender: 'female', lang: 'en-US' },
      { id: 'en-GB-SoniaNeural', name: 'Sonia (英式女)', gender: 'female', lang: 'en-GB' },
      { id: 'en-GB-RyanNeural', name: 'Ryan (英式男)', gender: 'male', lang: 'en-GB' },
      { id: 'ja-JP-NanamiNeural', name: '七海 (日语女)', gender: 'female', lang: 'ja-JP' },
      { id: 'ja-JP-KeitaNeural', name: '圭太 (日语男)', gender: 'male', lang: 'ja-JP' },
      { id: 'ko-KR-SunHiNeural', name: '선희 (韩语女)', gender: 'female', lang: 'ko-KR' },
    ],
    pricePer1MChars: 16,
    freeQuota: '50万字符/月 (免费层)',
    description: '140+语言400+音色，支持Custom Neural Voice'
  },
  {
    id: 'google',
    name: 'Google Cloud TTS',
    type: 'google',
    baseUrl: 'https://texttospeech.googleapis.com/v1',
    voices: [
      { id: 'cmn-CN-Standard-A', name: '中文女声A', gender: 'female', lang: 'zh-CN' },
      { id: 'cmn-CN-Standard-B', name: '中文男声B', gender: 'male', lang: 'zh-CN' },
      { id: 'cmn-CN-Standard-C', name: '中文男声C', gender: 'male', lang: 'zh-CN' },
      { id: 'cmn-CN-Standard-D', name: '中文女声D', gender: 'female', lang: 'zh-CN' },
      { id: 'cmn-CN-Wavenet-A', name: '中文女声WaveNet', gender: 'female', lang: 'zh-CN' },
      { id: 'cmn-CN-Wavenet-B', name: '中文男声WaveNet', gender: 'male', lang: 'zh-CN' },
      { id: 'en-US-Standard-A', name: 'English Male A', gender: 'male', lang: 'en-US' },
      { id: 'en-US-Standard-C', name: 'English Female C', gender: 'female', lang: 'en-US' },
      { id: 'en-US-Wavenet-D', name: 'English Male WaveNet', gender: 'male', lang: 'en-US' },
      { id: 'en-US-Wavenet-F', name: 'English Female WaveNet', gender: 'female', lang: 'en-US' },
      { id: 'ja-JP-Standard-A', name: '日语女声', gender: 'female', lang: 'ja-JP' },
      { id: 'ja-JP-Standard-C', name: '日语男声', gender: 'male', lang: 'ja-JP' },
    ],
    pricePer1MChars: 16, // Standard: $4, WaveNet: $16, Neural2/Studio: $16
    freeQuota: '400万字符/月 (免费层)',
    description: '380+音色50+语言，Studio/Journey更高质量'
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

  // ElevenLabs speed must be between 0.7 and 1.2
  const speed = Math.max(0.7, Math.min(1.2, settings.rate));

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
        speed: speed,
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

// Google Cloud TTS
const playGoogleTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('Google Cloud API key not configured');

  // Extract language from voiceId (e.g., "cmn-CN-Standard-A" -> "cmn-CN")
  const langMatch = voiceId.match(/^([a-z]{2,3}-[A-Z]{2})/);
  const languageCode = langMatch ? langMatch[1] : 'en-US';

  const response = await fetch(`${provider.baseUrl}/text:synthesize?key=${provider.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: cleanText },
      voice: { languageCode, name: voiceId },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: settings.rate,
        volumeGainDb: (settings.volume - 1) * 6, // Convert 0-1 to dB
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Google TTS error: ${error.error?.message || response.status}`);
  }

  const data = await response.json();
  const audioBlob = base64ToBlob(data.audioContent, 'audio/mp3');
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// Cartesia Sonic TTS
const playCartesiaTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('Cartesia API key not configured');

  const response = await fetch(`${provider.baseUrl}/tts/bytes`, {
    method: 'POST',
    headers: {
      'X-API-Key': provider.apiKey,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-english',
      transcript: cleanText,
      voice: { mode: 'id', id: voiceId },
      output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 },
      language: 'en',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cartesia TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// PlayHT TTS
const playPlayHTTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.apiKey) throw new Error('PlayHT API key not configured');

  // PlayHT uses userId:apiKey format
  const [userId, apiKey] = provider.apiKey.includes(':')
    ? provider.apiKey.split(':')
    : ['', provider.apiKey];

  const response = await fetch(`${provider.baseUrl}/tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'X-User-Id': userId,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: cleanText,
      voice: voiceId,
      output_format: 'mp3',
      speed: settings.rate,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PlayHT TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  return playAudioBlob(audioBlob, settings.volume, cleanText.length);
};

// Custom OpenAI-compatible TTS (for custom providers)
const playCustomTTS = async (
  text: string,
  voiceId: string,
  provider: TTSProvider,
  settings: TTSSettings
): Promise<{ chars: number }> => {
  const cleanText = cleanTextForTTS(text);
  if (!cleanText) return { chars: 0 };

  if (!provider.baseUrl) throw new Error('Custom TTS base URL not configured');

  // Use OpenAI-compatible format by default
  const response = await fetch(`${provider.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: cleanText,
      voice: voiceId || 'alloy',
      speed: settings.rate,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Custom TTS error: ${error}`);
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
    case 'google':
      result = await playGoogleTTS(text, voiceId, provider, settings);
      break;
    case 'cartesia':
      result = await playCartesiaTTS(text, voiceId, provider, settings);
      break;
    case 'playht':
      result = await playPlayHTTTS(text, voiceId, provider, settings);
      break;
    case 'custom':
      result = await playCustomTTS(text, voiceId, provider, settings);
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

// ============ DYNAMIC VOICE FETCHING ============

/**
 * Fetch available voices from ElevenLabs API
 * Returns array of TTSVoice objects
 */
export const fetchElevenLabsVoices = async (apiKey: string): Promise<TTSVoice[]> => {
  if (!apiKey) throw new Error('ElevenLabs API key required');

  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    method: 'GET',
    headers: {
      'xi-api-key': apiKey,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`ElevenLabs API error: ${error.detail?.message || response.status}`);
  }

  const data = await response.json();

  // Map API response to TTSVoice format
  return (data.voices || []).map((voice: any) => ({
    id: voice.voice_id,
    name: voice.name,
    gender: voice.labels?.gender || 'neutral',
    lang: voice.labels?.language || 'en',
  }));
};

/**
 * Fetch available voices from Fish Audio API
 */
export const fetchFishAudioVoices = async (apiKey: string): Promise<TTSVoice[]> => {
  if (!apiKey) throw new Error('Fish Audio API key required');

  // Fish Audio uses /model endpoint to list available voice models
  const response = await fetch('https://api.fish.audio/model?page_size=20&sort=score', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fish Audio API error: ${error}`);
  }

  const data = await response.json();

  return (data.items || []).map((model: any) => ({
    id: model._id,
    name: model.title || model.name || model._id,
    gender: 'neutral' as const,
    lang: model.language || 'zh',
  }));
};

/**
 * Fetch voices for a provider (if supported)
 * Returns null if provider doesn't support dynamic voice fetching
 */
export const fetchProviderVoices = async (
  provider: TTSProvider
): Promise<TTSVoice[] | null> => {
  if (!provider.apiKey) return null;

  switch (provider.type) {
    case 'elevenlabs':
      return fetchElevenLabsVoices(provider.apiKey);
    case 'fishaudio':
      return fetchFishAudioVoices(provider.apiKey);
    default:
      return null; // Provider doesn't support dynamic voice fetching
  }
};

// Legacy exports for compatibility
export const OPENAI_VOICES = DEFAULT_TTS_PROVIDERS.find(p => p.id === 'openai')?.voices || [];
