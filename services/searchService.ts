// 搜索服务 - 支持多种搜索引擎
import { SearchEngine, SearchConfig } from '../types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  error?: string;
}

// Serper API (Google Search)
async function searchWithSerper(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: query,
      num: 5
    })
  });

  if (!response.ok) {
    throw new Error(`Serper API 错误: ${response.status}`);
  }

  const data = await response.json();
  return (data.organic || []).map((item: any) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet || ''
  }));
}

// Brave Search API
async function searchWithBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
    headers: {
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Brave API 错误: ${response.status}`);
  }

  const data = await response.json();
  return (data.web?.results || []).map((item: any) => ({
    title: item.title,
    url: item.url,
    snippet: item.description || ''
  }));
}

// Tavily API
async function searchWithTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      max_results: 5,
      include_answer: false
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily API 错误: ${response.status}`);
  }

  const data = await response.json();
  return (data.results || []).map((item: any) => ({
    title: item.title,
    url: item.url,
    snippet: item.content || ''
  }));
}

// Metaso API (秘塔搜索)
async function searchWithMetaso(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://api.metaso.cn/api/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: query,
      num: 5
    })
  });

  if (!response.ok) {
    throw new Error(`Metaso API 错误: ${response.status}`);
  }

  const data = await response.json();
  return (data.results || []).map((item: any) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet || item.content || ''
  }));
}

// 主搜索函数
export async function performSearch(
  query: string,
  config: SearchConfig
): Promise<SearchResponse> {
  if (!config.enabled || !config.apiKey) {
    return { query, results: [], error: '搜索未启用或未配置 API Key' };
  }

  try {
    let results: SearchResult[];

    switch (config.engine) {
      case 'serper':
        results = await searchWithSerper(query, config.apiKey);
        break;
      case 'brave':
        results = await searchWithBrave(query, config.apiKey);
        break;
      case 'tavily':
        results = await searchWithTavily(query, config.apiKey);
        break;
      case 'metaso':
        results = await searchWithMetaso(query, config.apiKey);
        break;
      default:
        return { query, results: [], error: `不支持的搜索引擎: ${config.engine}` };
    }

    return { query, results };
  } catch (error: any) {
    console.error('搜索失败:', error);
    // Provide more helpful error messages
    let errorMsg = error.message || '搜索请求失败';
    if (error.message?.includes('Failed to fetch') || error.name === 'TypeError') {
      errorMsg = '网络请求失败 (可能是 CORS 跨域限制，部分搜索引擎需要后端代理)';
    }
    return { query, results: [], error: errorMsg };
  }
}

// 格式化搜索结果为文本 (供 AI 上下文使用)
export function formatSearchResultsForContext(response: SearchResponse): string {
  if (response.error) {
    return `[搜索错误] ${response.error}`;
  }

  if (response.results.length === 0) {
    return `[搜索结果] 未找到与"${response.query}"相关的内容`;
  }

  let text = `[搜索结果] 关键词: "${response.query}"\n\n`;

  response.results.forEach((result, index) => {
    text += `${index + 1}. ${result.title}\n`;
    text += `   链接: ${result.url}\n`;
    text += `   摘要: ${result.snippet}\n\n`;
  });

  return text.trim();
}

// 格式化搜索结果为 Markdown (供 UI 显示)
export function formatSearchResultsForDisplay(response: SearchResponse): string {
  if (response.error) {
    return `**搜索错误:** ${response.error}`;
  }

  if (response.results.length === 0) {
    return `未找到与 "${response.query}" 相关的结果`;
  }

  let markdown = `**搜索结果:** "${response.query}"\n\n`;

  response.results.forEach((result, index) => {
    markdown += `${index + 1}. **[${result.title}](${result.url})**\n`;
    markdown += `   ${result.snippet}\n\n`;
  });

  return markdown.trim();
}
