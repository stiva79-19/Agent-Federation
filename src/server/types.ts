/**
 * Shared Types — Agent Federation Server
 *
 * Tüm server modüllerinin kullandığı ortak tipler.
 * Bu dosya FederatedMessage, AgentConnection vb. için tek kaynak (single source of truth).
 */

import { WebSocket } from 'ws';
import { AgentIdentity } from '../identity/agent';

/**
 * WebSocket server yapılandırması.
 * Production ortamında SSL/TLS zorunludur.
 */
export interface ServerConfig {
  /** Dinlenecek port */
  port: number;
  /** Host */
  host?: string;
  /** SSL enabled mi (varsayılan: true, production için zorunlu) */
  ssl?: boolean;
  /** SSL certificate path */
  certPath?: string;
  /** SSL key path */
  keyPath?: string;
  /** Rate limiting: Maksimum mesaj/dakika */
  maxMessagesPerMinute?: number;
  /** Maksimum bağlantı süresi (saat) */
  maxSessionHours?: number;
}

/**
 * Bağlı bir agent'ın bağlantı bilgileri.
 * Kimlik doğrulama sonrası oluşturulur ve bağlantı boyunca güncellenir.
 */
export interface AgentConnection {
  /** Agent DID */
  did: string;
  /** WebSocket instance */
  ws: WebSocket;
  /** Bağlantı zamanı */
  connectedAt: Date;
  /** Son mesaj zamanı */
  lastMessageAt: Date;
  /** Gönderilen mesaj sayısı */
  sentCount: number;
  /** Alınan mesaj sayısı */
  receivedCount: number;
  /** Agent identity */
  identity?: AgentIdentity;
  /** Rate limiting: Son 60 saniyedeki mesaj timestamp'leri */
  messageTimestamps: number[];
  /** Connection fingerprint (IP + User-Agent hash) */
  fingerprint?: string;
  /** Public key (signature verification için) */
  publicKey?: string;
}

/**
 * Agent'lar arası iletilen mesaj formatı.
 * Her mesaj imzalanabilir ve TTL ile süresi dolabilir.
 */
export interface FederatedMessage {
  id: string;
  /** Gönderen DID */
  from: string;
  /** Alıcı DID */
  to: string;
  /** Mesaj tipi */
  type: 'text' | 'file' | 'invitation' | 'consent_request' | 'consent_response' | 'heartbeat' | 'invitation_request' | 'invitation_response' | 'session_started' | 'session_ended';
  /** İçerik */
  payload: unknown;
  /** İmza */
  signature?: string;
  /** Oluşturulma zamanı */
  timestamp: Date;
  /** TTL (saniye) */
  ttlSeconds: number;
}

/**
 * Kimlik doğrulama challenge'ı.
 * Yeni bağlantılarda agent'a gönderilir, agent nonce'u imzalayarak yanıt verir.
 */
export interface AuthChallenge {
  /** Challenge ID */
  challengeId: string;
  /** Nonce (random string) */
  nonce: string;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Son kullanım zamanı */
  expiresAt: Date;
}

/**
 * Server tarafından emit edilen event tipleri.
 */
export type ServerEvent =
  | 'agent_connected'
  | 'agent_disconnected'
  | 'message'
  | 'message_routed'
  | 'error'
  | 'heartbeat';
