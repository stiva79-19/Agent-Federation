/**
 * Relay Server Module — Agent Federation
 *
 * Fly.io'da calisan merkezi relay sunucusu.
 * Kullanicilar dogrudan birbirlerine baglanmak yerine bu sunucu uzerinden
 * davet koduyla eslesir ve mesajlari relay eder.
 *
 * Onemli: Relay sunucusu LLM cagrisi YAPMAZ, API key'leri bilmez.
 * Sadece mesajlari iletir.
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as crypto from 'crypto';
import * as http from 'http';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Relay sunucu yapilandirmasi */
export interface RelayConfig {
  port: number;
  host: string;
  maxRooms: number;
  roomTTLHours: number;
  maxParticipantsPerRoom: number;
}

/** Bir katilimcinin bilgileri */
export interface RelayParticipant {
  /** Benzersiz baglanti token'i */
  token: string;
  /** WebSocket baglantisi */
  ws: WebSocket;
  /** Agent adi */
  agentName: string;
  /** Agent DID (opsiyonel) */
  agentDid: string | null;
  /** Baglanma zamani */
  connectedAt: Date;
  /** Son mesaj zamani */
  lastMessageAt: Date;
}

/** Bir room (session) */
export interface RelayRoom {
  /** Benzersiz room ID */
  id: string;
  /** Davet kodu (AF-XXXXXX) */
  code: string;
  /** Room'u olusturan token */
  hostToken: string;
  /** Katilimcilar (token -> participant) */
  participants: Map<string, RelayParticipant>;
  /** Olusturulma zamani */
  createdAt: Date;
  /** Otomatik expire zamani */
  expiresAt: Date;
  /** Room durumu */
  status: 'waiting' | 'active' | 'closed';
}

/** Client'tan relay'e gelen mesaj tipleri */
export type RelayClientMessage =
  | { type: 'relay_auth'; token?: string; agentName: string; agentDid?: string }
  | { type: 'create_room' }
  | { type: 'join_room'; roomCode: string }
  | { type: 'room_message'; roomId: string; message: Record<string, unknown> }
  | { type: 'leave_room' }
  | { type: 'ping' };

/** Relay'den client'a giden mesaj tipleri */
export type RelayServerMessage =
  | { type: 'relay_welcome'; token: string }
  | { type: 'room_created'; roomCode: string; roomId: string }
  | { type: 'room_joined'; roomId: string; participants: Array<{ agentName: string; agentDid: string | null }> }
  | { type: 'participant_joined'; agentName: string; agentDid: string | null; participantCount: number; maxParticipants: number }
  | { type: 'participant_left'; agentName: string; participantCount: number }
  | { type: 'room_message'; from: string; fromDid: string | null; message: Record<string, unknown> }
  | { type: 'room_closed'; reason: string }
  | { type: 'relay_error'; code: string; message: string }
  | { type: 'pong' };

// ─── Relay Server ────────────────────────────────────────────────────────────

/**
 * Merkezi relay sunucusu.
 * Room olusturma, katilma, mesaj relay ve temizleme islemlerini yonetir.
 */
export class RelayServer {
  private config: RelayConfig;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  /** Aktif room'lar (roomId -> room) */
  private rooms: Map<string, RelayRoom> = new Map();
  /** Davet kodu -> roomId mapping */
  private codeToRoom: Map<string, string> = new Map();
  /** Token -> katilimcinin bulundugu roomId */
  private tokenToRoom: Map<string, string> = new Map();
  /** WebSocket -> token mapping */
  private wsToToken: Map<WebSocket, string> = new Map();
  /** Token -> WebSocket mapping (hizli erisim) */
  private tokenToWs: Map<string, WebSocket> = new Map();

  /** Temizleme timer'i */
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Heartbeat timer'i */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Istatistikler */
  private stats = {
    totalRoomsCreated: 0,
    totalMessagesRelayed: 0,
    totalConnectionsServed: 0,
  };

