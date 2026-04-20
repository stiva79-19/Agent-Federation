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
 * OpenClaw workspace'inden LLM yapılandırmasını otomatik çözer.
 *
 * Sırasıyla şunları yapar:
 * 1. ~/.openclaw/openclaw.json okur
 * 2. auth.profiles içinden api_key modundaki aktif provider'ı bulur
 *    (örn: "qwen:default" → provider: "qwen")
 * 3. models.providers.<name>.baseUrl + ilk model id'sini alır
 * 4. ~/.openclaw/credentials/<provider>.* dosyasından gerçek API key'i okur
 *    - <provider>.json (JSON: apiKey|api_key|token|key alanları)
 *    - <provider>.key veya <provider> (düz text)
 *    - Klasör içindeki tek dosya
 * 5. Her adım başarısız olursa boş/varsayılan değer döner
 *
 * @returns { baseUrl, apiKey, model, providerName }
 */
function resolveOpenClawProvider(): { baseUrl: string; apiKey: string; model: string; providerName: string } {
  const empty = { baseUrl: '', apiKey: '', model: '', providerName: '' };

  try {
    // fs ve path'i inline require et (isomorphic: sadece node'da çalışır)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const workspace = process.env['OPENCLAW_WORKSPACE'] || path.join(os.homedir(), '.openclaw');
    const configPath = path.join(workspace, 'openclaw.json');
    if (!fs.existsSync(configPath)) return empty;

    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    // 1) Aktif provider'ı bul: auth.profiles içinde "mode":"api_key" olan ilk giriş
    const auth = config['auth'] as { profiles?: Record<string, { provider?: string; mode?: string }> } | undefined;
    const profiles = auth?.profiles ?? {};
    let providerName = '';
    for (const profile of Object.values(profiles)) {
      if (profile && profile.mode === 'api_key' && typeof profile.provider === 'string') {
        providerName = profile.provider;
        break;
      }
    }
    if (!providerName) {
      // Fallback: models.providers içindeki ilk girişi al
      const models = config['models'] as { providers?: Record<string, unknown> } | undefined;
      const names = Object.keys(models?.providers ?? {});
      if (names.length > 0) providerName = names[0];
    }
    if (!providerName) return empty;

    // 2) baseUrl + model'i oku
    const modelsNode = (config['models'] as {
      providers?: Record<string, {
        baseUrl?: string;
        models?: Array<{ id?: string }>;
        apiKey?: string;
      }>;
    } | undefined);
    const providerNode = modelsNode?.providers?.[providerName];
    const baseUrl = (providerNode?.baseUrl ?? '').replace(/\/+$/, '');
    const firstModel = providerNode?.models?.[0]?.id ?? '';
    if (!baseUrl || !firstModel) return empty;

    // 3) API key'i oku — öncelik:
    //    a) openclaw.json içinde models.providers.<name>.apiKey (OpenClaw'ın
    //       gerçek kullandığı yer, inline storage)
    //    b) ~/.openclaw/credentials/<name>.* dosyaları (legacy / alternatif)
    //
    // OpenClaw çoğunlukla (a)'yı kullanır; (b) sadece bazı kurulumlarda
    // veya özel olarak dosyaya ayrılmış credential'lar için anlamlı.
    const inlineKey = typeof providerNode?.apiKey === 'string' ? providerNode.apiKey : '';
    const apiKey = inlineKey.length > 0
      ? inlineKey
      : readCredential(workspace, providerName, fs, path);

    return { baseUrl, apiKey, model: firstModel, providerName };
  } catch {
    return empty;
  }
}

/**
 * OpenClaw credentials/ klasöründen provider için gerçek API key'i okur.
 * Birkaç olası format dener: JSON, düz text, tek dosyalı klasör.
 */
function readCredential(
  workspace: string,
  providerName: string,
  fs: typeof import('fs'),
  path: typeof import('path'),
): string {
  const credDir = path.join(workspace, 'credentials');
  if (!fs.existsSync(credDir)) return '';

  // Olası dosya isimleri: qwen.json, qwen.key, qwen, qwen-api-key.json vb.
  const candidates = [
    `${providerName}.json`,
    `${providerName}.key`,
    `${providerName}.txt`,
    providerName,
  ];

  for (const name of candidates) {
    const filePath = path.join(credDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) continue;
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;
      // JSON parse dene
      if (content.startsWith('{')) {
        try {
          const obj = JSON.parse(content) as Record<string, unknown>;
          const keyFields = ['apiKey', 'api_key', 'token', 'key', 'secret'];
          for (const field of keyFields) {
            const val = obj[field];
            if (typeof val === 'string' && val.length > 0) return val;
          }
        } catch { /* düz text'e devam */ }
      }
      return content;
    } catch { /* sonraki adayı dene */ }
  }

  // Son çare: provider adına uyan bir alt klasör varsa içindeki ilk dosyayı oku
  const providerSubdir = path.join(credDir, providerName);
  if (fs.existsSync(providerSubdir) && fs.statSync(providerSubdir).isDirectory()) {
    const files = fs.readdirSync(providerSubdir).filter(f => !f.startsWith('.'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(providerSubdir, f), 'utf-8').trim();
        if (content) return content.startsWith('{') ? extractJsonKey(content) : content;
      } catch { /* ignore */ }
    }
  }

  return '';
}

