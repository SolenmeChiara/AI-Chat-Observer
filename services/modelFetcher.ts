
import { ApiProvider, AgentType, ModelConfig } from '../types';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Known model pricing (per 1M tokens). Used as fallback when API doesn't return prices.
const KNOWN_PRICING: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus-4-6': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-sonnet-4-6': [3, 15], 'claude-sonnet-4-5-20241022': [3, 15],
  'claude-haiku-4-5-20251001': [0.8, 4], 'claude-haiku-3-5-20241022': [0.8, 4],
  'claude-3-5-sonnet-20241022': [3, 15], 'claude-3-5-haiku-20241022': [0.8, 4],
  // OpenAI
  'gpt-5.5': [5, 30], 'gpt-5.5-pro': [30, 180],
  'gpt-5.4': [2.5, 15], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.4-nano': [0.2, 1.25], 'gpt-5.4-pro': [30, 180],
  'gpt-5.2': [1.75, 14], 'gpt-5.2-pro': [21, 168],
  'gpt-5.1': [1.25, 10],
  'gpt-5': [1.25, 10], 'gpt-5-mini': [0.25, 2], 'gpt-5-nano': [0.05, 0.4], 'gpt-5-pro': [15, 120],
  'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6],
  'o1': [15, 60], 'o3-pro': [20, 80], 'o3': [2, 8], 'o4-mini': [1.1, 4.4], 'o3-mini': [1.1, 4.4],
  'gpt-image-2': [8, 30], 'gpt-image-1.5': [8, 32], 'gpt-image-1': [10, 40], 'gpt-image-1-mini': [2.5, 8],
  'chatgpt-image-latest': [8, 32],
  // Gemini
  'gemini-3.5-flash': [1.5, 9],
  'gemini-3.1-flash-lite': [0.25, 1.5], 'gemini-3.1-pro-preview': [2, 12], 'gemini-3.1-flash-image': [0.5, 3],
  'gemini-3-flash-preview': [0.5, 3], 'gemini-3-pro-image': [2, 12],
  'gemini-2.5-pro': [1.25, 10], 'gemini-2.5-flash': [0.3, 2.5], 'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-flash-image': [0.3, 2.5],
  // DeepSeek
  'deepseek-chat': [0.27, 1.10], 'deepseek-reasoner': [0.55, 2.19],
};

function lookupPricing(modelId: string): [number, number] | undefined {
  const lower = modelId.toLowerCase();
  if (KNOWN_PRICING[lower]) return KNOWN_PRICING[lower];
  for (const [key, price] of Object.entries(KNOWN_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) return price;
  }
  return undefined;
}