  constructor(config: Partial<RelayConfig> = {}) {
    this.config = {
      port: config.port ?? parseInt(process.env['PORT'] ?? '8080', 10),
      host: config.host ?? process.env['HOST'] ?? '0.0.0.0',
      maxRooms: config.maxRooms ?? parseInt(process.env['RELAY_MAX_ROOMS'] ?? '100', 10),
      roomTTLHours: config.roomTTLHours ?? parseInt(process.env['RELAY_ROOM_TTL_HOURS'] ?? '24', 10),
      maxParticipantsPerRoom: config.maxParticipantsPerRoom ?? 7,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Relay sunucusunu baslatir. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
        this.wss = new WebSocketServer({ server: this.httpServer });

        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        this.wss.on('error', (error) => {
          console.error('[Relay] WebSocket server error:', error);
          reject(error);
        });

        this.httpServer.listen(this.config.port, this.config.host, () => {
          console.log(`[Relay] Listening on ${this.config.host}:${this.config.port}`);
          this.startCleanup();
          this.startHeartbeat();
          resolve();
        });

        this.httpServer.on('error', (error) => {
          console.error('[Relay] HTTP server error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Relay sunucusunu durdurur. */
  stop(): void {
    this.stopCleanup();
    this.stopHeartbeat();

    // Tum room'lari kapat
    for (const room of this.rooms.values()) {
      this.closeRoom(room, 'server_shutdown');
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  // ─── HTTP Handlers ──────────────────────────────────────────────────────

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStats()));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Agent Federation Relay',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        stats: '/stats',
        websocket: 'wss://this-host/',
      },
    }));
  }

  // ─── WebSocket Handlers ─────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    this.stats.totalConnectionsServed++;

    // Baglanti icin token olustur ve gonder
    const token = crypto.randomUUID();
    this.wsToToken.set(ws, token);
    this.tokenToWs.set(token, ws);

