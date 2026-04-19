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
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { NetworkEgressFilter, secureConfig } from '../security/network-egress-filter';
import type { NetworkEgressConfig } from '../security/network-egress-filter';
import { ConsentManager } from '../consent/consent';
import { parseDID } from '../identity/agent';
import type { Permission } from '../identity/agent';

// Modüler imports
import { createAuthChallenge, handleAuthResponse, getSocketInfo } from './auth';
import type { AuthResponseMessage } from './auth';
import { handleMessage as processMessage, sendToClient } from './messaging';
import { ServerConsentHandler } from './server-consent';
import { InvitationManager } from './invitations';
import type { Invitation } from './invitations';
import { SessionManager } from './sessions';
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
  private httpServer: http.Server | null = null;
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

  constructor(config: ServerConfig & { networkConfig?: NetworkEgressConfig }) {
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
   * UI klasörü yolunu çözümler.
   * Proje kökündeki ui/ dizinini arar.
   */
  private resolveUiPath(): string {
    // Proje kökündeki ui/ klasörünü bul
    return path.resolve(__dirname, '..', '..', 'ui');
  }

  /**
   * MIME tipini dosya uzantısından belirler.
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.map': 'application/json',
      '.tsx': 'text/plain; charset=utf-8',
      '.ts': 'text/plain; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Statik dosya servis eder.
   * Path traversal saldırılarına karşı güvenlik kontrolü yapar.
   */
  private serveStaticFile(
    res: http.ServerResponse,
    filePath: string,
    baseDir: string,
  ): void {
    // Path traversal koruması: çözümlenmiş yol baseDir içinde olmalı
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(resolvedPath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const mimeType = this.getMimeType(resolvedPath);
      res.writeHead(200, { 'Content-Type': mimeType });
      fs.createReadStream(resolvedPath).pipe(res);
    });
  }

  /**
   * HTTP isteklerini işler.
   * WebSocket olmayan isteklere yanıt verir: health check, UI dosyaları, vb.
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    const parsedPath = url.split('?')[0]; // Query string'i ayır

    // /health → JSON status
    if (parsedPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'ok',
        connections: this.connections.size,
        uptime: process.uptime(),
      }));
      return;
    }

    // /api/stats → Server istatistikleri
    if (parsedPath === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.getStats()));
      return;
    }

    const uiDir = this.resolveUiPath();

    // / → ui/index.html veya ui/app/page.tsx (fallback)
    if (parsedPath === '/' || parsedPath === '/index.html') {
      const indexPath = path.join(uiDir, 'index.html');
      fs.access(indexPath, fs.constants.R_OK, (err) => {
        if (!err) {
          this.serveStaticFile(res, indexPath, uiDir);
        } else {
          // Next.js app varsa bilgilendirici bir HTML döndür
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Federation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 600px; padding: 2rem; }
    h1 { color: #60a5fa; margin-bottom: 0.5rem; }
    .status { color: #34d399; font-weight: bold; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .info { margin-top: 1.5rem; padding: 1rem; background: #1a1a2e; border-radius: 8px; text-align: left; }
    code { background: #2d2d44; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Agent Federation</h1>
    <p class="status">Server Running</p>
    <div class="info">
      <p><strong>WebSocket:</strong> <code>ws://localhost:${this.config.port}</code></p>
      <p><strong>Health:</strong> <a href="/health">/health</a></p>
      <p><strong>Stats:</strong> <a href="/api/stats">/api/stats</a></p>
      <p><strong>UI:</strong> Next.js app — run <code>cd ui && npm run dev</code> for full UI</p>
    </div>
  </div>
</body>
</html>`);
        }
      });
      return;
    }

    // /ui/* → ui/ klasöründen statik dosya servis et
    if (parsedPath.startsWith('/ui/')) {
      const relativePath = parsedPath.slice(4); // '/ui/' prefixini kaldır
      const filePath = path.join(uiDir, relativePath);
      this.serveStaticFile(res, filePath, uiDir);
      return;
    }

    // Diğer statik dosyalar (favicon.ico, vb.)
    const filePath = path.join(uiDir, parsedPath);
    const resolvedFilePath = path.resolve(filePath);
    const resolvedUiDir = path.resolve(uiDir);
    if (resolvedFilePath.startsWith(resolvedUiDir + path.sep) || resolvedFilePath === resolvedUiDir) {
      fs.access(resolvedFilePath, fs.constants.R_OK, (err) => {
        if (!err) {
          this.serveStaticFile(res, resolvedFilePath, uiDir);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Server'ı başlatır.
   * Aynı port üzerinden hem HTTP hem WebSocket bağlantılarını kabul eder.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // SSL deprecation warning
        if (this.config.ssl === false) {
          console.warn('[WS Server] ⚠️  DEPRECATION WARNING: ssl:false is deprecated and will be removed in a future version. SSL/TLS is now required for production. Set ssl:true and provide certPath/keyPath.');
        }

        // HTTP server oluştur — hem HTTP isteklerini hem WebSocket upgrade'lerini yönetir
        const sslEnabled = this.config.ssl !== false; // Default to true
        if (sslEnabled && this.config.certPath && this.config.keyPath) {
          // SSL configured - load certificates
          const https = require('https');
          const certData = fs.readFileSync(this.config.certPath);
          const keyData = fs.readFileSync(this.config.keyPath);
          this.httpServer = https.createServer(
            { cert: certData, key: keyData },
            (req: http.IncomingMessage, res: http.ServerResponse) => this.handleHttpRequest(req, res),
          );
          console.log('[WS Server] SSL/TLS enabled with provided certificates');
        } else {
          if (sslEnabled) {
            console.warn('[WS Server] ⚠️  SSL enabled but certPath/keyPath not provided. Server will start without SSL. For production, set ssl:true with certPath and keyPath.');
          }
          this.httpServer = http.createServer(
            (req: http.IncomingMessage, res: http.ServerResponse) => this.handleHttpRequest(req, res),
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const httpServer = this.httpServer!;

        // WebSocketServer'ı mevcut HTTP server'a bağla (noServer yerine server kullan)
        this.wss = new WebSocketServer({ server: httpServer });

        this.wss.on('error', (error) => {
          console.error('[WS Server] Error:', error);
          this.emit('error', error);
          reject(error);
        });

        this.wss.on('connection', (ws: WebSocket, req: Record<string, unknown>) => {
          this.handleConnection(ws, req);
        });

        // HTTP server'ı dinlemeye başla
        const host = this.config.host || '0.0.0.0';
        httpServer.listen(this.config.port, host, () => {
          console.log(`[WS Server] Listening on port ${this.config.port} (HTTP + WebSocket)`);
          this.startHeartbeat();
          this.invitationManager.startCleanup();
          this.sessionManager.startCleanup();
          resolve();
        });

        httpServer.on('error', (error) => {
          console.error('[WS Server] HTTP Server Error:', error);
          this.emit('error', error);
          reject(error);
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
        console.log('[WS Server] WebSocket closed');
      });
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close(() => {
        console.log('[WS Server] HTTP server closed');
      });
      this.httpServer = null;
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
