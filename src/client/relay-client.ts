/**
 * @deprecated Bu modul artik onerilmiyor. Bunun yerine Hyperswarm tabanli
 * SwarmManager (src/swarm/swarm-manager.ts) kullanin.
 *
 * Relay Client Module — Agent Federation
 *
 * Kullanicinin uygulamasinda calisan relay client.
 * Fly.io relay sunucusuna WebSocket baglantisi kurar,
 * davet kodu olusturma/katilma isteklerini relay'e gonderir,
 * gelen mesajlari local agent'a iletir.
 *
 * Onemli: LLM cagirilari hep local kalir. Bu modul sadece
 * relay sunucusuyla iletisim kurar.
 *
 * @see src/swarm/swarm-manager.ts — Yeni P2P sistemi
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Relay client yapilandirmasi */
export interface RelayClientConfig {
  /** Relay sunucu URL'i (ornek: wss://agent-federation-relay.onrender.com) */
  relayUrl: string;
  /** Agent adi */
  agentName: string;
  /** Agent DID (opsiyonel) */
  agentDid?: string;
  /** Otomatik reconnect yapilsin mi (varsayilan: true) */
  autoReconnect?: boolean;
  /** Maksimum reconnect denemesi (varsayilan: 10) */
  maxReconnectAttempts?: number;
  /** Baslangic reconnect gecikmesi ms (varsayilan: 1000) */
  initialReconnectDelay?: number;
  /** Maksimum reconnect gecikmesi ms (varsayilan: 30000) */
  maxReconnectDelay?: number;
}

/** Relay client durumu */
export type RelayClientState = 'disconnected' | 'connecting' | 'connected' | 'in_room';

/** Relay client olaylari */
export interface RelayClientEvents {
  /** Relay sunucusuna baglanildi */
  connected: (token: string) => void;
  /** Baglanti kesildi */
  disconnected: (reason: string) => void;
  /** Room olusturuldu */
  room_created: (roomCode: string, roomId: string) => void;
  /** Room'a katilildi */
  room_joined: (roomId: string, participants: Array<{ agentName: string; agentDid: string | null }>) => void;
  /** Yeni katilimci geldi */
  participant_joined: (agentName: string, agentDid: string | null, count: number, max: number) => void;
  /** Katilimci ayrildi */
  participant_left: (agentName: string, count: number) => void;
  /** Room mesaji alindi */
  room_message: (from: string, fromDid: string | null, message: Record<string, unknown>) => void;
  /** Room kapandi */
  room_closed: (reason: string) => void;
  /** Hata */
  error: (code: string, message: string) => void;
  /** Reconnect denemesi */
  reconnecting: (attempt: number, maxAttempts: number) => void;
}

// ─── Relay Client ─────────────────────────────────────────────────────────

/**
 * Relay sunucusuna baglanan client.
 * Davet kodu olusturma, katilma ve mesaj relay islemlerini yonetir.
 */
export class RelayClient extends EventEmitter {
  private config: Required<RelayClientConfig>;
  private ws: WebSocket | null = null;
  private state: RelayClientState = 'disconnected';
  private token: string | null = null;
  private currentRoomId: string | null = null;
  private currentRoomCode: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private participantCount = 0;

