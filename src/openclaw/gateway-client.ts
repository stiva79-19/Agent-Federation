/**
 * OpenClaw Gateway Client — Agent Federation
 *
 * WebSocket RPC client that talks to a local OpenClaw Gateway
 * (default: ws://127.0.0.1:18789). Keeps OpenClaw as the single
 * source of truth for agent identity and (future) LLM proxy.
 *
 * Token bootstrap — Phase 1a (current):
 *   Read once from ~/.openclaw/openclaw.json or OPENCLAW_GATEWAY_TOKEN env.
 *   Subsequent calls happen exclusively over the WebSocket connection.
 *
 * Future work:
 *   - Phase 1b: llm.chat streaming via Gateway events so API keys
 *     never enter this process.
 *   - Phase 2:  auth.grant with per-session scoped tokens + TUI consent.
 */

import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Minimal subset of what identity.get returns from OpenClaw Gateway.
 * Must stay in sync with the Gateway's IdentityPayload contract.
 */
export interface GatewayIdentity {
  available: boolean;
  reason?: string;
  workspacePath?: string;
  name?: string;
  did?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;
  identityRaw?: string;
  soulRaw?: string;
}

/**
 * Gateway connection configuration.
 */
export interface GatewayClientConfig {
  /** ws:// URL of the Gateway. Default: ws://127.0.0.1:18789 */
  url: string;
  /** Auth token. If omitted, read from openclaw.json or env var. */
  token?: string;
  /** Connection timeout (ms). Default: 5000 */
  connectTimeoutMs: number;
  /** Per-request timeout (ms). Default: 10000 */
  requestTimeoutMs: number;
}

/** A single pending RPC call awaiting its response frame. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ─── Token bootstrap (filesystem, ONCE) ─────────────────────────────────────

/**
 * Read the Gateway auth token exactly once at startup.
 *
 * Priority:
 *  1. Explicit config.token (caller passed it)
 *  2. OPENCLAW_GATEWAY_TOKEN env var
 *  3. ~/.openclaw/openclaw.json → gateway.auth.token
 *
 * This is the only direct filesystem touch. Everything else goes
 * through the WebSocket RPC channel.
 */
export function readGatewayToken(explicit?: string): { token: string; source: string } | null {
  if (explicit && explicit.length > 0) {
    return { token: explicit, source: 'explicit' };
  }

  const envToken = process.env['OPENCLAW_GATEWAY_TOKEN'];
  if (envToken && envToken.length > 0) {
    return { token: envToken, source: 'env:OPENCLAW_GATEWAY_TOKEN' };
  }

  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;

    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const gateway = config['gateway'] as { auth?: { token?: string } } | undefined;
    const token = gateway?.auth?.token;

    if (typeof token === 'string' && token.length > 0) {
      return { token, source: '~/.openclaw/openclaw.json' };
    }
  } catch {
    // Malformed JSON or unreadable file → fall through to null
  }

  return null;
}

// ─── Default Config ─────────────────────────────────────────────────────────

export function defaultGatewayUrl(): string {
  return process.env['OPENCLAW_GATEWAY_URL'] || 'ws://127.0.0.1:18789';
}

export function defaultGatewayClientConfig(): GatewayClientConfig {
  return {
    url: defaultGatewayUrl(),
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
  };
}

// ─── GatewayClient ──────────────────────────────────────────────────────────

/**
 * WebSocket RPC client for the local OpenClaw Gateway.
 *
 * Usage:
 *   const client = new GatewayClient();
 *   await client.connect();
 *   const identity = await client.getIdentity();
 *   client.close();
 */
