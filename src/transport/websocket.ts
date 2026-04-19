/**
 * Transport Layer — WebSocket + NAT Traversal
 * 
 * Agent'lar arası güvenli mesajlaşma.
 * Tailscale/Cloudflare Tunnel ile NAT arkasından iletişim.
 */

import { EventEmitter } from 'events';
import { scanMessage } from '../protocol/injection-defense';

export interface TransportConfig {
  /** WebSocket server URL */
  serverUrl?: string;
  /** Tailscale enabled mı */
  tailscaleEnabled: boolean;
  /** Tailscale hostname */
  tailscaleHostname?: string;
  /** Port */
  port: number;
  /** SSL enabled mi (varsayılan: true, production için zorunlu) */
  ssl?: boolean;
}

export interface PeerConnection {
  /** Peer agent DID */
  peerDid: string;
  /** Connection ID */
  connectionId: string;
  /** Bağlantı zamanı */
  connectedAt: Date;
  /** Son mesaj zamanı */
  lastMessageAt: Date;
  /** Mesaj sayısı */
  messageCount: number;
  /** Durum */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export interface FederatedMessage {
  id: string;
  /** Gönderen DID */
  from: string;
  /** Alıcı DID */
  to: string;
  /** Mesaj tipi */
  type: 'text' | 'file' | 'invitation' | 'consent_request' | 'consent_response' | 'heartbeat';
  /** İçerik */
  payload: unknown;
  /** İmza */
  signature?: string;
  /** Oluşturulma zamanı */
  timestamp: Date;
  /** TTL (saniye) */
  ttlSeconds: number;
}

export type TransportEvent = 
  | 'connected'
  | 'disconnected'
  | 'message'
  | 'error'
  | 'peer_connected'
  | 'peer_disconnected';

export class Transport extends EventEmitter {
  private config: TransportConfig;
  private ws: WebSocket | null = null;
  private connections: Map<string, PeerConnection> = new Map();
  private messageQueue: FederatedMessage[] = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 3000;

  constructor(config: TransportConfig) {
    super();
    this.config = config;
  }

  /**
   * WebSocket bağlantısı başlatır
   */
  async connect(): Promise<void> {
    const url = this.getWebSocketUrl();
    console.log(`[Transport] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          console.log('[Transport] Connected');
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.emit('connected');
          resolve();
        };

        this.ws.onclose = (event) => {
          console.log(`[Transport] Disconnected: ${event.code} ${event.reason}`);
          this.stopHeartbeat();
          this.emit('disconnected', event);
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[Transport] Error:', error);
          this.emit('error', error);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        // Connection timeout
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.CONNECTING) {
            reject(new Error('Connection timeout'));
          }
        }, 10000);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Bağlantıyı kapatır
   */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connections.clear();
  }

  /**
   * Mesaj gönderir
   */
  async send(message: FederatedMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[Transport] Queueing message (not connected)');
      this.messageQueue.push(message);
      return;
    }

    // Güvenlik taraması
    if (typeof message.payload === 'string') {
      const scanResult = scanMessage(message.payload);
      if (scanResult.action === 'block') {
        throw new Error(`Message blocked: ${scanResult.threats.join(', ')}`);
      }
    }

    const data = JSON.stringify(message);
    this.ws.send(data);
    console.log(`[Transport] Sent message ${message.id} to ${message.to}`);
  }

  /**
   * Peer bağlantısını kaydeder
   */
  registerPeer(peerDid: string, connectionId: string): void {
    const connection: PeerConnection = {
      peerDid,
      connectionId,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 0,
      status: 'connected',
    };
    this.connections.set(connectionId, connection);
    this.emit('peer_connected', connection);
  }

  /**
   * Peer bağlantısını kaldırır
   */
  unregisterPeer(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = 'disconnected';
      this.connections.delete(connectionId);
      this.emit('peer_disconnected', connection);
    }
  }

  /**
   * Aktif bağlantıları listeler
   */
  getConnections(): PeerConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * WebSocket URL'i oluşturur
   * SSL varsayılan olarak aktiftir (wss://)
   */
  private getWebSocketUrl(): string {
    // SSL varsayılan: true (güvenli bağlantı için)
    const sslEnabled = this.config.ssl !== false;
    const protocol = sslEnabled ? 'wss' : 'ws';

    if (this.config.tailscaleEnabled && this.config.tailscaleHostname) {
      return `${protocol}://${this.config.tailscaleHostname}:${this.config.port}/ws`;
    }

    // Varsayılan URL: WSS kullan (güvenli)
    return this.config.serverUrl || `${protocol}://localhost:${this.config.port}/ws`;
  }

  /**
   * Gelen mesajı işler
   */
  private handleMessage(data: string): void {
    try {
      const message: FederatedMessage = JSON.parse(data);
      
      // Güvenlik taraması (gelen mesaj)
      if (typeof message.payload === 'string') {
        const scanResult = scanMessage(message.payload);
        if (scanResult.action === 'block') {
          console.warn(`[Transport] Blocked incoming message: ${scanResult.threats.join(', ')}`);
          return;
        }
      }

      // TTL kontrolü
      const age = Date.now() - message.timestamp.getTime();
      if (age > message.ttlSeconds * 1000) {
        console.warn(`[Transport] Message expired: ${message.id}`);
        return;
      }

      // Peer connection güncelle
      const connection = Array.from(this.connections.values())
        .find(c => c.peerDid === message.from);
      if (connection) {
        connection.lastMessageAt = new Date();
        connection.messageCount++;
      }

      this.emit('message', message);
    } catch (error) {
      console.error('[Transport] Failed to parse message:', error);
      this.emit('error', error);
    }
  }

  /**
   * Yeniden bağlanma dener
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Transport] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    console.log(`[Transport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(err => {
        console.error('[Transport] Reconnect failed:', err);
      });
    }, delay);
  }

  /**
   * Heartbeat başlatır
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 30000); // 30 saniye
  }

  /**
   * Heartbeat durdurur
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Heartbeat mesajı gönderir
   */
  private sendHeartbeat(): void {
    const heartbeat: FederatedMessage = {
      id: crypto.randomUUID(),
      from: 'system',
      to: 'broadcast',
      type: 'heartbeat',
      payload: { timestamp: Date.now() },
      timestamp: new Date(),
      ttlSeconds: 60,
    };
    this.send(heartbeat).catch(err => {
      console.warn('[Transport] Heartbeat failed:', err);
    });
  }
}

/**
 * Varsayılan transport yapılandırması
 * Production için SSL/TLS zorunludur (wss://).
 */
export function defaultTransportConfig(): TransportConfig {
  return {
    tailscaleEnabled: true,
    port: 18790,
    ssl: true, // SSL/TLS varsayılan olarak aktif (WSS)
  };
}
