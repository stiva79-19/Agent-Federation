/**
 * OpenClaw Gateway Status Detection
 *
 * Gateway'in çalışıp çalışmadığını tespit eder ve kullanıcıya platform-aware
 * kurulum ipuçları verir. TCP probe ana metot; opsiyonel olarak `openclaw
 * gateway status` CLI çıktısı da deneriz (varsa zengin bilgi).
 *
 * Tasarım notları:
 *   - TCP probe ana sinyal çünkü hafif, deterministik ve auth-bağımsız.
 *   - HTTP probe ikincil — bağlantı kabul ediyor ama HTTP konuşmuyorsa
 *     gateway değil başka bir servis vardır.
 *   - CLI probe opsiyonel: `openclaw` yoksa veya timeout olursa sessizce atla.
 *   - Kullanıcıya dönülen mesajlar hem CLI log'unda hem dashboard'da
 *     aynı şekilde render edilebilsin diye düz string + yapılandırılmış `hints` döner.
 */

import * as net from 'net';
import { spawn } from 'child_process';

export type GatewayHealth =
  | 'running'       // TCP + HTTP OK
  | 'tcp-only'      // TCP açık ama HTTP yanıt vermiyor (gateway başka şey dinliyor olabilir)
  | 'offline'       // ECONNREFUSED
  | 'unreachable';  // Timeout / network hatası / DNS vb.

export interface PlatformHint {
  /** Kullanıcıya gösterilecek human-readable adım */
  label: string;
  /** Terminale kopyalayıp çalıştırabileceği komut (varsa) */
  command?: string;
}

export interface GatewayStatus {
  /** Test edilen URL */
  baseUrl: string;
  /** Çözümlenmiş host:port */
  host: string;
  port: number;
  /** Son sağlık durumu */
  health: GatewayHealth;
  /** Okunabilir özet (log'da tek satırlık) */
  summary: string;
  /** CLI/dashboard'da gösterilecek kurulum ipuçları — platform-spesifik */
  hints: {
    primary: PlatformHint[];   // Kullanıcının OS'ine uygun ipuçları (önce göster)
    alternatives: PlatformHint[]; // Diğer platformların komutları (ikincil)
  };
  /** `openclaw` CLI tarafından dönen ham çıktı (opsiyonel, varsa) */
  cliOutput?: string;
  /** Probe esnasındaki hata (varsa) */
  error?: string;
}

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

/** process.platform'u bilinen gruba düşürür. */
export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'other';
}

/** baseUrl'den host/port çıkarır. /v1 gibi path'leri yoksayar. IPv6 bracket'larını temizler. */
export function parseHostPort(baseUrl: string): { host: string; port: number } {
  try {
    const u = new URL(baseUrl);
    // Node URL IPv6'yı köşeli parantezle döndürür ("[::1]"); net.connect parantezsiz ister.
    let host = u.hostname || '127.0.0.1';
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host, port };
  } catch {
    // baseUrl yoksa/bozuksa default'a düş
    return { host: '127.0.0.1', port: 18789 };
  }
}

/**
 * TCP bağlantı probe'u. Port'un kabul edip etmediğini test eder.
 * Gateway'in protokolüne girmeden ("first frame must be connect" kuralını
 * tetiklemeden) sadece TCP layer'a bakar.
 */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs: number = 2000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => cleanup({ ok: true }));
    socket.once('timeout', () => cleanup({ ok: false, error: 'timeout' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      cleanup({ ok: false, error: err.code || err.message || 'unknown' });
    });

    try {
      socket.connect(port, host);
    } catch (e) {
      cleanup({ ok: false, error: (e as Error).message });
    }
  });
}

/**
 * HTTP probe. Gateway'in HTTP server'ı (canvas host, vb) yanıt veriyor mu.
 * OpenAI-compat `/v1/models` sonsuz yük yaratmamak için HEAD / varsayılan `/` kullanılır.
 * 200-499 arası tüm yanıtları "HTTP konuşuluyor" olarak sayar.
 */
export function probeHttp(baseUrl: string, timeoutMs: number = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // baseUrl /v1 ile bitiyorsa origin'e in — canvas host 18789 root'ta
      const u = new URL(baseUrl);
      const probeUrl = `${u.protocol}//${u.host}/`;

      fetch(probeUrl, { method: 'GET', signal: controller.signal })
        .then((res) => {
          clearTimeout(timer);
          resolve(res.status >= 200 && res.status < 500);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    } catch {
      resolve(false);
    }
  });
}

