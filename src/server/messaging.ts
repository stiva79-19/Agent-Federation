/**
 * Messaging Module — Agent Federation Server
 *
 * Mesaj routing, FederatedMessage işleme, broadcast, rate limiting ve output tarama.
 * Gelen mesajları doğrular, güvenlik taramasından geçirir ve alıcıya iletir.
 */

import { WebSocket } from 'ws';
import { scanMessage } from '../protocol/injection-defense';
import type { AgentConnection, FederatedMessage, ServerConfig } from './types';

/**
 * Rate limit kontrolü sonucu.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
}

/**
 * Output tarama sonucu.
 */
export interface OutputScanResult {
  safe: boolean;
  threats: string[];
}

/**
 * Mesaj routing sonucu.
 */
export interface RouteResult {
  routed: boolean;
  recipientOffline?: boolean;
}

/**
 * Rate limiting kontrolü yapar.
 * Son 60 saniyedeki mesaj sayısını sayar ve limiti aşılıp aşılmadığını kontrol eder.
 *
 * @param conn - Agent bağlantısı
 * @param maxMessagesPerMinute - Dakika başına maksimum mesaj (varsayılan: 100)
 * @returns Rate limit sonucu
 */
export function checkRateLimit(
  conn: AgentConnection,
  maxMessagesPerMinute: number = 100
): RateLimitResult {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Eski timestamp'leri temizle
  conn.messageTimestamps = conn.messageTimestamps.filter(t => t > oneMinuteAgo);

  // Limit kontrolü
  if (conn.messageTimestamps.length >= maxMessagesPerMinute) {
    return { allowed: false };
  }

  // Yeni timestamp ekle
  conn.messageTimestamps.push(now);

  return {
    allowed: true,
    remaining: maxMessagesPerMinute - conn.messageTimestamps.length,
  };
}

/**
 * Agent çıktısını güvenlik açısından tarar.
 * System prompt sızıntısı, API key leakage ve credential leakage tespit eder.
 *
 * @param output - Taranacak çıktı metni
 * @returns Tarama sonucu
 */
export function scanOutput(output: string): OutputScanResult {
  const threats: string[] = [];
  const lower = output.toLowerCase();

  // System prompt sızıntısı
  if (lower.includes('system prompt') || lower.includes('system instruction') || lower.includes('you are a helpful assistant')) {
    threats.push('Potential system prompt leakage');
  }

  // API key / Secret pattern'leri
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{32,}/,       // OpenAI key
    /ghp_[a-zA-Z0-9]{36}/,       // GitHub token
    /xox[baprs]-[a-zA-Z0-9-]+/,  // Slack token
    /AKIA[0-9A-Z]{16}/,          // AWS key
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(output)) {
      threats.push('Potential API key/secret detected');
      break;
    }
  }

  // Credential leakage
  if (/password\s*[=:]\s*\S+/.test(lower) || /secret\s*[=:]\s*\S+/.test(lower)) {
    threats.push('Potential credential leakage');
  }

  // Self-referential AI statements (possible leak)
  if (lower.includes('as an ai language model') || lower.includes('i am an ai')) {
    threats.push('AI identity leakage');
  }

  return {
    safe: threats.length === 0,
    threats,
  };
}

/**
 * Client'a mesaj gönderir. Sadece açık bağlantılara gönderim yapılır.
 *
 * @param ws - Hedef WebSocket
 * @param message - Gönderilecek mesaj
 */
export function sendToClient(ws: WebSocket, message: FederatedMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Mesajı alıcıya yönlendirir. Broadcast veya direct message olarak routing yapar.
 *
 * @param message - Yönlendirilecek mesaj
 * @param connections - Aktif bağlantı map'i
 * @returns Routing sonucu
 */
export function routeMessage(
  message: FederatedMessage,
  connections: Map<string, AgentConnection>
): RouteResult {
  // Broadcast
  if (message.to === 'broadcast' || message.to === '*') {
    for (const conn of connections.values()) {
      if (conn.did !== message.from) {
        sendToClient(conn.ws, message);
        conn.receivedCount++;
      }
    }
    return { routed: true };
  }

  // Direct message
  const recipient = connections.get(message.to);
  if (recipient) {
    sendToClient(recipient.ws, message);
    recipient.receivedCount++;
    return { routed: true };
  }

  return { routed: false, recipientOffline: true };
}

/**
 * Gelen mesajı doğrular ve işler.
 * Rate limiting, injection taraması, output taraması ve TTL kontrolü yapar.
 *
 * @param ws - Gönderen WebSocket
 * @param message - Gelen mesaj
 * @param connections - Aktif bağlantılar
 * @param config - Server yapılandırması
 * @returns Mesaj başarıyla işlendiyse true
 */
export function handleMessage(
  ws: WebSocket,
  message: FederatedMessage,
  connections: Map<string, AgentConnection>,
  config: ServerConfig
): { handled: boolean; routed: boolean; error?: string } {
  const sender = connections.get(message.from);
  if (!sender) {
    console.warn('[WS Server] Message from unknown sender:', message.from);
    return { handled: false, routed: false, error: 'unknown_sender' };
  }

  // RATE LIMITING kontrolü
  const rateLimit = checkRateLimit(sender, config.maxMessagesPerMinute || 100);
  if (!rateLimit.allowed) {
    console.warn(`[WS Server] Rate limit exceeded for ${message.from}`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Rate limit exceeded (max 100 messages/minute)',
    }));
    ws.close(4004, 'Rate limit exceeded');
    return { handled: false, routed: false, error: 'rate_limit_exceeded' };
  }

  // Güvenlik taraması (input validation)
  if (typeof message.payload === 'string') {
    const scanResult = scanMessage(message.payload);
    if (scanResult.action === 'block') {
      console.warn(`[WS Server] Blocked message from ${message.from}: ${scanResult.threats.join(', ')}`);
      ws.send(JSON.stringify({
        type: 'error',
        message: `Message blocked: ${scanResult.threats.join(', ')}`,
      }));
      return { handled: false, routed: false, error: 'blocked_by_scan' };
    }
  }

  // OUTPUT validation (agent response scanning)
  if (message.type === 'text' && typeof message.payload === 'string') {
    const outputScan = scanOutput(message.payload);
    if (!outputScan.safe) {
      console.warn(`[WS Server] Blocked unsafe output from ${message.from}: ${outputScan.threats.join(', ')}`);
      ws.send(JSON.stringify({
        type: 'error',
        message: `Output blocked: ${outputScan.threats.join(', ')}`,
      }));
      return { handled: false, routed: false, error: 'unsafe_output' };
    }
  }

  // TTL kontrolü
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  const age = Date.now() - timestamp.getTime();
  if (age > message.ttlSeconds * 1000) {
    console.warn('[WS Server] Message expired:', message.id);
    return { handled: false, routed: false, error: 'expired' };
  }

  // İstatistikleri güncelle
  sender.sentCount++;
  sender.lastMessageAt = new Date();

  console.log(`[WS Server] Routing message ${message.id} from ${message.from} to ${message.to}`);

  // Mesajı alıcıya yönlendir
  const result = routeMessage(message, connections);

  if (!result.routed) {
    console.log(`[WS Server] Recipient ${message.to} not connected`);
    ws.send(JSON.stringify({
      type: 'delivery_status',
      messageId: message.id,
      status: 'recipient_offline',
    }));
  }

  return { handled: true, routed: result.routed };
}