export const fetchRemoteModels = async (provider: ApiProvider): Promise<ModelConfig[]> => {
  let url = '';
  let headers: Record<string, string> = {};

  if (!provider.apiKey) {
    throw new Error('请先输入 API Key');
  }

  // 1. Determine Endpoint and Headers based on Type
  if (provider.type === AgentType.GEMINI) {
    // Google uses a different structure, usually URL param for key
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${provider.apiKey}`;
  } else if (provider.type === AgentType.ANTHROPIC) {
    // Anthropic Native
    url = `https://api.anthropic.com/v1/models`;
    headers = {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  } else {
    // OpenAI Compatible (Universal)
    // Ensure we strip trailing slash and append /models
    const baseUrl = provider.baseUrl ? provider.baseUrl.replace(/\/+$/, '') : 'https://api.openai.com/v1';
    url = `${baseUrl}/models`;
    headers = {
      'Authorization': `Bearer ${provider.apiKey}`
    };
  }

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
        response = await fetch(url, { method: 'GET', headers });
        
        if (!response.ok) {
            // Handle Rate Limits (429) or Server Errors (5xx)
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_RETRIES) {
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`Model Fetcher: API Error ${response.status}. Retrying in ${delay}ms...`);
                    await wait(delay);
                    continue;
                }
            }

            const errText = await response.text().catch(() => '');
            
            // Handle common 404 mistake where user omits /v1
            if (response.status === 404 && provider.type === AgentType.OPENAI_COMPATIBLE) {
                throw new Error(`404 未找到。请检查 Base URL 是否正确 (通常需要以 /v1 结尾)`);
            }
            throw new Error(`请求失败 (${response.status}): ${errText || response.statusText}`);
        }
        
        // Success
        break;
        
    } catch (error: any) {
        // Handle Network Errors
        if (attempt < MAX_RETRIES) {
             const delay = 1000 * Math.pow(2, attempt);
             console.warn(`Model Fetcher: Network/Retryable Error. Retrying in ${delay}ms...`);
             await wait(delay);
             continue;
        }
        
        // Transform generic "Failed to fetch" (Browser's CORS error) into a readable message
        if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
            let msg = "连接失败 (CORS 跨域限制)。";
            if (url.includes('api.openai.com')) {
            msg += " 注意：官方 OpenAI API 不支持浏览器直接调用，请使用 OpenRouter 或本地代理 (Proxy/OneAPI)。";
            } else if (url.includes('api.anthropic.com')) {
            msg += " 注意：虽然已启用浏览器直连模式，但部分网络环境可能仍会拦截。";
            } else {
            msg += " 请检查 URL 是否正确，并确认该服务器支持跨域访问。";
            }
            throw new Error(msg);
        }

        console.error("Fetch models failed", error);
        throw error;
    }
  }

  if (!response) {
    throw new Error("No response received from API");
  }

  try {
    const data = await response.json();
    let rawModels: any[] = [];

    // 2. Parse Response (Normalize different API structures)
    if (provider.type === AgentType.GEMINI) {
      // Google: { models: [ { name: "models/gemini-pro", ... } ] }
      rawModels = data.models || [];
      return rawModels.map((m: any) => {
        const id = m.name.replace('models/', '');
        const pricing = lookupPricing(id);
        return {
          id: id,
          name: m.displayName || id,
          inputPricePer1M: pricing?.[0] ?? 0,
          outputPricePer1M: pricing?.[1] ?? 0
        };
      });
    } else if (provider.type === AgentType.ANTHROPIC) {
      // Anthropic: { data: [ { id: "...", ... } ] }
      // NOTE: Anthropic models endpoint output might vary, but usually { data: [...] }
      // Sometimes just list of models. Assuming standard structure.
      rawModels = data.data || [];
      return rawModels.map((m: any) => {
        const pricing = lookupPricing(m.id);
        return {
          id: m.id,
          name: m.display_name || m.id,
          inputPricePer1M: pricing?.[0] ?? 0,
          outputPricePer1M: pricing?.[1] ?? 0
        };
      }).sort((a, b) => b.id.localeCompare(a.id));
    } else {
      // OpenAI Standard: { data: [...] }
      if (Array.isArray(data)) {
        rawModels = data; 
      } else if (data.data && Array.isArray(data.data)) {
        rawModels = data.data;
      } else {
         // Fallback if structure is unknown
         console.warn("Unknown response structure", data);
         throw new Error("API 返回的数据格式无法识别，请确认该接口符合 OpenAI 标准。");
      }
      
      // 3. Map to ModelConfig (OpenAI Compatible)
      return rawModels.map((m: any) => {
        // Helper to parse price safely
        const parsePrice = (val: any) => {
          if (typeof val === 'number') return val;
          if (typeof val === 'string') return parseFloat(val);
          return 0;
        };

        let inputPrice = 0;
        let outputPrice = 0;

        // OpenRouter / specific pricing detection (if provided in extras)
        if (m.pricing) {
          const promptPrice = parsePrice(m.pricing.prompt);
          const completionPrice = parsePrice(m.pricing.completion);
          if (!isNaN(promptPrice)) inputPrice = promptPrice * 1000000;
          if (!isNaN(completionPrice)) outputPrice = completionPrice * 1000000;
        }

        // Fallback to known pricing if API didn't provide any
        if (inputPrice === 0 && outputPrice === 0) {
          const known = lookupPricing(m.id);
          if (known) { inputPrice = known[0]; outputPrice = known[1]; }
        }

        // Extract clean display name
        let displayName = m.name || m.display_name || m.id;

        // If name equals id or contains "/", extract just the model part
        // e.g., "Qwen/Qwen2.5-7B-Instruct" -> "Qwen2.5-7B-Instruct"
        if (displayName === m.id && m.id.includes('/')) {
          displayName = m.id.split('/').pop() || m.id;
        }

        return {
          id: m.id,
          name: displayName,
          inputPricePer1M: inputPrice,
          outputPricePer1M: outputPrice
        };
      }).sort((a, b) => a.id.localeCompare(b.id)); // Sort alphabetically
    }

  } catch (error: any) {
    console.error("Parsing models failed", error);
    throw error;
  }
};
