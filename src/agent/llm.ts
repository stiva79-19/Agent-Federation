/**
 * LLM API Client — Agent Federation
 *
 * OpenAI-uyumlu API client. Fetch tabanlı, sıfır dependency.
 * Chat completion ve streaming destekler.
 *
 * OpenClaw Gateway üzerinden çalışır (varsayılan).
 * Gateway OpenAI-uyumlu chat completion API sağlar.
 *
 * Yapılandırma öncelik sırası:
 * 1. Doğrudan override (constructor parametreleri)
 * 2. AGENT_LLM_* env var'ları
 * 3. OPENCLAW_GATEWAY_* env var'ları (Gateway URL + token)
 * 4. Varsayılan: http://localhost:18789/v1 (OpenClaw Gateway)
 */

/**
 * Chat mesajı formatı (OpenAI uyumlu).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM yapılandırması.
 */
export interface LLMConfig {
  /** API base URL */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Model adı */
  model: string;
  /** Maksimum token sayısı (cevap) */
  maxTokens: number;
  /** Temperature (0-2) */
  temperature: number;
  /** Timeout (ms) */
  timeoutMs: number;
}

/**
 * Chat completion API yanıtı.
 */
interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Streaming chunk formatı.
 */
interface StreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

/**
 * Token kullanım istatistikleri.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * OpenClaw Gateway yapılandırmasını env var'lardan çözer.
 * OPENCLAW_GATEWAY_URL varsa base URL ve token'ı oradan alır.
 */
function resolveGatewayConfig(): { baseUrl: string; apiKey: string; model: string } {
  const gatewayUrl = process.env['OPENCLAW_GATEWAY_URL'];
  const gatewayToken = process.env['OPENCLAW_GATEWAY_TOKEN'] ?? '';

  if (gatewayUrl) {
    return {
      baseUrl: `${gatewayUrl.replace(/\/+$/, '')}/v1`,
      apiKey: gatewayToken,
      model: 'qwen3.5-plus',
    };
  }

  // Varsayılan: OpenClaw Gateway localhost
  return {
    baseUrl: 'http://localhost:18789/v1',
    apiKey: '',
    model: 'qwen3.5-plus',
  };
}

/**
 * Env var'lardan LLM yapılandırması oluşturur.
 *
 * Öncelik: override > AGENT_LLM_* env > OpenClaw Gateway env > varsayılan
 */
export function loadLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  const gateway = resolveGatewayConfig();

  return {
    baseUrl: overrides?.baseUrl ?? process.env['AGENT_LLM_BASE_URL'] ?? gateway.baseUrl,
    apiKey: overrides?.apiKey ?? process.env['AGENT_LLM_API_KEY'] ?? gateway.apiKey,
    model: overrides?.model ?? process.env['AGENT_LLM_MODEL'] ?? gateway.model,
    maxTokens: overrides?.maxTokens ?? 1024,
    temperature: overrides?.temperature ?? 0.7,
    timeoutMs: overrides?.timeoutMs ?? 30_000,
  };
}

/**
 * LLM API Client.
 * OpenAI-uyumlu herhangi bir API ile çalışır (OpenAI, Anthropic proxy, Ollama, vb).
 */
export class LLMClient {
  private config: LLMConfig;
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(config?: Partial<LLMConfig>) {
    this.config = loadLLMConfig(config);
  }

  /**
   * API key'in ayarlanıp ayarlanmadığını kontrol eder.
   */
  isConfigured(): boolean {
    return this.config.apiKey.length > 0;
  }

  /**
   * Mevcut model adını döner.
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Toplam token kullanımını döner.
   */
  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  /**
   * Yapılandırmayı günceller.
   */
  updateConfig(updates: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Chat completion — tek seferde tam cevap döner.
   *
   * @param messages - Mesaj geçmişi
   * @returns LLM cevabı
   * @throws API hatası veya timeout durumunda
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('LLM API key yapılandırılmamış. AGENT_LLM_API_KEY env var\'ını ayarlayın.');
    }

    const url = `${this.config.baseUrl}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`LLM API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as ChatCompletionResponse;

      // Token kullanımını güncelle
      if (data.usage) {
        this.totalUsage.promptTokens += data.usage.prompt_tokens;
        this.totalUsage.completionTokens += data.usage.completion_tokens;
        this.totalUsage.totalTokens += data.usage.total_tokens;
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM boş cevap döndürdü');
      }

      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Streaming chat completion — kelime kelime cevap döner.
   *
   * @param messages - Mesaj geçmişi
   * @yields Her bir token/chunk string olarak
   */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<string, void, undefined> {
    if (!this.isConfigured()) {
      throw new Error('LLM API key yapılandırılmamış. AGENT_LLM_API_KEY env var\'ını ayarlayın.');
    }

    const url = `${this.config.baseUrl}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`LLM API error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null — streaming desteklenmiyor olabilir');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Son satır eksik olabilir, buffer'da tut
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6); // 'data: ' prefix'ini kaldır
          if (data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data) as StreamChunk;
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // JSON parse hatası — devam et
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
