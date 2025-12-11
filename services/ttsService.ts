
import { TTSEngine, TTSVoice, TTSSettings } from '../types';

// OpenAI TTS voices
export const OPENAI_VOICES: TTSVoice[] = [
  { id: 'alloy', name: 'Alloy (中性)', engine: 'openai' },
  { id: 'echo', name: 'Echo (男声)', engine: 'openai' },
  { id: 'fable', name: 'Fable (英式)', engine: 'openai' },
  { id: 'onyx', name: 'Onyx (低沉男声)', engine: 'openai' },
  { id: 'nova', name: 'Nova (女声)', engine: 'openai' },
  { id: 'shimmer', name: 'Shimmer (柔和女声)', engine: 'openai' },
];

// Cache browser voices
let browserVoicesCache: TTSVoice[] = [];
let voicesLoaded = false;

// Get available browser voices
export const getBrowserVoices = (): Promise<TTSVoice[]> => {
  return new Promise((resolve) => {
    if (voicesLoaded && browserVoicesCache.length > 0) {
      resolve(browserVoicesCache);
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      browserVoicesCache = voices.map((v, idx) => ({
        id: `browser-${idx}-${v.name}`,
        name: `${v.name} (${v.lang})`,
        lang: v.lang,
        engine: 'browser' as TTSEngine,
      }));
      voicesLoaded = true;
      resolve(browserVoicesCache);
    };

    // Chrome loads voices async
    if (window.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    } else {
      window.speechSynthesis.onvoiceschanged = loadVoices;
      // Fallback timeout
      setTimeout(() => {
        if (!voicesLoaded) loadVoices();
      }, 1000);
    }
  });
};

// Get all available voices for a specific engine
export const getVoicesForEngine = async (engine: TTSEngine): Promise<TTSVoice[]> => {
  if (engine === 'openai') {
    return OPENAI_VOICES;
  }
  return getBrowserVoices();
};

// Get a subset of voices for auto-assignment (diverse selection)
export const getAutoAssignVoices = async (engine: TTSEngine, count: number): Promise<TTSVoice[]> => {
  const voices = await getVoicesForEngine(engine);

  if (engine === 'openai') {
    // OpenAI has 6 voices, just cycle through them
    const result: TTSVoice[] = [];
    for (let i = 0; i < count; i++) {
      result.push(voices[i % voices.length]);
    }
    return result;
  }

  // For browser voices, try to pick diverse ones (different languages/genders)
  // Prioritize Chinese and English voices
  const prioritized = voices.filter(v =>
    v.lang?.startsWith('zh') || v.lang?.startsWith('en')
  );

  const pool = prioritized.length >= count ? prioritized : voices;
  const result: TTSVoice[] = [];
  const step = Math.max(1, Math.floor(pool.length / count));

  for (let i = 0; i < count && i * step < pool.length; i++) {
    result.push(pool[i * step]);
  }

  // Fill remaining with cycling
  while (result.length < count && pool.length > 0) {
    result.push(pool[result.length % pool.length]);
  }

  return result;
};

// Current playback state
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentAudio: HTMLAudioElement | null = null;
let isPlaying = false;
let playbackQueue: Array<{ text: string; voiceId: string; engine: TTSEngine; onEnd?: () => void }> = [];
let onPlaybackStateChange: ((playing: boolean) => void) | null = null;

// Set callback for playback state changes
export const setPlaybackStateCallback = (callback: (playing: boolean) => void) => {
  onPlaybackStateChange = callback;
};

const updatePlaybackState = (playing: boolean) => {
  isPlaying = playing;
  onPlaybackStateChange?.(playing);
};

// Stop current playback
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
  playbackQueue = [];
  updatePlaybackState(false);
};

// Pause current playback
export const pauseTTS = () => {
  if (currentUtterance) {
    window.speechSynthesis.pause();
  }
  if (currentAudio) {
    currentAudio.pause();
  }
  updatePlaybackState(false);
};

// Resume playback
export const resumeTTS = () => {
  if (currentUtterance) {
    window.speechSynthesis.resume();
    updatePlaybackState(true);
  }
  if (currentAudio && currentAudio.paused && currentAudio.src) {
    currentAudio.play();
    updatePlaybackState(true);
  }
};

// Check if currently playing
export const isTTSPlaying = () => isPlaying;

// Play text using browser TTS
const playBrowserTTS = async (
  text: string,
  voiceId: string,
  settings: TTSSettings
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);

    // Find the voice
    const voices = window.speechSynthesis.getVoices();
    const voiceIndex = parseInt(voiceId.split('-')[1] || '0');
    if (voices[voiceIndex]) {
      utterance.voice = voices[voiceIndex];
    }

    utterance.rate = settings.rate;
    utterance.volume = settings.volume;

    utterance.onend = () => {
      currentUtterance = null;
      updatePlaybackState(false);
      resolve();
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

// Play text using OpenAI TTS
const playOpenAITTS = async (
  text: string,
  voiceId: string,
  settings: TTSSettings
): Promise<void> => {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key not configured for TTS');
  }

  const baseUrl = settings.openaiBaseUrl || 'https://api.openai.com/v1';

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voiceId,
      speed: settings.rate,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI TTS error: ${error}`);
  }

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);

  return new Promise((resolve, reject) => {
    const audio = new Audio(audioUrl);
    audio.volume = settings.volume;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      updatePlaybackState(false);
      resolve();
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

// Main speak function
export const speak = async (
  text: string,
  voiceId: string,
  engine: TTSEngine,
  settings: TTSSettings
): Promise<void> => {
  // Stop any current playback first
  stopTTS();

  // Clean up text (remove markdown, etc.)
  const cleanText = text
    .replace(/```[\s\S]*?```/g, ' 代码块 ')  // Replace code blocks
    .replace(/`[^`]+`/g, '')                  // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert links to text
    .replace(/[#*_~]/g, '')                   // Remove markdown symbols
    .replace(/\n+/g, ' ')                     // Replace newlines with spaces
    .trim();

  if (!cleanText) return;

  if (engine === 'openai') {
    await playOpenAITTS(cleanText, voiceId, settings);
  } else {
    await playBrowserTTS(cleanText, voiceId, settings);
  }
};

// Queue-based playback for continuous reading
export const queueSpeak = (
  text: string,
  voiceId: string,
  engine: TTSEngine,
  onEnd?: () => void
) => {
  playbackQueue.push({ text, voiceId, engine, onEnd });
};

// Process the queue
export const processQueue = async (settings: TTSSettings) => {
  while (playbackQueue.length > 0) {
    const item = playbackQueue.shift();
    if (!item) break;

    try {
      await speak(item.text, item.voiceId, item.engine, settings);
      item.onEnd?.();
    } catch (error) {
      console.error('TTS playback error:', error);
      item.onEnd?.();
    }
  }
};

// Clear the queue
export const clearQueue = () => {
  playbackQueue = [];
};

// Default TTS settings
export const DEFAULT_TTS_SETTINGS: TTSSettings = {
  enabled: false,
  engine: 'browser',
  rate: 1.0,
  volume: 1.0,
  autoPlayNewMessages: false,
};
