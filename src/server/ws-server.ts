/**
 * WebSocket Server — Agent Federation
 *
 * Merkezi WebSocket server for agent'lar arası mesajlaşma.
 * Port 18790'da dinler, bağlantıları yönetir, mesajları routing eder.
 *
 * Bu dosya ince bir orkestratör olarak auth, messaging ve consent modüllerine delege eder.
 * Tüm tipler src/server/types.ts'den gelir (tek kaynak).
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { NetworkEgressFilter, secureConfig } from '../security/network-egress-filter';
import { ConsentManager } from '../consent/consent';
import { parseDID } from '../identity/agent';
import type { Permission } from '../identity/agent';

// Modüler imports
import { createAuthChallenge, handleAuthResponse, getSocketInfo } from './auth';
import type { AuthResponseMessage } from './auth';
import { handleMessage as processMessage, sendToClient } from './messaging';
import { ServerConsentHandler } from './server-consent';
import { InvitationManager } from './invitations';
import type { Invitation, CreateInvitationParams } from './invitations';
import { SessionManager } from './sessions';
import type { CollaborationSession } from './sessions';
import { NotificationManager } from './notifications';
import type {
  ServerConfig,
  AgentConnection,
  FederatedMessage,
  AuthChallenge,
  ServerEvent,
} from './types';

// Re-export types for backward compatibility
export type { ServerConfig, AgentConnection, FederatedMessage, AuthChallenge, ServerEvent };
// Re-export new modules
export { InvitationManager } from './invitations';
export type { Invitation, InvitationStatus, CreateInvitationParams } from './invitations';
export { SessionManager } from './sessions';
export type { CollaborationSession, SessionStatus, SessionParticipant } from './sessions';
export { NotificationManager } from './notifications';
export type { Notification, NotificationType } from './notifications';

/**
 * WebSocket server manager.
 * Agent bağlantılarını yönetir, mesajları routing eder, güvenlik kontrollerini uygular.
 * Auth, messaging ve consent işlemleri ayrı modüllere delege edilir.
 */