/**
 * `openclaw gateway status` komutunu çalıştırır, 3 saniye timeout.
 * Başarısız olursa null döner (sessizce atla — CLI yok veya PATH'te değil).
 */
export function probeOpenClawCli(timeoutMs: number = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    try {
      const proc = spawn('openclaw', ['gateway', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* ignore */ }
        resolve(null);
      }, timeoutMs);

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && stdout.trim().length > 0) {
          resolve(stdout.trim());
        } else if (stderr.trim().length > 0) {
          // Bazı sürümler hata dönse bile faydalı bilgi verir
          resolve(stderr.trim());
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Platform-aware setup hint'leri döner. Kullanıcının OS'ine uygun olanları
 * `primary`, diğerleri `alternatives` olarak.
 */
export function getSetupHints(platform: Platform): GatewayStatus['hints'] {
  const macOSHints: PlatformHint[] = [
    { label: 'Start Gateway (foreground)', command: 'openclaw gateway' },
    { label: 'Install as LaunchAgent (auto-start)', command: 'openclaw gateway install' },
    { label: 'Diagnose setup issues', command: 'openclaw doctor' },
  ];

  const linuxHints: PlatformHint[] = [
    { label: 'Start Gateway (foreground)', command: 'openclaw gateway' },
    { label: 'Install as systemd user service', command: 'openclaw gateway install' },
    { label: 'Check systemd status', command: 'systemctl --user status openclaw-gateway.service' },
    { label: 'Diagnose setup issues', command: 'openclaw doctor' },
  ];

  const windowsHints: PlatformHint[] = [
    { label: 'Start Gateway (foreground)', command: 'openclaw gateway' },
    { label: 'Install as Scheduled Task', command: 'openclaw gateway install' },
    { label: 'Check scheduled task', command: 'schtasks /query /TN "OpenClaw Gateway"' },
    { label: 'Recommended: use WSL2 for best compatibility' },
    { label: 'Diagnose setup issues', command: 'openclaw doctor' },
  ];

  const allPlatforms: Record<Platform, PlatformHint[]> = {
    darwin: macOSHints,
    linux: linuxHints,
    win32: windowsHints,
    other: [...linuxHints],
  };

  const primary = allPlatforms[platform];
  const alternatives: PlatformHint[] = [];
  for (const [p, hints] of Object.entries(allPlatforms) as Array<[Platform, PlatformHint[]]>) {
    if (p === platform || p === 'other') continue;
    // "macOS:", "Linux:", "Windows:" etiketli başlıklarla alternatifleri zenginleştir
    const labelPrefix = p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p === 'win32' ? 'Windows' : p;
    alternatives.push({ label: `— ${labelPrefix} —` });
    for (const h of hints) alternatives.push(h);
  }

  return { primary, alternatives };
}

/**
 * Tüm probe'ları çalıştırıp unified bir status objesi üretir.
 * Ana API — CLI ve dashboard bu metodu çağırır.
 */
export async function checkGatewayStatus(baseUrl: string): Promise<GatewayStatus> {
  const { host, port } = parseHostPort(baseUrl);
  const platform = detectPlatform();
  const hints = getSetupHints(platform);

  // 1) TCP probe
  const tcp = await probeTcp(host, port);
  if (!tcp.ok) {
    const offline = tcp.error === 'ECONNREFUSED' || tcp.error === 'ENOTFOUND';
    return {
      baseUrl,
      host,
      port,
      health: offline ? 'offline' : 'unreachable',
      summary: offline
        ? `Gateway offline (${host}:${port} ${tcp.error ?? 'no connection'})`
        : `Gateway unreachable (${host}:${port} ${tcp.error ?? 'unknown error'})`,
      hints,
      error: tcp.error,
    };
  }

  // 2) HTTP probe — TCP açıksa HTTP'de anlamlı yanıt veriyor mu
  const http = await probeHttp(baseUrl);

  // 3) CLI probe — arka planda bilgi topla (zaten hızlı, 3sn timeout)
  const cliOutput = await probeOpenClawCli();

  return {
    baseUrl,
    host,
    port,
    health: http ? 'running' : 'tcp-only',
    summary: http
      ? `Gateway running (${host}:${port})`
      : `Gateway TCP open but HTTP not responding (${host}:${port})`,
    hints,
    cliOutput: cliOutput ?? undefined,
  };
}
