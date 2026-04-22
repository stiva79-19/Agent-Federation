/**
 * LLM Endpoint Discovery
 *
 * OpenClaw Gateway (veya başka OpenAI-compat gateway) chat completions'ı
 * farklı path'lerde sunabiliyor. Bu modül yaygın adayları sırayla probe eder
 * ve gerçek endpoint'i tespit eder — kullanıcıya config yazdırmadan.
 *
 * Strateji:
 *   - GET /models aday path'leri sırayla dene
 *   - 200 OK → path doğru, models listesi alındı
 *   - 401/403 → path doğru ama auth gerekli (sentinel bearer token ile test)
 *   - 405 Method Not Allowed → path tanınıyor ama GET desteklenmiyor; kabul
 *   - 404 → path yok, sonraki adayı dene
 *
 * Tespit edilen path'ten chat completions path'i türetilir (son `/models` →
 * `/chat/completions`).
 */

import { LOCAL_API_KEY_SENTINEL } from './llm';

/** Denenen aday path'ler, tercih sırasına göre. */
const CANDIDATE_MODEL_PATHS = [
  '/v1/models',                          // OpenAI / vLLM / LM Studio / Ollama
  '/api/v1/models',                      // Bazı reverse proxy'ler
  '/__openclaw__/api/v1/models',         // OpenClaw namespaced
  '/__openclaw__/v1/models',             // OpenClaw minimal
  '/openai/v1/models',                   // Nested proxy
  '/models',                             // Prefix'siz
];

export interface DiscoveryResult {
  /** Discovery başarılı mı */
  detected: boolean;
  /** Chat completions için kullanılacak base URL (örn. http://host:port/v1) */
  baseUrl: string;
  /** Hangi aday path eşleşti (debug için) */
  matchedPath: string;
  /** Probe sırasında alınan HTTP status code */
  statusCode: number;
  /** Gateway'in döndüğü model id'leri (varsa) */
  availableModels: string[];
  /** Denenen tüm aday path'lerin özet sonucu */
  attempts: Array<{ path: string; status: number | null; error?: string }>;
}

/**
 * baseUrl'den origin'i çıkarır: "http://host:port/v1/" → "http://host:port"
 */
function toOrigin(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Fallback: son path segmentini kes
    return baseUrl.replace(/\/+$/, '').replace(/\/v1\/?$/, '').replace(/\/api\/v1\/?$/, '');
  }
}

/**
 * Tek bir aday path'i probe eder. Timeout'lu, yan etkisiz (GET).
 */
async function probeEndpoint(
  origin: string,
  path: string,
  apiKey: string,
  timeoutMs: number = 3000,
): Promise<{ status: number | null; models: string[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(origin + path, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    clearTimeout(timer);

    // 200 → full success, models listesini çıkar
    // 401/403 → path doğru ama auth eksik → sentinel yetmiyor, manuel key gerek
    // 405 → path tanınıyor ama GET desteklenmiyor → yine kabul
    // Diğer 4xx/5xx → belirsiz
    let models: string[] = [];
    if (res.status === 200) {
      try {
        const body = await res.json() as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
        // OpenAI: { data: [{id: "..."}] }, alternatif: { models: [...] }
        const list = body.data ?? body.models ?? [];
        models = list.map((m) => m?.id || '').filter((id) => id.length > 0);
      } catch { /* body parse fail, sorun değil */ }
    }

    return { status: res.status, models };
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string; code?: string; message?: string };
    return {
      status: null,
      models: [],
      error: e.name === 'AbortError' ? 'timeout' : (e.code || e.message || 'unknown'),
    };
  }
}

/**
 * Bir status code'un "path doğru" anlamına gelip gelmediğini belirler.
 * 200 = success, 401/403 = auth eksik ama path var, 405 = method yanlış ama path var.
 */
function isPathAccepted(status: number | null): boolean {
  if (status === null) return false;
  return status === 200 || status === 401 || status === 403 || status === 405;
}

/**
 * LLM chat completions endpoint'ini keşfet.
 *
 * @param configuredBaseUrl - Config'teki baseUrl (örn. http://localhost:18789/v1)
 * @param apiKey - Auth bearer token (sentinel veya gerçek key)
 * @returns Discovery sonucu + yeni baseUrl (başarısızsa configuredBaseUrl aynen)
 */
export async function discoverLLMEndpoint(
  configuredBaseUrl: string,
  apiKey: string = LOCAL_API_KEY_SENTINEL,
): Promise<DiscoveryResult> {
  const origin = toOrigin(configuredBaseUrl);
  const attempts: DiscoveryResult['attempts'] = [];

  for (const path of CANDIDATE_MODEL_PATHS) {
    const { status, models, error } = await probeEndpoint(origin, path, apiKey);
    attempts.push({ path, status, error });

    if (isPathAccepted(status)) {
      // /models → /chat/completions türet (son segment değişir)
      const pathPrefix = path.replace(/\/models$/, '');
      const baseUrl = origin + pathPrefix;
      return {
        detected: true,
        baseUrl,
        matchedPath: path,
        statusCode: status as number,
        availableModels: models,
        attempts,
      };
    }
  }

  // Hiçbiri eşleşmedi — configuredBaseUrl'i olduğu gibi dön
  return {
    detected: false,
    baseUrl: configuredBaseUrl,
    matchedPath: '',
    statusCode: 0,
    availableModels: [],
    attempts,
  };
}

/** Discovery sonucunu log-friendly string olarak render eder. */
export function formatDiscoveryResult(result: DiscoveryResult): string {
  if (result.detected) {
    const modelsInfo = result.availableModels.length > 0
      ? ` (${result.availableModels.length} model${result.availableModels.length === 1 ? '' : 's'} available)`
      : '';
    return `LLM endpoint discovered: ${result.baseUrl} [${result.statusCode}${result.statusCode === 200 ? ' OK' : ''}]${modelsInfo}`;
  }

  const tried = result.attempts.map((a) => `${a.path}: ${a.status ?? a.error}`).join(', ');
  return `LLM endpoint discovery failed — no candidate path responded. Tried: ${tried}`;
}
