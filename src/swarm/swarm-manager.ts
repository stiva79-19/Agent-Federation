/**
 * Swarm Manager — Agent Federation
 *
 * Hyperswarm tabanlı torrent-style P2P session yönetimi.
 * Merkezi sunucu YOK — tüm iletişim DHT üzerinden P2P.
 *
 * Akış:
 * 1. createSession() → 32 byte random topic → hex-encoded "torrent key"
 * 2. Key paylaşılır (QR, mesaj, vb.)
 * 3. joinSession(key) → aynı topic'e bağlanır
 * 4. Hyperswarm DHT üzerinden NAT traversal + holepunch otomatik
 * 5. Max 7 peer, newline-delimited JSON protokolü
 */

import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  type SwarmMessage,
  type HandshakeMessage,
  type HandshakeAckMessage,
  type PeerJoinedPayload,
  type PeerLeftPayload,
  type ErrorPayload,
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  HANDSHAKE_TIMEOUT,
  createHandshake,
  createHandshakeAck,
  createSwarmMessage,
  createPing,
  createPong,
  createError,
  serializeMessage,
  parseBuffer,
} from './protocol.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * SwarmManager yapılandırması.
 */
export interface SwarmConfig {
  /** Agent adı */
  agentName: string;
  /** Agent DID */
  agentDid: string;
  /** Maksimum peer sayısı (varsayılan: 7) */
  maxPeers: number;
}

/**
 * Aktif swarm session bilgisi.
 */
export interface SwarmSession {
  /** Hex-encoded 32 byte topic — "torrent key" */
  sessionKey: string;
  /** Raw topic buffer (Hyperswarm join için) */
  topic: Buffer;
  /** Bağlı peer'lar (peerId → PeerConnection) */
  peers: Map<string, PeerConnection>;
  /** Session oluşturulma zamanı */
  createdAt: Date;
}

/**
 * Bir peer bağlantısının bilgileri.
 */
export interface PeerConnection {
  /** Hyperswarm duplex stream */
  socket: NodeJS.ReadWriteStream & { remotePublicKey?: Buffer; destroy(): void };
  /** Peer'ın agent adı (handshake sonrası dolar) */
  agentName: string;
  /** Peer'ın DID'i (handshake sonrası dolar) */
  agentDid: string;
  /** Bağlantı zamanı */
  connectedAt: Date;
  /** Son mesaj zamanı */
  lastMessageAt: Date;
  /** Handshake tamamlandı mı */
  handshakeComplete: boolean;
  /** Gelen veri buffer'ı (newline-delimited JSON parse için) */
  buffer: string;
}

/**
 * SwarmManager tarafından emit edilen event'ler.
 */
export interface SwarmManagerEvents {
  /** Yeni peer bağlandı (handshake tamamlandıktan sonra) */
  peer_connected: (peer: PeerConnection) => void;
  /** Peer bağlantısı kesildi */
  peer_disconnected: (peerId: string, agentName: string) => void;
  /** Peer'dan mesaj geldi */
  message: (peerId: string, message: SwarmMessage) => void;
  /** Session oluşturuldu */
  session_created: (sessionKey: string) => void;
  /** Session'a katılındı */
  session_joined: (sessionKey: string) => void;
  /** Session kapatıldı */
  session_closed: () => void;
  /** Hata */
  error: (error: Error) => void;
}

// ─── Default Config ─────────────────────────────────────────────────────────

/**
 * Varsayılan SwarmManager yapılandırması.
 */
export function defaultSwarmConfig(): SwarmConfig {
  return {
    agentName: process.env['AGENT_NAME'] || 'MrClaw',
    agentDid: process.env['AGENT_DID'] || `did:claw:${(process.env['AGENT_NAME'] || 'mrclaw').toLowerCase()}`,
    maxPeers: parseInt(process.env['SWARM_MAX_PEERS'] || '7', 10),
  };
}

// ─── SwarmManager ───────────────────────────────────────────────────────────

/**
 * Hyperswarm tabanlı P2P session yöneticisi.
 *
 * Kullanım:
 * ```ts
 * const manager = new SwarmManager({ agentName: 'MrClaw', agentDid: 'did:claw:ali:mrclaw', maxPeers: 7 });
 * manager.on('peer_connected', (peer) => console.log('Peer:', peer.agentName));
 * manager.on('message', (peerId, msg) => console.log('Message:', msg));
 *
 * // Host: session oluştur
 * const { sessionKey } = manager.createSession();
 * console.log('Share this key:', sessionKey);
 *
 * // Guest: session'a katıl
 * manager.joinSession(sessionKey);
 * ```
 */