    this.sendToWs(ws, { type: 'relay_welcome', token });

    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as RelayClientMessage;
        this.handleClientMessage(ws, token, msg);
      } catch {
        this.sendToWs(ws, {
          type: 'relay_error',
          code: 'INVALID_MESSAGE',
          message: 'Invalid JSON message',
        });
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(ws, token);
    });

    ws.on('error', (error) => {
      console.error('[Relay] Connection error:', error.message);
    });
  }

  private handleClientMessage(ws: WebSocket, token: string, msg: RelayClientMessage): void {
    switch (msg.type) {
      case 'relay_auth':
        this.handleAuth(ws, token, msg);
        break;
      case 'create_room':
        this.handleCreateRoom(ws, token);
        break;
      case 'join_room':
        this.handleJoinRoom(ws, token, msg.roomCode);
        break;
      case 'room_message':
        this.handleRoomMessage(token, msg.roomId, msg.message);
        break;
      case 'leave_room':
        this.handleLeaveRoom(token);
        break;
      case 'ping':
        this.sendToWs(ws, { type: 'pong' });
        break;
      default:
        this.sendToWs(ws, {
          type: 'relay_error',
          code: 'UNKNOWN_TYPE',
          message: `Unknown message type`,
        });
    }
  }

  // ─── Auth ───────────────────────────────────────────────────────────────

  private handleAuth(ws: WebSocket, currentToken: string, msg: { type: 'relay_auth'; token?: string; agentName: string; agentDid?: string }): void {
    // Eger client eski token ile reconnect ediyorsa
    if (msg.token && this.tokenToWs.has(msg.token) && msg.token !== currentToken) {
      // Eski ws mapping'ini temizle
      const oldWs = this.tokenToWs.get(msg.token);
      if (oldWs && oldWs !== ws) {
        this.wsToToken.delete(oldWs);
      }
      // Yeni ws'ye bagla (eski token'i kaldir, reconnect token kullan)
      this.wsToToken.delete(ws);
      this.tokenToWs.delete(currentToken);
      this.wsToToken.set(ws, msg.token);
      this.tokenToWs.set(msg.token, ws);

      // Katilimci bilgilerini guncelle
      const roomId = this.tokenToRoom.get(msg.token);
      if (roomId) {
        const room = this.rooms.get(roomId);
        if (room) {
          const participant = room.participants.get(msg.token);
          if (participant) {
            participant.ws = ws;
            participant.agentName = msg.agentName;
            participant.agentDid = msg.agentDid ?? null;
          }
        }
      }
    } else {
      // Yeni auth veya ayni token — katilimci bilgilerini guncelle
      this.updateParticipantInfo(currentToken, msg.agentName, msg.agentDid ?? null);
    }
  }

  // ─── Room Management ────────────────────────────────────────────────────

  private handleCreateRoom(ws: WebSocket, token: string): void {
    if (this.rooms.size >= this.config.maxRooms) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'MAX_ROOMS_REACHED',
        message: `Maximum room limit reached (${this.config.maxRooms})`,
      });
      return;
    }

    // Kullanici zaten bir room'da mi?
    if (this.tokenToRoom.has(token)) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ALREADY_IN_ROOM',
        message: 'Already in a room. Leave current room first.',
      });
      return;
    }

    const roomId = crypto.randomUUID();
    const code = this.generateRoomCode();
    const now = new Date();

    const room: RelayRoom = {
      id: roomId,
      code,
      hostToken: token,
      participants: new Map(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.roomTTLHours * 3600_000),
      status: 'waiting',
    };

    // Host'u katilimci olarak ekle (agentName henuz bilinmiyor, sonra auth ile gelecek)
    room.participants.set(token, {
      token,
      ws,
      agentName: 'Host',
      agentDid: null,
      connectedAt: now,
      lastMessageAt: now,
    });

    this.rooms.set(roomId, room);
    this.codeToRoom.set(code, roomId);
    this.tokenToRoom.set(token, roomId);
    this.stats.totalRoomsCreated++;

    this.sendToWs(ws, {
      type: 'room_created',
      roomCode: code,
      roomId,
    });

    console.log(`[Relay] Room created: ${code} (${roomId}) by token ${token.slice(0, 8)}...`);
  }

  private handleJoinRoom(ws: WebSocket, token: string, roomCode: string): void {
    const normalizedCode = roomCode.toUpperCase().trim();
    const roomId = this.codeToRoom.get(normalizedCode);

    if (!roomId) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ROOM_NOT_FOUND',
        message: 'Invalid room code',
      });
      return;
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ROOM_NOT_FOUND',
        message: 'Room no longer exists',
      });
      return;
    }

    if (room.status === 'closed') {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ROOM_CLOSED',
        message: 'Room has been closed',
      });
      return;
    }

    if (Date.now() >= room.expiresAt.getTime()) {
      this.closeRoom(room, 'expired');
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ROOM_EXPIRED',
        message: 'Room has expired',
      });
      return;
    }

    if (room.participants.size >= this.config.maxParticipantsPerRoom) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ROOM_FULL',
        message: `Room is full (${this.config.maxParticipantsPerRoom}/${this.config.maxParticipantsPerRoom})`,
      });
      return;
    }

    if (room.participants.has(token)) {
      this.sendToWs(ws, {
        type: 'relay_error',
        code: 'ALREADY_IN_ROOM',
        message: 'Already in this room',
      });
      return;
    }

    // Onceki room'dan ayril
    if (this.tokenToRoom.has(token)) {
      this.handleLeaveRoom(token);
    }

    const now = new Date();
    const newParticipant: RelayParticipant = {
      token,
      ws,
      agentName: 'Guest',
      agentDid: null,
      connectedAt: now,
      lastMessageAt: now,
    };

    room.participants.set(token, newParticipant);
    this.tokenToRoom.set(token, roomId);

    if (room.status === 'waiting') {
      room.status = 'active';
    }

    // Yeni katilimciya mevcut katilimci listesini gonder
    const participantList: Array<{ agentName: string; agentDid: string | null }> = [];
    for (const p of room.participants.values()) {
      if (p.token !== token) {
        participantList.push({ agentName: p.agentName, agentDid: p.agentDid });
      }
    }

    this.sendToWs(ws, {
      type: 'room_joined',
      roomId,
      participants: participantList,
    });

    // Diger katilimcilara yeni katilimciyi bildir
    this.broadcastToRoom(room, token, {
      type: 'participant_joined',
      agentName: newParticipant.agentName,
      agentDid: newParticipant.agentDid,
      participantCount: room.participants.size,
      maxParticipants: this.config.maxParticipantsPerRoom,
    });

    console.log(`[Relay] Token ${token.slice(0, 8)}... joined room ${room.code} (${room.participants.size}/${this.config.maxParticipantsPerRoom})`);
  }

  private handleRoomMessage(token: string, roomId: string, message: Record<string, unknown>): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const sender = room.participants.get(token);
    if (!sender) return;

    sender.lastMessageAt = new Date();
    this.stats.totalMessagesRelayed++;

    // Mesaji room'daki diger herkese relay et
    this.broadcastToRoom(room, token, {
      type: 'room_message',
      from: sender.agentName,
      fromDid: sender.agentDid,
      message,
    });
  }

  private handleLeaveRoom(token: string): void {
    const roomId = this.tokenToRoom.get(token);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(token);
    const agentName = participant?.agentName ?? 'Unknown';

    room.participants.delete(token);
    this.tokenToRoom.delete(token);

    // Diger katilimcilara bildir
    this.broadcastToRoom(room, token, {
      type: 'participant_left',
      agentName,
      participantCount: room.participants.size,
    });

    // Room bossa kapat
    if (room.participants.size === 0) {
      this.closeRoom(room, 'empty');
    }

    console.log(`[Relay] Token ${token.slice(0, 8)}... left room ${room.code}`);
  }

  private handleDisconnect(ws: WebSocket, token: string): void {
    // Room'dan ayril
    this.handleLeaveRoom(token);

    // Mapping'leri temizle
    this.wsToToken.delete(ws);
    this.tokenToWs.delete(token);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Room'daki belirli bir token haricindeki herkese mesaj gonderir. */
  private broadcastToRoom(room: RelayRoom, excludeToken: string, msg: RelayServerMessage): void {
    for (const participant of room.participants.values()) {
      if (participant.token !== excludeToken) {
        this.sendToWs(participant.ws, msg);
      }
    }
  }

  /** Room'daki herkese mesaj gonderir (excludeToken olmadan). */
  private broadcastToAll(room: RelayRoom, msg: RelayServerMessage): void {
    for (const participant of room.participants.values()) {
      this.sendToWs(participant.ws, msg);
    }
  }

  /** WebSocket'e JSON mesaj gonderir. */
  private sendToWs(ws: WebSocket, msg: RelayServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Room'u kapatir ve katilimcilara bildirir. */
  private closeRoom(room: RelayRoom, reason: string): void {
    room.status = 'closed';

    this.broadcastToAll(room, { type: 'room_closed', reason });

    for (const participant of room.participants.values()) {
      this.tokenToRoom.delete(participant.token);
    }

    room.participants.clear();
    this.rooms.delete(room.id);
    this.codeToRoom.delete(room.code);

    console.log(`[Relay] Room ${room.code} closed: ${reason}`);
  }

  /** 6 haneli alfanumerik davet kodu uretir. */
  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    const fullCode = `AF-${code}`;

    // Cakisma kontrolu
    if (this.codeToRoom.has(fullCode)) {
      return this.generateRoomCode();
    }
    return fullCode;
  }

  // ─── Cleanup & Heartbeat ────────────────────────────────────────────────

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.expireStaleRooms();
    }, 60_000);
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.wss) {
        for (const client of this.wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.ping();
          }
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Suresi dolmus room'lari kapatir. */
  private expireStaleRooms(): number {
    let count = 0;
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (now >= room.expiresAt.getTime()) {
        this.closeRoom(room, 'expired');
        count++;
      }
    }
    if (count > 0) {
      console.log(`[Relay] Expired ${count} stale room(s)`);
    }
    return count;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  getStats(): {
    activeRooms: number;
    totalParticipants: number;
    maxRooms: number;
    maxParticipantsPerRoom: number;
    totalRoomsCreated: number;
    totalMessagesRelayed: number;
    totalConnectionsServed: number;
    uptime: number;
  } {
    let totalParticipants = 0;
    for (const room of this.rooms.values()) {
      totalParticipants += room.participants.size;
    }

    return {
      activeRooms: this.rooms.size,
      totalParticipants,
      maxRooms: this.config.maxRooms,
      maxParticipantsPerRoom: this.config.maxParticipantsPerRoom,
      ...this.stats,
      uptime: process.uptime(),
    };
  }

  /** Aktif room sayisini doner. */
  getActiveRoomCount(): number {
    return this.rooms.size;
  }

  /** Bir room'un bilgilerini kod ile doner. */
  getRoomByCode(code: string): { participants: number; maxParticipants: number; createdAt: string; status: string } | null {
    const normalizedCode = code.toUpperCase().trim();
    const roomId = this.codeToRoom.get(normalizedCode);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    return {
      participants: room.participants.size,
      maxParticipants: this.config.maxParticipantsPerRoom,
      createdAt: room.createdAt.toISOString(),
      status: room.status,
    };
  }

  /**
   * Bir katilimcinin agent bilgilerini gunceller.
   * relay_auth mesaji sonrasi cagirilir.
   */
  updateParticipantInfo(token: string, agentName: string, agentDid: string | null): void {
    const roomId = this.tokenToRoom.get(token);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(token);
    if (!participant) return;

    const oldName = participant.agentName;
    participant.agentName = agentName;
    participant.agentDid = agentDid;

    // Isim degistiyse diger katilimcilara bildir
    if (oldName !== agentName) {
      this.broadcastToRoom(room, token, {
        type: 'participant_joined',
        agentName,
        agentDid,
        participantCount: room.participants.size,
        maxParticipants: this.config.maxParticipantsPerRoom,
      });
    }
  }
}

/**
 * Varsayilan relay yapilandirmasi.
 */
export function defaultRelayConfig(): RelayConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '8080', 10),
    host: process.env['HOST'] ?? '0.0.0.0',
    maxRooms: parseInt(process.env['RELAY_MAX_ROOMS'] ?? '100', 10),
    roomTTLHours: parseInt(process.env['RELAY_ROOM_TTL_HOURS'] ?? '24', 10),
    maxParticipantsPerRoom: 7,
  };
}