export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: GatewayClientConfig;
  private token: string | null = null;
  private tokenSource: string | null = null;
  private connected = false;
  private destroyed = false;
  private pending = new Map<string, PendingCall>();

  constructor(config?: Partial<GatewayClientConfig>) {
    super();
    this.config = { ...defaultGatewayClientConfig(), ...config };

    const tokenInfo = readGatewayToken(config?.token);
    if (tokenInfo) {
      this.token = tokenInfo.token;
      this.tokenSource = tokenInfo.source;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Token kaynağı (debug/log için) */
  get tokenSourceLabel(): string | null {
    return this.tokenSource;
  }

  /** Bağlı mı */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Token bulundu mu */
  get hasToken(): boolean {
    return this.token !== null;
  }

  /**
   * WebSocket bağlantısını kur ve connect frame'ini gönder.
   * Token yoksa erken hata verir (filesystem fallback dışında yol yok).
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.token) {
      throw new Error(
        'OpenClaw Gateway token bulunamadi. ~/.openclaw/openclaw.json icinde gateway.auth.token olmali ' +
        've/veya OPENCLAW_GATEWAY_TOKEN env var set edilmis olmali.',
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Gateway baglantisi kurulamadi (${this.config.url}): ${err.message}`));
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.ws?.close();
        reject(new Error(`Gateway connect timeout (${this.config.connectTimeoutMs}ms)`));
      }, this.config.connectTimeoutMs);

      try {
        this.ws = new WebSocket(this.config.url);
      } catch (err) {
        clearTimeout(timeout);
        return reject(err instanceof Error ? err : new Error(String(err)));
      }

      this.ws.on('open', () => {
        // OpenClaw Gateway requires a "connect" frame with auth token
        // before any method calls are accepted.
        this.sendFrame({
          type: 'connect',
          token: this.token,
          clientName: 'agent-federation',
          version: '0.1.0',
        });
      });

      this.ws.on('message', (raw) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        // connect_ack (or equivalent) → mark connected
        if (frame['type'] === 'connect_ack' || frame['type'] === 'ready' || frame['ok'] === true && !this.connected && !frame['id']) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connected = true;
          this.emit('connected');
          resolve();
          return;
        }

        // Connection-level error before ready
        if (!this.connected && (frame['type'] === 'connect_error' || frame['ok'] === false)) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const reason = (frame['reason'] || frame['error'] || 'unknown') as string;
          reject(new Error(`Gateway reddetti: ${reason}`));
          return;
        }

        // Response to a pending RPC call
        this.handleFrame(frame);
      });

      this.ws.on('error', (err) => {
        onError(err);
        this.emit('error', err);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected');

        // Reject any pending calls
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Gateway connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  /**
   * RPC çağrısı yapar ve cevabı bekler.
   * Timeout hemen hata fırlatır, pending state temizlenir.
   */
  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('Gateway not connected');

    const id = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout (${this.config.requestTimeoutMs}ms): ${method}`));
      }, this.config.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.sendFrame({
        type: 'request',
        id,
        method,
        params: params ?? {},
      });
    });
  }

  /**
   * agent.identity.full metodunu çağırır ve parsed IdentityPayload döner.
   *
   * Not: Phase 1a — bu metod OpenClaw Gateway'de henüz yoksa
   * METHOD_NOT_FOUND hatası dönecek. Çağrı site bu hatayı yakalayıp
   * graceful fallback yapabilir (şimdilik filesystem).
   */
  async getIdentity(): Promise<GatewayIdentity> {
    const result = await this.request<GatewayIdentity>('agent.identity.full');
    return result;
  }

  /** Bağlantıyı kapatır. */
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client destroyed'));
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Response frame'ini eşleşen pending çağrıya yönlendirir.
   *
   * Gateway RPC protokol tahmini (kesinleşmesi için OpenClaw'un
   * ws-connection'ı ve protocol/ klasöründeki response shape
   * onaylanmalı — Phase 1a test sırasında doğrulanacak):
   *
   *   { type: 'response', id, ok: true, payload }
   *   { type: 'response', id, ok: false, error: { code, message } }
   */
  private handleFrame(frame: Record<string, unknown>): void {
    const id = frame['id'] as string | undefined;
    if (!id) return;

    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    const ok = frame['ok'] !== false;
    if (ok) {
      // "payload" standart, bazı metodlarda "result" olabilir
      const payload = frame['payload'] ?? frame['result'] ?? frame['data'];
      pending.resolve(payload);
    } else {
      const err = frame['error'] as { code?: string; message?: string } | undefined;
      const msg = err?.message || err?.code || 'Gateway error';
      pending.reject(new Error(`[${err?.code || 'ERROR'}] ${msg}`));
    }
  }
}
