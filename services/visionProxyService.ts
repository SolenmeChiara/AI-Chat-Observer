
import { ApiProvider, AgentType } from '../types';

const VISION_PROMPT = `请详细描述这张图片的内容，包括：
1. 图片的主要元素和场景
2. 文字内容（如果有）
3. 重要的细节和特征
用简洁清晰的语言描述，便于没有看到图片的人理解。`;

/**
 * Use a vision-capable model to describe an image
 * Returns a text description that can be injected into text-only model context
 */
export async function describeImage(
  imageBase64: string,
  mimeType: string,
  provider: ApiProvider
): Promise<string> {

  try {
    switch (provider.type) {
      case AgentType.OPENAI_COMPATIBLE:
        return await describeWithOpenAI(imageBase64, mimeType, provider);
      case AgentType.ANTHROPIC:
        return await describeWithAnthropic(imageBase64, mimeType, provider);
      case AgentType.GEMINI:
        return await describeWithGemini(imageBase64, mimeType, provider);
      default:
        throw new Error(`Unsupported provider type for vision: ${provider.type}`);
    }
  } catch (error: any) {
    console.error('Vision proxy error:', error);
    return `[图片描述失败: ${error.message || '未知错误'}]`;
  }
}

async function describeWithOpenAI(
  imageBase64: string,
  mimeType: string,
  provider: ApiProvider
): Promise<string> {
  const modelId = provider.models[0]?.id || 'gpt-4o-mini';

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` }
          }
        ]
      }],
      max_tokens: 500
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '[无法获取描述]';
}

async function describeWithAnthropic(
  imageBase64: string,
  mimeType: string,
  provider: ApiProvider
): Promise<string> {
  const modelId = provider.models[0]?.id || 'claude-3-5-sonnet-20241022';

  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageBase64
            }
          },
          { type: 'text', text: VISION_PROMPT }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '[无法获取描述]';
}

async function describeWithGemini(
  imageBase64: string,
  mimeType: string,
  provider: ApiProvider
): Promise<string> {
  // Dynamic import to avoid bundling issues
  const { GoogleGenAI } = await import('@google/genai');

  const client = new GoogleGenAI({ apiKey: provider.apiKey || '' });
  const modelId = provider.models[0]?.id || 'gemini-2.0-flash';

  const response = await client.models.generateContent({
    model: modelId,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: VISION_PROMPT }
      ]
    }]
  });

  return response.text || '[无法获取描述]';
}