export class WebSocketServerManager extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private connections: Map<string, AgentConnection> = new Map();
  private pendingAuth: Map<WebSocket, AuthChallenge> = new Map();
  private readonly heartbeatInterval = 30000; // 30 saniye
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly authTimeout = 10000; // 10 saniye

  /** Server-side consent ve network güvenliği handler'ı */
  private consentHandler: ServerConsentHandler;
  /** Davetiye yöneticisi */
  private invitationManager: InvitationManager;
  /** Collaboration session yöneticisi */
  private sessionManager: SessionManager;
  /** Sahiplere bildirim yöneticisi */
  private notificationManager: NotificationManager;

  constructor(config: ServerConfig & { networkConfig?: Record<string, unknown> }) {
    super();
    this.config = config;

    // Initialize network egress filter with secure defaults
    const networkFilter = new NetworkEgressFilter(
      config.networkConfig || secureConfig()
    );

    // Initialize consent manager
    const consentManager = new ConsentManager();

    // Compose consent handler from filter + manager
    this.consentHandler = new ServerConsentHandler(networkFilter, consentManager);

    // Initialize invitation, session, notification managers
    this.invitationManager = new InvitationManager();
    this.sessionManager = new SessionManager();
    this.notificationManager = new NotificationManager();

    // Wire session end events to notifications
    this.sessionManager.onSessionEnd((session) => {
      this.notificationManager.notifySessionEnded(session);
    });
  }

  /**
   * Network egress filter instance'ını döner.
   */
  getNetworkFilter(): NetworkEgressFilter {
    return this.consentHandler.getNetworkFilter();
  }

  /**
   * Consent manager instance'ını döner.
   */
  getConsentManager(): ConsentManager {
    return this.consentHandler.getConsentManager();
  }

  /**
   * Invitation manager instance'ını döner.
   */
  getInvitationManager(): InvitationManager {
    return this.invitationManager;
  }

  /**
   * Session manager instance'ını döner.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Notification manager instance'ını döner.
   */
  getNotificationManager(): NotificationManager {
    return this.notificationManager;
  }

  /**
   * Server'ı başlatır.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // SSL deprecation warning
        if (this.config.ssl === false) {
          console.warn('[WS Server] ⚠️  DEPRECATION WARNING: ssl:false is deprecated and will be removed in a future version. SSL/TLS is now required for production. Set ssl:true and provide certPath/keyPath.');
        }

        const options: Record<string, unknown> = {
          port: this.config.port,
          host: this.config.host || '0.0.0.0',
        };

        // SSL/TLS configuration (required for production)
        const sslEnabled = this.config.ssl !== false; // Default to true
        if (sslEnabled) {
          if (!this.config.certPath || !this.config.keyPath) {
            console.warn('[WS Server] ⚠️  SSL enabled but certPath/keyPath not provided. Server will start without SSL. For production, set ssl:true with certPath and keyPath.');
          } else {
            // SSL configured - load certificates
            const fs = require('fs');
            options.cert = fs.readFileSync(this.config.certPath);
            options.key = fs.readFileSync(this.config.keyPath);
            console.log('[WS Server] SSL/TLS enabled with provided certificates');
          }
        }

        this.wss = new WebSocketServer(options);

        this.wss.on('listening', () => {
          console.log(`[WS Server] Listening on port ${this.config.port}`);
          this.startHeartbeat();
          this.invitationManager.startCleanup();
          this.sessionManager.startCleanup();
          resolve();
        });

        this.wss.on('error', (error) => {
          console.error('[WS Server] Error:', error);
          this.emit('error', error);
          reject(error);
        });

        this.wss.on('connection', (ws: WebSocket, req: Record<string, unknown>) => {
          this.handleConnection(ws, req);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Server'ı durdurur.
   */
  stop(): void {
    this.stopHeartbeat();
    this.invitationManager.stopCleanup();
    this.sessionManager.stopCleanup();
    this.sessionManager.endAll();

    // Tüm bağlantıları kapat
    for (const conn of this.connections.values()) {
      conn.ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
    this.pendingAuth.clear();

    if (this.wss) {
      this.wss.close(() => {
        console.log('[WS Server] Closed');
      });
      this.wss = null;
    }
  }

  /**
   * Yeni bağlantıyı işler.
   * Auth challenge oluşturur ve mesaj/bağlantı event'lerini dinler.
   */
  private handleConnection(ws: WebSocket, req: Record<string, unknown>): void {
    const url = req.url as string | undefined;
    const clientId = url?.split('?')[0] || 'unknown';
    console.log(`[WS Server] New connection from ${clientId}`);

    // Auth challenge oluştur (auth modülünden)
    const challenge = createAuthChallenge(this.authTimeout);
    this.pendingAuth.set(ws, challenge);

    // Challenge'ı gönder
    ws.send(JSON.stringify({
      type: 'auth_challenge',
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    }));

    // Auth timeout
    const authTimer = setTimeout(() => {
      if (this.pendingAuth.has(ws)) {
        console.log('[WS Server] Auth timeout, closing connection');
        ws.close(4001, 'Authentication timeout');
        this.pendingAuth.delete(ws);
      }
    }, this.authTimeout);

    // Mesaj dinle
    ws.on('message', (data: RawData) => {
      try {
        const message = JSON.parse(data.toString());

        // Auth challenge yanıtı
        if (message.type === 'auth_response') {
          clearTimeout(authTimer);
          this.onAuthResponse(ws, message as AuthResponseMessage, challenge);
          return;
        }

        // Normal mesaj (auth sonrası)
        if (this.connections.has(message.from)) {
          this.onMessage(ws, message as FederatedMessage);
        } else {
          console.warn('[WS Server] Message from unauthenticated client');
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Not authenticated',
          }));
        }
      } catch (error) {
        console.error('[WS Server] Failed to parse message:', error);
      }
    });

    ws.on('close', (_code: number, _reason: Buffer) => {
      clearTimeout(authTimer);
      this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      console.error('[WS Server] Connection error:', error);
      this.emit('error', error);
    });

    // Ping-pong for keepalive
    ws.on('pong', () => {
      const conn = Array.from(this.connections.values()).find(c => c.ws === ws);
      if (conn) {
        conn.lastMessageAt = new Date();
      }
    });
  }

  /**
   * Auth response'u auth modülüne delege eder.
   */
  private onAuthResponse(
    ws: WebSocket,
    message: AuthResponseMessage,
    challenge: AuthChallenge
  ): void {
    const req = getSocketInfo(ws);
    const result = handleAuthResponse(ws, message, challenge, req);

    if (result.success && result.connection) {
      this.pendingAuth.delete(ws);
      this.connections.set(result.connection.did, result.connection);
      this.emit('agent_connected', result.connection);
    }
  }

  /**
   * Mesaj işlemeyi messaging modülüne delege eder.
   * invitation_request ve invitation_response mesajları özel olarak işlenir.
   */
  private onMessage(ws: WebSocket, message: FederatedMessage): void {
    // Invitation request: Agent A → Platform → Agent B'nin sahibine bildirim
    if (message.type === 'invitation_request') {
      this.handleInvitationRequest(ws, message);
      return;
    }

    // Invitation response: Sahip kabul/red → Platform → Session oluştur veya bildirim gönder
    if (message.type === 'invitation_response') {
      this.handleInvitationResponse(ws, message);
      return;
    }

    // Session ended: Sahip session'ı sonlandırmak istiyor
    if (message.type === 'session_ended') {
      this.handleSessionEnd(ws, message);
      return;
    }

    // Normal mesaj routing
    const result = processMessage(ws, message, this.connections, this.config);

    if (result.handled && result.routed) {
      this.emit('message_routed', { message, from: message.from, to: message.to });
    }

    if (result.handled) {
      this.emit('message', message);
    }
  }

  /**
   * Invitation request mesajını işler.
   * Agent A, Agent B ile işbirliği yapmak istiyor.
   */
  private handleInvitationRequest(ws: WebSocket, message: FederatedMessage): void {
    const payload = message.payload as {
      toDid: string;
      purpose: string;
      permissions: Permission[];
      expirationMinutes?: number;
    };

    if (!payload.toDid || !payload.purpose || !payload.permissions) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid invitation_request: missing toDid, purpose, or permissions',
      }));
      return;
    }

    // Gönderen agent'ın DID'sinden sahip bilgisini çıkar
    const fromParsed = parseDID(message.from);
    const toParsed = parseDID(payload.toDid);
    if (!fromParsed || !toParsed) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid DID format in invitation request',
      }));
      return;
    }

    try {
      const invitation = this.invitationManager.create({
        fromDid: message.from,
        fromOwner: fromParsed.ownerId,
        toDid: payload.toDid,
        toOwner: toParsed.ownerId,
        purpose: payload.purpose,
        permissions: payload.permissions,
        expirationMinutes: payload.expirationMinutes,
      });

      // Gönderene onay
      ws.send(JSON.stringify({
        type: 'invitation_sent',
        invitationId: invitation.id,
        status: 'pending',
        expiresAt: invitation.expiresAt.toISOString(),
      }));

      // Alıcı agent'a bildirim gönder (eğer bağlıysa)
      const recipientConn = this.connections.get(payload.toDid);
      if (recipientConn) {
        sendToClient(recipientConn.ws, {
          id: crypto.randomUUID(),
          from: 'server',
          to: payload.toDid,
          type: 'invitation_request',
          payload: {
            invitationId: invitation.id,
            fromDid: invitation.fromDid,
            fromOwner: invitation.fromOwner,
            purpose: invitation.purpose,
            permissions: invitation.permissions,
            expiresAt: invitation.expiresAt.toISOString(),
          },
          timestamp: new Date(),
          ttlSeconds: 3600,
        });
      }

      // Sahibe bildirim gönder
      this.notificationManager.notifyInvitationReceived(invitation);

      this.emit('invitation_created', invitation);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to create invitation',
      }));
    }
  }

  /**
   * Invitation response mesajını işler.
   * Sahip kabul veya red kararını veriyor.
   */
  private handleInvitationResponse(ws: WebSocket, message: FederatedMessage): void {
    const payload = message.payload as {
      invitationId: string;
      accepted: boolean;
      declineReason?: string;
    };

    if (!payload.invitationId || typeof payload.accepted !== 'boolean') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid invitation_response: missing invitationId or accepted',
      }));
      return;
    }

    try {
      let invitation: Invitation;

      if (payload.accepted) {
        // Kabul
        invitation = this.invitationManager.accept(payload.invitationId);

        // Session oluştur
        const session = this.sessionManager.createFromInvitation({ invitation });

        // Her iki agent'a session_started mesajı gönder
        const sessionStartedPayload = {
          sessionId: session.id,
          invitationId: invitation.id,
          participants: session.participants.map(p => ({
            did: p.did,
            owner: p.ownerName,
            permissions: p.permissions,
          })),
          expiresAt: session.expiresAt.toISOString(),
        };

        for (const participant of session.participants) {
          const conn = this.connections.get(participant.did);
          if (conn) {
            sendToClient(conn.ws, {
              id: crypto.randomUUID(),
              from: 'server',
              to: participant.did,
              type: 'session_started',
              payload: sessionStartedPayload,
              timestamp: new Date(),
              ttlSeconds: 3600,
            });
          }
        }

        // Sahiplere bildirim
        this.notificationManager.notifyInvitationAccepted(invitation);
        this.notificationManager.notifySessionStarted(session);

        this.emit('invitation_accepted', { invitation, session });
      } else {
        // Red
        invitation = this.invitationManager.decline(payload.invitationId, payload.declineReason);

        // Gönderen agent'a invitation_declined mesajı
        const senderConn = this.connections.get(invitation.fromDid);
        if (senderConn) {
          sendToClient(senderConn.ws, {
            id: crypto.randomUUID(),
            from: 'server',
            to: invitation.fromDid,
            type: 'invitation_response',
            payload: {
              invitationId: invitation.id,
              accepted: false,
              reason: payload.declineReason,
            },
            timestamp: new Date(),
            ttlSeconds: 3600,
          });
        }

        // Gönderen sahibe bildirim
        this.notificationManager.notifyInvitationDeclined(invitation);

        this.emit('invitation_declined', invitation);
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to process invitation response',
      }));
    }
  }

  /**
   * Session end mesajını işler.
   * Bir sahip session'ı sonlandırmak istiyor.
   */
  private handleSessionEnd(ws: WebSocket, message: FederatedMessage): void {
    const payload = message.payload as { sessionId: string };

    if (!payload.sessionId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid session_ended: missing sessionId',
      }));
      return;
    }

    try {
      const session = this.sessionManager.endSession(payload.sessionId, 'owner_ended', message.from);

      // Tüm katılımcılara session_ended mesajı gönder
      for (const participant of session.participants) {
        const conn = this.connections.get(participant.did);
        if (conn) {
          sendToClient(conn.ws, {
            id: crypto.randomUUID(),
            from: 'server',
            to: participant.did,
            type: 'session_ended',
            payload: {
              sessionId: session.id,
              endReason: session.endReason,
              messageCount: session.messageCount,
            },
            timestamp: new Date(),
            ttlSeconds: 3600,
          });
        }
      }

      this.emit('session_ended', session);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to end session',
      }));
    }
  }

  /**
   * Bağlantı kopmasını işler.
   */
  private handleDisconnect(ws: WebSocket): void {
    let disconnectedDid: string | null = null;

    for (const [did, conn] of this.connections.entries()) {
      if (conn.ws === ws) {
        disconnectedDid = did;
        this.connections.delete(did);
        break;
      }
    }

    this.pendingAuth.delete(ws);

    if (disconnectedDid) {
      console.log(`[WS Server] Agent disconnected: ${disconnectedDid}`);
      this.emit('agent_disconnected', { did: disconnectedDid });
    } else {
      console.log('[WS Server] Unauthenticated connection closed');
    }
  }

  /**
   * Heartbeat başlatır.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.checkStaleConnections();
    }, this.heartbeatInterval);
  }

  /**
   * Heartbeat durdurur.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Heartbeat mesajı gönderir.
   */
  private sendHeartbeat(): void {
    const heartbeat: FederatedMessage = {
      id: crypto.randomUUID(),
      from: 'server',
      to: 'broadcast',
      type: 'heartbeat',
      payload: { timestamp: Date.now(), connections: this.connections.size },
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    for (const conn of this.connections.values()) {
      sendToClient(conn.ws, heartbeat);
    }

    this.emit('heartbeat', heartbeat);
  }

  /**
   * Eski bağlantıları kontrol eder.
   */
  private checkStaleConnections(): void {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 dakika

    for (const [did, conn] of this.connections.entries()) {
      const idleTime = now - conn.lastMessageAt.getTime();
      if (idleTime > staleThreshold) {
        console.log(`[WS Server] Closing stale connection: ${did}`);
        conn.ws.ping();
      }
    }
  }

  /**
   * Aktif bağlantıları listeler.
   */
  getConnections(): AgentConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Bağlantı sayısını döner.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Belirli bir DID'ye ait bağlantıyı bulur.
   */
  getConnectionByDid(did: string): AgentConnection | undefined {
    return this.connections.get(did);
  }

  /**
   * Server istatistikleri.
   */
  getStats(): {
    totalConnections: number;
    uptime: number;
    connections: Array<{
      did: string;
      connectedAt: Date;
      sentCount: number;
      receivedCount: number;
    }>;
  } {
    return {
      totalConnections: this.connections.size,
      uptime: process.uptime(),
      connections: Array.from(this.connections.values()).map(conn => ({
        did: conn.did,
        connectedAt: conn.connectedAt,
        sentCount: conn.sentCount,
        receivedCount: conn.receivedCount,
      })),
    };
  }

  /**
   * Execute code action için onay talebi oluşturur.
   * Consent handler'a delege eder.
   */
  async requestExecuteCodeConsent(
    agentDid: string,
    code: string,
    options?: { requiresNetwork?: boolean; networkUrls?: string[] }
  ): Promise<{ consentRequired: boolean; requestId?: string; riskScore: number }> {
    return this.consentHandler.requestExecuteCodeConsent(agentDid, code, options);
  }

  /**
   * Network request için onay talebi oluşturur.
   * Consent handler'a delege eder.
   */
  async requestNetworkAccessConsent(
    agentDid: string,
    url: string,
    method: string = 'GET',
    hasBody: boolean = false
  ): Promise<{ consentRequired: boolean; requestId?: string; riskScore: number }> {
    return this.consentHandler.requestNetworkAccessConsent(agentDid, url, method, hasBody);
  }

  /**
   * Güvenli network request yapar (whitelist + consent kontrolü ile).
   * Consent handler'a delege eder.
   */
  async secureNetworkRequest(
    agentDid: string,
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
      skipConsent?: boolean;
      timeout?: number;
    }
  ): Promise<Record<string, unknown>> {
    return this.consentHandler.secureNetworkRequest(agentDid, url, options);
  }
}

/**
 * Varsayılan server yapılandırması.
 * Production için SSL/TLS zorunludur.
 */
export function defaultServerConfig(): ServerConfig {
  return {
    port: 18790,
    host: '0.0.0.0',
    ssl: true,
  };
}