export class SwarmManager extends EventEmitter {
  private swarm: Hyperswarm;
  private session: SwarmSession | null = null;
  private config: SwarmConfig;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(config?: Partial<SwarmConfig>) {
    super();
    this.config = { ...defaultSwarmConfig(), ...config };
    this.swarm = new Hyperswarm();

    // Hyperswarm bağlantı event'i
    this.swarm.on('connection', (socket: NodeJS.ReadWriteStream & { remotePublicKey?: Buffer; destroy(): void }, info: { publicKey?: Buffer }) => {
      this.handleConnection(socket, info);
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Yeni session oluşturur — rastgele 32 byte topic üretir.
   * Bu topic'in hex hali "torrent key" olarak paylaşılır.
   *
   * @returns Session key (hex string)
   */
  createSession(): { sessionKey: string } {
    if (this.session) {
      throw new Error('Already in a session. Leave current session first.');
    }

    const topic = crypto.randomBytes(32);
    const sessionKey = topic.toString('hex');

    this.session = {
      sessionKey,
      topic,
      peers: new Map(),
      createdAt: new Date(),
    };

    // Topic'e katıl — hem server hem client olarak (mesh)
    this.swarm.join(topic, { server: true, client: true });

    // Heartbeat başlat
    this.startHeartbeat();

    console.log(`[Swarm] Session created: ${sessionKey.slice(0, 16)}...`);
    this.emit('session_created', sessionKey);

    return { sessionKey };
  }

  /**
   * Mevcut bir session'a katılır — key ile bağlanır.
   * NAT traversal Holepunch tarafından otomatik yapılır.
   *
   * @param sessionKey - Hex-encoded 32 byte topic
   */
  joinSession(sessionKey: string): void {
    if (this.session) {
      throw new Error('Already in a session. Leave current session first.');
    }

    // Key validation
    if (!/^[0-9a-f]{64}$/i.test(sessionKey)) {
      throw new Error('Invalid session key: must be 64 hex characters (32 bytes)');
    }

    const topic = Buffer.from(sessionKey, 'hex');

    this.session = {
      sessionKey,
      topic,
      peers: new Map(),
      createdAt: new Date(),
    };

    // Topic'e katıl
    this.swarm.join(topic, { server: true, client: true });

    // Heartbeat başlat
    this.startHeartbeat();

    console.log(`[Swarm] Joining session: ${sessionKey.slice(0, 16)}...`);
    this.emit('session_joined', sessionKey);
  }

  /**
   * Tüm bağlı peer'lara mesaj gönderir (broadcast).
   *
   * @param message - Gönderilecek SwarmMessage
   */
  broadcast(message: SwarmMessage): void {
    if (!this.session) return;

    const data = serializeMessage(message);
    for (const [, peer] of this.session.peers) {
      if (peer.handshakeComplete) {
        try {
          (peer.socket as NodeJS.WritableStream).write(data);
        } catch {
          // Yazma hatası — peer muhtemelen disconnect olmuş
        }
      }
    }
  }

  /**
   * Payload'dan SwarmMessage oluşturup broadcast eder.
   * Convenience method.
   */
  broadcastPayload(type: SwarmMessage['type'], payload: unknown): void {
    const message = createSwarmMessage(
      type,
      { agentName: this.config.agentName, agentDid: this.config.agentDid },
      payload,
    );
    this.broadcast(message);
  }

  /**
   * Belirli bir peer'a mesaj gönderir.
   *
   * @param peerId - Hedef peer'ın ID'si
   * @param message - Gönderilecek SwarmMessage
   */
  sendToPeer(peerId: string, message: SwarmMessage): void {
    if (!this.session) return;

    const peer = this.session.peers.get(peerId);
    if (!peer || !peer.handshakeComplete) return;

    try {
      const data = serializeMessage(message);
      (peer.socket as NodeJS.WritableStream).write(data);
    } catch {
      // Yazma hatası
    }
  }

  /**
   * Session'dan ayrılır — tüm bağlantıları kapatır.
   */
  leaveSession(): void {
    if (!this.session) return;

    console.log(`[Swarm] Leaving session: ${this.session.sessionKey.slice(0, 16)}...`);

    // Heartbeat durdur
    this.stopHeartbeat();

    // Topic'ten ayrıl
    this.swarm.leave(this.session.topic);

    // Tüm peer bağlantılarını kapat
    for (const [peerId, peer] of this.session.peers) {
      try {
        peer.socket.destroy();
      } catch {
        // Ignore
      }
      this.emit('peer_disconnected', peerId, peer.agentName);
    }

    this.session.peers.clear();
    this.session = null;

    this.emit('session_closed');
  }

  /**
   * SwarmManager'ı tamamen yok eder.
   * leaveSession + Hyperswarm instance'ını kapatır.
   * Timeout ile korunur — Hyperswarm destroy bazen yavaş olabilir.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.leaveSession();

    // Hyperswarm destroy bazen DHT cleanup nedeniyle yavaş olabilir.
    // 5 saniye timeout ile korunur.
    try {
      await Promise.race([
        this.swarm.destroy(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Ignore destroy errors
    }
    console.log('[Swarm] Manager destroyed');
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  /** Aktif session var mı */
  get hasSession(): boolean {
    return this.session !== null;
  }

  /** Aktif session key */
  get sessionKey(): string | null {
    return this.session?.sessionKey ?? null;
  }

  /** Bağlı peer sayısı */
  get peerCount(): number {
    return this.session?.peers.size ?? 0;
  }

  /** Maksimum peer sayısı */
  get maxPeers(): number {
    return this.config.maxPeers;
  }

  /** Agent adı */
  get agentName(): string {
    return this.config.agentName;
  }

  /** Agent DID */
  get agentDid(): string {
    return this.config.agentDid;
  }

  /** Bağlı peer listesi */
  getPeers(): Array<{ peerId: string; agentName: string; agentDid: string; connectedAt: Date }> {
    if (!this.session) return [];
    const peers: Array<{ peerId: string; agentName: string; agentDid: string; connectedAt: Date }> = [];
    for (const [peerId, peer] of this.session.peers) {
      if (peer.handshakeComplete) {
        peers.push({
          peerId,
          agentName: peer.agentName,
          agentDid: peer.agentDid,
          connectedAt: peer.connectedAt,
        });
      }
    }
    return peers;
  }

  /** Session bilgisi (dashboard için) */
  getSessionInfo(): {
    sessionKey: string | null;
    peerCount: number;
    maxPeers: number;
    peers: Array<{ peerId: string; agentName: string; agentDid: string; connectedAt: string }>;
    createdAt: string | null;
  } {
    return {
      sessionKey: this.session?.sessionKey ?? null,
      peerCount: this.peerCount,
      maxPeers: this.config.maxPeers,
      peers: this.getPeers().map(p => ({
        ...p,
        connectedAt: p.connectedAt.toISOString(),
      })),
      createdAt: this.session?.createdAt.toISOString() ?? null,
    };
  }

  // ─── Connection Handling ────────────────────────────────────────────────

  /**
   * Yeni Hyperswarm bağlantısını işler.
   * Max peer kontrolü yapar, handshake başlatır.
   */
  private handleConnection(
    socket: NodeJS.ReadWriteStream & { remotePublicKey?: Buffer; destroy(): void },
    _info: { publicKey?: Buffer },
  ): void {
    if (!this.session) {
      socket.destroy();
      return;
    }

    // Peer ID: remotePublicKey hex veya random
    const peerId = socket.remotePublicKey
      ? socket.remotePublicKey.toString('hex').slice(0, 16)
      : crypto.randomBytes(8).toString('hex');

    console.log(`[Swarm] New connection: ${peerId}`);

    // Max peer kontrolü
    if (this.session.peers.size >= this.config.maxPeers) {
      console.log(`[Swarm] Rejecting peer ${peerId}: session full (${this.session.peers.size}/${this.config.maxPeers})`);
      const errorMsg = createError(
        { agentName: this.config.agentName, agentDid: this.config.agentDid },
        'MAX_PEERS',
        `Session is full (max ${this.config.maxPeers})`,
      );
      try {
        (socket as NodeJS.WritableStream).write(serializeMessage(errorMsg));
      } catch {
        // Ignore
      }
      socket.destroy();
      return;
    }

    // PeerConnection oluştur
    const peer: PeerConnection = {
      socket,
      agentName: 'Unknown',
      agentDid: '',
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      handshakeComplete: false,
      buffer: '',
    };

    this.session.peers.set(peerId, peer);

    // Handshake gönder
    const handshake = createHandshake(this.config.agentName, this.config.agentDid);
    try {
      (socket as NodeJS.WritableStream).write(serializeMessage(handshake));
    } catch {
      this.removePeer(peerId);
      return;
    }

    // Handshake timeout
    const handshakeTimer = setTimeout(() => {
      if (!peer.handshakeComplete) {
        console.log(`[Swarm] Handshake timeout for peer ${peerId}`);
        this.removePeer(peerId);
      }
    }, HANDSHAKE_TIMEOUT);

    // Veri dinle
    socket.on('data', (data: Buffer) => {
      peer.lastMessageAt = new Date();
      peer.buffer += data.toString();

      const [messages, remaining] = parseBuffer(peer.buffer);
      peer.buffer = remaining;

      for (const msg of messages) {
        this.handlePeerMessage(peerId, peer, msg, handshakeTimer);
      }
    });

    // Bağlantı kapandı
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.removePeer(peerId);
    });

    socket.on('error', (err: Error) => {
      console.error(`[Swarm] Peer ${peerId} error:`, err.message);
      clearTimeout(handshakeTimer);
      this.removePeer(peerId);
    });
  }

  /**
   * Peer'dan gelen mesajı işler.
   */
  private handlePeerMessage(
    peerId: string,
    peer: PeerConnection,
    message: SwarmMessage,
    handshakeTimer: NodeJS.Timeout,
  ): void {
    // Handshake henüz tamamlanmadıysa sadece handshake/handshake_ack kabul et
    if (!peer.handshakeComplete) {
      if (message.type === 'handshake') {
        this.handleHandshake(peerId, peer, message as HandshakeMessage, handshakeTimer);
        return;
      }
      if (message.type === 'handshake_ack') {
        this.handleHandshakeAck(peerId, peer, message as HandshakeAckMessage, handshakeTimer);
        return;
      }
      // Handshake öncesi diğer mesajları yoksay
      return;
    }

    // Handshake tamamlanmış — normal mesaj işleme
    switch (message.type) {
      case 'ping':
        this.handlePing(peerId, peer);
        break;
      case 'pong':
        // Heartbeat yanıtı — lastMessageAt zaten güncellendi
        break;
      case 'error': {
        const errorPayload = message.payload as ErrorPayload;
        console.warn(`[Swarm] Peer ${peerId} error: [${errorPayload.code}] ${errorPayload.message}`);
        break;
      }
      default:
        // Tüm diğer mesajları üst katmana ilet
        this.emit('message', peerId, message);
        break;
    }
  }

  /**
   * Handshake mesajını işler — karşı tarafın kimliğini alır, ACK gönderir.
   */
  private handleHandshake(
    peerId: string,
    peer: PeerConnection,
    message: HandshakeMessage,
    handshakeTimer: NodeJS.Timeout,
  ): void {
    const payload = message.payload;

    // Kimlik bilgilerini kaydet
    peer.agentName = payload.agentName;
    peer.agentDid = payload.agentDid;
    peer.handshakeComplete = true;
    clearTimeout(handshakeTimer);

    // Mevcut peer listesini hazırla
    const currentPeers: Array<{ agentName: string; agentDid: string }> = [];
    if (this.session) {
      for (const [pid, p] of this.session.peers) {
        if (pid !== peerId && p.handshakeComplete) {
          currentPeers.push({ agentName: p.agentName, agentDid: p.agentDid });
        }
      }
    }

    // ACK gönder
    const ack = createHandshakeAck(
      { agentName: this.config.agentName, agentDid: this.config.agentDid },
      true,
      this.session?.sessionKey ?? '',
      currentPeers,
    );
    try {
      (peer.socket as NodeJS.WritableStream).write(serializeMessage(ack));
    } catch {
      // Ignore
    }

    console.log(`[Swarm] Peer authenticated: ${peer.agentName} (${peer.agentDid}) [${peerId}]`);
    this.emit('peer_connected', peer);

    // Diğer peer'lara "peer_joined" bildirimi
    this.broadcastPeerJoined(peerId, peer);
  }

  /**
   * Handshake ACK mesajını işler — karşı taraf handshake'i onayladı.
   */
  private handleHandshakeAck(
    peerId: string,
    peer: PeerConnection,
    message: HandshakeAckMessage,
    handshakeTimer: NodeJS.Timeout,
  ): void {
    const payload = message.payload;

    if (!payload.accepted) {
      console.log(`[Swarm] Handshake rejected by peer ${peerId}: ${payload.reason}`);
      clearTimeout(handshakeTimer);
      this.removePeer(peerId);
      return;
    }

    // Kimlik bilgilerini kaydet (from alanından)
    peer.agentName = message.from.agentName;
    peer.agentDid = message.from.agentDid;
    peer.handshakeComplete = true;
    clearTimeout(handshakeTimer);

    console.log(`[Swarm] Handshake complete with: ${peer.agentName} (${peer.agentDid}) [${peerId}]`);
    this.emit('peer_connected', peer);

    // Diğer peer'lara "peer_joined" bildirimi
    this.broadcastPeerJoined(peerId, peer);
  }

  /**
   * Ping'e pong ile yanıt verir.
   */
  private handlePing(peerId: string, peer: PeerConnection): void {
    const pong = createPong({ agentName: this.config.agentName, agentDid: this.config.agentDid });
    try {
      (peer.socket as NodeJS.WritableStream).write(serializeMessage(pong));
    } catch {
      // Ignore
    }
  }

  /**
   * Peer'ı session'dan kaldırır ve temizlik yapar.
   */
  private removePeer(peerId: string): void {
    if (!this.session) return;

    const peer = this.session.peers.get(peerId);
    if (!peer) return;

    this.session.peers.delete(peerId);

    try {
      peer.socket.destroy();
    } catch {
      // Ignore
    }

    const agentName = peer.agentName;
    console.log(`[Swarm] Peer disconnected: ${agentName} [${peerId}]`);

    if (peer.handshakeComplete) {
      this.emit('peer_disconnected', peerId, agentName);

      // Diğer peer'lara "peer_left" bildirimi
      this.broadcastPeerLeft(peerId, peer);
    }
  }

  /**
   * Tüm peer'lara "peer_joined" bildirimi gönderir.
   */
  private broadcastPeerJoined(excludePeerId: string, newPeer: PeerConnection): void {
    if (!this.session) return;

    const payload: PeerJoinedPayload = {
      agentName: newPeer.agentName,
      agentDid: newPeer.agentDid,
      peerCount: this.peerCount,
      maxPeers: this.config.maxPeers,
    };

    const message = createSwarmMessage(
      'peer_joined',
      { agentName: this.config.agentName, agentDid: this.config.agentDid },
      payload,
    );

    const data = serializeMessage(message);
    for (const [pid, peer] of this.session.peers) {
      if (pid !== excludePeerId && peer.handshakeComplete) {
        try {
          (peer.socket as NodeJS.WritableStream).write(data);
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Tüm peer'lara "peer_left" bildirimi gönderir.
   */
  private broadcastPeerLeft(_excludePeerId: string, leftPeer: PeerConnection): void {
    if (!this.session) return;

    const payload: PeerLeftPayload = {
      agentName: leftPeer.agentName,
      agentDid: leftPeer.agentDid,
      peerCount: this.peerCount,
    };

    const message = createSwarmMessage(
      'peer_left',
      { agentName: this.config.agentName, agentDid: this.config.agentDid },
      payload,
    );

    const data = serializeMessage(message);
    for (const [, peer] of this.session.peers) {
      if (peer.handshakeComplete) {
        try {
          (peer.socket as NodeJS.WritableStream).write(data);
        } catch {
          // Ignore
        }
      }
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────

  /**
   * Periyodik heartbeat başlatır.
   * Stale peer'ları tespit edip kapatır.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.session) return;

      const now = Date.now();
      const ping = createPing({ agentName: this.config.agentName, agentDid: this.config.agentDid });
      const data = serializeMessage(ping);

      for (const [peerId, peer] of this.session.peers) {
        if (!peer.handshakeComplete) continue;

        // Stale peer kontrolü
        const idle = now - peer.lastMessageAt.getTime();
        if (idle > HEARTBEAT_TIMEOUT) {
          console.log(`[Swarm] Peer ${peerId} timed out (${Math.round(idle / 1000)}s idle)`);
          this.removePeer(peerId);
          continue;
        }

        // Ping gönder
        try {
          (peer.socket as NodeJS.WritableStream).write(data);
        } catch {
          this.removePeer(peerId);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Heartbeat'i durdurur.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