  constructor(config: RelayClientConfig) {
    super();
    this.config = {
      relayUrl: config.relayUrl,
      agentName: config.agentName,
      agentDid: config.agentDid ?? '',
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      initialReconnectDelay: config.initialReconnectDelay ?? 1000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Relay sunucusuna baglanir. */
  connect(): void {
    if (this.state !== 'disconnected') return;

    this.state = 'connecting';
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  /** Baglantiyi kapatir. */
  disconnect(): void {
    this.state = 'disconnected';
    this.stopPing();
    this.clearReconnect();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.token = null;
    this.currentRoomId = null;
    this.currentRoomCode = null;
    this.participantCount = 0;
  }

  /** Yeni room olusturur (davet kodu alinir). */
  createRoom(): void {
    this.send({ type: 'create_room' });
  }

  /** Var olan room'a davet koduyla katilir. */
  joinRoom(roomCode: string): void {
    this.send({ type: 'join_room', roomCode });
  }

  /** Room'dan ayrilir. */
  leaveRoom(): void {
    this.send({ type: 'leave_room' });
    this.currentRoomId = null;
    this.currentRoomCode = null;
    this.participantCount = 0;
    this.state = 'connected';
  }

  /** Room'daki diger katilimcilara mesaj gonderir. */
  sendMessage(message: Record<string, unknown>): void {
    if (!this.currentRoomId) {
      this.emit('error', 'NOT_IN_ROOM', 'Not in a room');
      return;
    }
    this.send({
      type: 'room_message',
      roomId: this.currentRoomId,
      message,
    });
  }

  /** Agent bilgilerini gunceller. */
  updateAgentInfo(agentName: string, agentDid?: string): void {
    this.config.agentName = agentName;
    if (agentDid !== undefined) {
      this.config.agentDid = agentDid;
    }
    this.send({
      type: 'relay_auth',
      agentName: this.config.agentName,
      agentDid: this.config.agentDid || undefined,
      token: this.token ?? undefined,
    });
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  getState(): RelayClientState { return this.state; }
  getToken(): string | null { return this.token; }
  getCurrentRoomId(): string | null { return this.currentRoomId; }
  getCurrentRoomCode(): string | null { return this.currentRoomCode; }
  getParticipantCount(): number { return this.participantCount; }
  isConnected(): boolean { return this.state === 'connected' || this.state === 'in_room'; }
  isInRoom(): boolean { return this.state === 'in_room'; }

  // ─── Private ────────────────────────────────────────────────────────────

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.config.relayUrl);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.startPing();

        // Auth mesaji gonder
        this.send({
          type: 'relay_auth',
          agentName: this.config.agentName,
          agentDid: this.config.agentDid || undefined,
          token: this.token ?? undefined,
        });
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg);
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on('close', (code, reason) => {
        this.stopPing();
        const reasonStr = reason?.toString() || `code ${code}`;

        if (this.state !== 'disconnected') {
          this.state = 'disconnected';
          this.currentRoomId = null;
          this.currentRoomCode = null;
          this.emit('disconnected', reasonStr);

          if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        }
      });

      this.ws.on('error', (error) => {
        console.error('[RelayClient] WebSocket error:', error.message);
      });
    } catch (error) {
      console.error('[RelayClient] Connection error:', error);
      if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    switch (type) {
      case 'relay_welcome':
        this.token = msg['token'] as string;
        this.state = 'connected';
        this.emit('connected', this.token);
        break;

      case 'room_created':
        this.currentRoomCode = msg['roomCode'] as string;
        this.currentRoomId = msg['roomId'] as string;
        this.state = 'in_room';
        this.participantCount = 1;
        this.emit('room_created', this.currentRoomCode, this.currentRoomId);
        break;

      case 'room_joined':
        this.currentRoomId = msg['roomId'] as string;
        this.state = 'in_room';
        {
          const participants = msg['participants'] as Array<{ agentName: string; agentDid: string | null }>;
          this.participantCount = participants.length + 1;
          this.emit('room_joined', this.currentRoomId, participants);
        }
        break;

      case 'participant_joined':
        this.participantCount = (msg['participantCount'] as number) || this.participantCount + 1;
        this.emit(
          'participant_joined',
          msg['agentName'] as string,
          msg['agentDid'] as string | null,
          this.participantCount,
          (msg['maxParticipants'] as number) || 7,
        );
        break;

      case 'participant_left':
        this.participantCount = (msg['participantCount'] as number) || Math.max(0, this.participantCount - 1);
        this.emit('participant_left', msg['agentName'] as string, this.participantCount);
        break;

      case 'room_message':
        this.emit(
          'room_message',
          msg['from'] as string,
          msg['fromDid'] as string | null,
          msg['message'] as Record<string, unknown>,
        );
        break;

      case 'room_closed':
        this.currentRoomId = null;
        this.currentRoomCode = null;
        this.participantCount = 0;
        this.state = 'connected';
        this.emit('room_closed', msg['reason'] as string);
        break;

      case 'relay_error':
        this.emit('error', msg['code'] as string, msg['message'] as string);
        break;

      case 'pong':
        // Heartbeat yaniti — sessizce kabul et
        break;
    }
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ─── Reconnect ──────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.config.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelay,
    );
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = Math.round(baseDelay + jitter);

    this.emit('reconnecting', this.reconnectAttempts, this.config.maxReconnectAttempts);

    console.log(`[RelayClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Ping ───────────────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

/**
 * Varsayilan relay URL.
 * .env'den okunur, yoksa Render.com varsayilani kullanilir.
 */
export function defaultRelayUrl(): string {
  return process.env['RELAY_URL'] ?? 'wss://agent-federation-relay.onrender.com';
}