function extractJsonKey(content: string): string {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const keyFields = ['apiKey', 'api_key', 'token', 'key', 'secret'];
    for (const field of keyFields) {
      const val = obj[field];
      if (typeof val === 'string' && val.length > 0) return val;
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * LLM yapılandırmasını üretir.
 *
 * Öncelik sırası (ilk bulunan kazanır):
 * 1. Doğrudan override (constructor parametreleri)
 * 2. AGENT_LLM_* env var'ları (manuel kontrol için)
 * 3. OpenClaw workspace (otomatik: openclaw.json + credentials/)
 * 4. Varsayılanlar
 */
export function loadLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  const openclaw = resolveOpenClawProvider();

  const baseUrl =
    overrides?.baseUrl ??
    process.env['AGENT_LLM_BASE_URL'] ??
    (openclaw.baseUrl || 'http://localhost:18789/v1');

  const apiKey =
    overrides?.apiKey ??
    process.env['AGENT_LLM_API_KEY'] ??
    openclaw.apiKey ??
    '';

  const model =
    overrides?.model ??
    process.env['AGENT_LLM_MODEL'] ??
    (openclaw.model || 'qwen3.5-plus');

  return {
    baseUrl,
    apiKey,
    model,
    maxTokens: overrides?.maxTokens ?? 1024,
    temperature: overrides?.temperature ?? 0.7,
    timeoutMs: overrides?.timeoutMs ?? 30_000,
  };
}

/**
 * OpenClaw'dan otomatik yüklenen provider bilgilerini döner.
 * Dashboard ve debug için kullanılır. Boş değerler, yükleme başarısız demek.
 */
export function getOpenClawAutoConfig(): { baseUrl: string; model: string; providerName: string; hasApiKey: boolean } {
  const r = resolveOpenClawProvider();
  return {
    baseUrl: r.baseUrl,
    model: r.model,
    providerName: r.providerName,
    hasApiKey: r.apiKey.length > 0,
  };
}

/**
 * LLM yapılandırma tanısı — apiKey eksikse nerede arandığını ve
 * nasıl düzeltileceğini açıklayan human-readable bir rapor döner.
 *
 * Başta "kur bağlan çalış" akışında kullanıcıya ne eksik olduğunu
 * erkenden göstermek için.
 */
export interface LLMConfigDiagnostic {
  /** API key set edilmiş mi */
  hasApiKey: boolean;
  /** baseUrl set edilmiş mi */
  hasBaseUrl: boolean;
  /** model set edilmiş mi */
  hasModel: boolean;
  /** Key nereden geldi (veya gelmeye çalışıldı) */
  apiKeySource: 'env' | 'openclaw' | 'missing';
  /** OpenClaw provider adı (bilinirse) */
  openclawProvider: string;
  /** Çözülmüş baseUrl */
  baseUrl: string;
  /** Çözülmüş model */
  model: string;
  /** Sorun varsa okunabilir uyarı mesajı */
  warnings: string[];
  /** Kullanıcıya önerilen düzeltme adımları */
  hints: string[];
}

/**
 * Mevcut ortamdan LLM yapılandırmasını tanılar.
 * Boş apiKey durumunu, OpenClaw workspace ile env var arasındaki
 * çakışmaları ve missing provider file'larını yakalar.
 */
export function diagnoseLLMConfig(): LLMConfigDiagnostic {
  const cfg = loadLLMConfig();
  const openclaw = resolveOpenClawProvider();
  const envKey = process.env['AGENT_LLM_API_KEY'];
  const warnings: string[] = [];
  const hints: string[] = [];

  let apiKeySource: 'env' | 'openclaw' | 'missing';
  if (envKey && envKey.length > 0) {
    apiKeySource = 'env';
  } else if (openclaw.apiKey.length > 0) {
    apiKeySource = 'openclaw';
  } else {
    apiKeySource = 'missing';
  }

  const hasApiKey = cfg.apiKey.length > 0;
  const hasBaseUrl = cfg.baseUrl.length > 0;
  const hasModel = cfg.model.length > 0;

  if (!hasApiKey) {
    if (openclaw.providerName) {
      warnings.push(
        `OpenClaw workspace yuklendi (provider: ${openclaw.providerName}) ama API key bulunamadi.`,
      );
      hints.push(
        `~/.openclaw/openclaw.json icinde models.providers.${openclaw.providerName}.apiKey alanini doldurun (OpenClaw'in standart yeri).`,
      );
      hints.push(
        `Alternatif: ~/.openclaw/credentials/${openclaw.providerName}.json dosyasina {"apiKey": "<sk-...>"} yazin.`,
      );
      hints.push(
        `Hizli test: AGENT_LLM_API_KEY=<sk-...> npx tsx start-server.ts ... ile baslatin.`,
      );
    } else {
      warnings.push('Hicbir yerden LLM API key cozulemedi.');
      hints.push('~/.openclaw/workspace/ altinda OpenClaw kimligini olusturun veya');
      hints.push('AGENT_LLM_API_KEY ve AGENT_LLM_BASE_URL env var\'larini set edin.');
    }
  }

  if (!hasModel && hasApiKey) {
    warnings.push('Model adi cozulemedi; varsayilana dusecek.');
  }

  return {
    hasApiKey,
    hasBaseUrl,
    hasModel,
    apiKeySource,
    openclawProvider: openclaw.providerName,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    warnings,
    hints,
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
