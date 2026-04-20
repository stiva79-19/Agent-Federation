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
import { P2PManager } from './p2p';
import { Agent, loadAgentConfig, loadOpenClawIdentity } from '../agent/agent';
import type { OpenClawIdentity } from '../agent/agent';
import type { LLMConfig } from '../agent/llm';
import { diagnoseLLMConfig } from '../agent/llm';
import { getOpenClawAutoConfig, loadLLMConfig } from '../agent/llm';
import type { SwarmManager } from '../swarm/swarm-manager';
import type { SwarmMessage } from '../swarm/protocol';
import { SandboxFS } from './sandbox-fs';
import { ApprovalManager } from './approval';
import type { ApprovalRequest, ApprovalMode } from './approval';
import type {
  ServerConfig,
  AgentConnection,
  FederatedMessage,
  AuthChallenge,
  ServerEvent,
  DashboardAgentStatus,
} from './types';
import { MAX_CONNECTED_AGENTS } from './types';

// Re-export types for backward compatibility
export type { ServerConfig, AgentConnection, FederatedMessage, AuthChallenge, ServerEvent, DashboardAgentStatus };
export { MAX_CONNECTED_AGENTS } from './types';
// Re-export sandbox & approval
export { SandboxFS } from './sandbox-fs';
export type { SandboxAction, SandboxActionType, SandboxFileInfo } from './sandbox-fs';
export { ApprovalManager } from './approval';
export type { ApprovalRequest, ApprovalMode } from './approval';
// Re-export new modules
export { InvitationManager } from './invitations';
export type { Invitation, InvitationStatus, CreateInvitationParams } from './invitations';
export { SessionManager } from './sessions';
export type { CollaborationSession, SessionStatus, SessionParticipant } from './sessions';
export { NotificationManager } from './notifications';
export type { Notification, NotificationType } from './notifications';
export { P2PManager } from './p2p';
export type { InviteCode, P2PMatch } from './p2p';
export { Agent, loadAgentConfig, loadOpenClawIdentity, buildSystemPrompt } from '../agent/agent';
export type { OpenClawIdentity } from '../agent/agent';
export { LLMClient, loadLLMConfig } from '../agent/llm';
// Swarm exports
export type { SwarmManager } from '../swarm/swarm-manager';
export type { SwarmMessage } from '../swarm/protocol';

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
  /** P2P bağlantı yöneticisi */
  private p2pManager: P2PManager;
  /** Dashboard WebSocket client'ları (clientId → ws) */
  private dashboardClients: Map<string, WebSocket> = new Map();
  /** Her client'ın agent'ı (clientId → Agent) */
  private clientAgents: Map<string, Agent> = new Map();
  /** Aktif konuşma döngüleri (clientId → abort flag) */
  private activeConversations: Map<string, { running: boolean }> = new Map();
  /** OpenClaw kimlik bilgileri (sunucu başlangıcında yüklenir) */
  private openclawIdentity: OpenClawIdentity | null = null;
  /** Sandbox dosya sistemi yöneticisi */
  private sandboxFS: SandboxFS;
  /** Onay kuyruğu yöneticisi */
  private approvalManager: ApprovalManager;
  /** Dashboard client bağlantı zamanları (clientId → connectedAt) */
  private clientConnectedAt: Map<string, Date> = new Map();
  /** Dashboard client son mesaj zamanları (clientId → lastMessageAt) */
  private clientLastMessageAt: Map<string, Date> = new Map();
  /** Dashboard client sandbox action sayıları (clientId → count) */
  private clientSandboxActionCount: Map<string, number> = new Map();
  /** Aktif sandbox session ID'leri (clientId → sessionId) */
  private clientSandboxSessions: Map<string, string> = new Map();
  /** Swarm manager (swarm mode'da set edilir) */
  private swarmManager: SwarmManager | null = null;

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

    // Initialize invitation, session, notification, p2p managers
    this.invitationManager = new InvitationManager();
    this.sessionManager = new SessionManager();
    this.notificationManager = new NotificationManager();
    this.p2pManager = new P2PManager();

    // Wire session end events to notifications
    this.sessionManager.onSessionEnd((session) => {
      this.notificationManager.notifySessionEnded(session);
    });

    // Initialize sandbox file system
    const sandboxBaseDir = path.resolve(process.cwd(), '.federation-sandbox');
    this.sandboxFS = new SandboxFS({ baseDir: sandboxBaseDir });

    // Initialize approval manager
    this.approvalManager = new ApprovalManager();

    // OpenClaw workspace'den agent kimliğini yükle
    this.openclawIdentity = loadOpenClawIdentity();
    if (this.openclawIdentity) {
      console.log(`[WS Server] OpenClaw identity loaded: ${this.openclawIdentity.name} ${this.openclawIdentity.emoji}`);
    }
  }

  /**
   * SwarmManager'ı bağlar.
   * Swarm event'lerini dashboard WebSocket'lere köprüler.
   */
  setSwarmManager(manager: SwarmManager): void {
    this.swarmManager = manager;

    // Swarm event'lerini dashboard client'lara ilet
    manager.on('peer_connected', (peer) => {
      this.broadcastToDashboard({
        type: 'swarm_peer_joined',
        agentName: peer.agentName,
        agentDid: peer.agentDid,
        peerCount: manager.peerCount,
        maxPeers: manager.maxPeers,
        sessionInfo: manager.getSessionInfo(),
      });
    });

    manager.on('peer_disconnected', (peerId: string, agentName: string) => {
      this.broadcastToDashboard({
        type: 'swarm_peer_left',
        peerId,
        agentName,
        peerCount: manager.peerCount,
        maxPeers: manager.maxPeers,
        sessionInfo: manager.getSessionInfo(),
      });
    });

    manager.on('session_created', (sessionKey: string) => {
      this.broadcastToDashboard({
        type: 'swarm_session_created',
        sessionKey,
        sessionInfo: manager.getSessionInfo(),
      });
    });

    manager.on('session_joined', (sessionKey: string) => {
      this.broadcastToDashboard({
        type: 'swarm_session_joined',
        sessionKey,
        sessionInfo: manager.getSessionInfo(),
      });
    });

    manager.on('session_closed', () => {
      this.broadcastToDashboard({
        type: 'swarm_session_closed',
      });
    });

    // Swarm'dan gelen mesajları dashboard'a ilet + local agent işle
    manager.on('message', (peerId: string, message: SwarmMessage) => {
      // Dashboard'a forward et (UI güncellemesi için)
      this.broadcastToDashboard({
        type: 'swarm_message',
        peerId,
        swarmMessage: message,
      });

      // agent_message gelirse local agent LLM ile yanıt üret ve swarm'a broadcast et
      if (message.type === 'agent_message') {
        this.handleIncomingSwarmAgentMessage(peerId, message).catch((err) => {
          console.error('[WS Server] Swarm agent message processing error:', err);
        });
      }
    });

    manager.on('error', (error: Error) => {
      this.broadcastToDashboard({
        type: 'swarm_error',
        message: error.message,
      });
    });
  }

  /**
   * Swarm'dan gelen agent_message'ı local agent ile işler ve yanıtı broadcast eder.
   *
   * Model: Her peer bağımsız — kendi LLM'i ile yanıt verir.
   * Aynı anda sadece bir local konuşma aktif olabilir (race prevention).
   */
  private async handleIncomingSwarmAgentMessage(_peerId: string, message: SwarmMessage): Promise<void> {
    if (!this.swarmManager) return;

    const payload = message.payload as { content?: string; role?: string; turn?: number; maxTurns?: number } | undefined;
    if (!payload?.content) return;

    // İlk (host) dashboard client'ı ve agent'ı al — swarm mode'da tek local agent konuşuyor
    const firstClientId = this.dashboardClients.keys().next().value;
    if (!firstClientId) return;

    const agent = this.clientAgents.get(firstClientId);
    if (!agent || !agent.isLLMConfigured) {
      console.warn('[WS Server] Swarm message received but local agent not configured');
      return;
    }

    // Aktif konuşma yoksa başlat — swarm mode için tek state
    let convState = this.activeConversations.get('__swarm__');
    if (!convState) {
      convState = { running: true };
      this.activeConversations.set('__swarm__', convState);
    }

    if (!convState.running) return;

    const maxTurns = agent.maxTurns;
    const turn = (payload.turn ?? 0) + 1;
    if (turn > maxTurns) {
      console.log(`[WS Server] Swarm conversation max turns reached (${maxTurns})`);
      convState.running = false;
      this.activeConversations.delete('__swarm__');
      this.swarmManager.broadcastPayload('agent_message', {
        content: '[Konuşma maksimum tura ulaştı]',
        role: 'peer',
        turn,
        maxTurns,
      });
      return;
    }

    try {
      // "Düşünüyor" bildirimi broadcast
      this.swarmManager.broadcastPayload('agent_thinking', {
        agentName: agent.name,
        turn,
      });

      // Local dashboard'a da gönder
      const clientWs = this.dashboardClients.get(firstClientId);
      if (clientWs) {
        this.sendDashboard(clientWs, {
          type: 'agent_thinking',
          agentName: agent.name,
          turn,
        });
      }

      // LLM streaming — her chunk'ı swarm'a broadcast et
      const response = await agent.processMessageStream(
        payload.content,
        (chunk: string) => {
          if (!convState!.running || !this.swarmManager) return;
          this.swarmManager.broadcastPayload('agent_stream_chunk', {
            agentName: agent.name,
            chunk,
            role: 'peer',
          });
          // Local dashboard'a da
          if (clientWs) {
            this.sendDashboard(clientWs, {
              type: 'agent_stream_chunk',
              agentName: agent.name,
              chunk,
              role: 'peer',
            });
          }
        },
        'peer',
      );

      if (!convState.running) return;

      // Tam yanıtı broadcast et
      this.swarmManager.broadcastPayload('agent_message', {
        content: response,
        role: 'peer',
        turn,
        maxTurns,
        stats: agent.getStats(),
      });

      // Local dashboard'a da
      if (clientWs) {
        this.sendDashboard(clientWs, {
          type: 'agent_message',
          agentName: agent.name,
          content: response,
          role: 'self',
          turn,
          maxTurns,
          stats: agent.getStats(),
        });
      }
    } catch (err) {
      console.error('[WS Server] Swarm LLM error:', err);
      convState.running = false;
      this.activeConversations.delete('__swarm__');
      this.broadcastToDashboard({
        type: 'conversation_error',
        error: err instanceof Error ? err.message : 'LLM hatası',
      });
    }
  }

  /**
   * Swarm mode'da konuşma başlatır.
   * Local agent'ın yanıtını üretir, swarm'a broadcast eder.
   * Sonraki turlar peer'ların yanıtlarıyla devam eder (handleIncomingSwarmAgentMessage).
   */
  private async startSwarmConversation(clientId: string, ws: WebSocket, task: string): Promise<void> {
    if (!this.swarmManager || !this.swarmManager.hasSession) {
      this.sendDashboard(ws, { type: 'error', message: 'Aktif swarm session yok.' });
      return;
    }

    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    if (!agent.isLLMConfigured) {
      this.sendDashboard(ws, { type: 'error', message: 'LLM API key yapılandırılmamış.' });
      return;
    }

    if (this.swarmManager.peerCount === 0) {
      this.sendDashboard(ws, { type: 'error', message: 'Bağlı peer yok. En az bir peer bağlanmalı.' });
      return;
    }

    // Aktif konuşma varsa durdur
    const existingConv = this.activeConversations.get('__swarm__');
    if (existingConv) existingConv.running = false;

    agent.reset();

    const convState = { running: true };
    this.activeConversations.set('__swarm__', convState);
    this.activeConversations.set(clientId, convState);

    // Konuşma başladı bildirimi — local + broadcast
    const startMsg = {
      type: 'conversation_started',
      task,
      maxTurns: agent.maxTurns,
    };
    this.sendDashboard(ws, startMsg);
    this.swarmManager.broadcastPayload('agent_thinking', {
      agentName: agent.name,
      turn: 1,
    });

    try {
      this.sendDashboard(ws, {
        type: 'agent_thinking',
        agentName: agent.name,
        turn: 1,
      });

      // LLM streaming — her chunk'ı swarm'a broadcast et
      const response = await agent.processMessageStream(
        task,
        (chunk: string) => {
          if (!convState.running || !this.swarmManager) return;
          this.swarmManager.broadcastPayload('agent_stream_chunk', {
            agentName: agent.name,
            chunk,
            role: 'host',
          });
          this.sendDashboard(ws, {
            type: 'agent_stream_chunk',
            agentName: agent.name,
            chunk,
            role: 'host',
          });
        },
        'user',
      );

      if (!convState.running) return;

      // Tam yanıtı broadcast et
      this.swarmManager.broadcastPayload('agent_message', {
        content: response,
        role: 'host',
        turn: 1,
        maxTurns: agent.maxTurns,
        stats: agent.getStats(),
      });

      this.sendDashboard(ws, {
        type: 'agent_message',
        agentName: agent.name,
        content: response,
        role: 'host',
        turn: 1,
        maxTurns: agent.maxTurns,
        stats: agent.getStats(),
      });
    } catch (err) {
      convState.running = false;
      this.activeConversations.delete('__swarm__');
      this.activeConversations.delete(clientId);
      this.sendDashboard(ws, {
        type: 'conversation_error',
        error: err instanceof Error ? err.message : 'LLM hatası',
      });
    }
  }

  /**
   * SwarmManager instance'ını döner.
   */
  getSwarmManager(): SwarmManager | null {
    return this.swarmManager;
  }

  /**
   * Tüm dashboard client'lara mesaj gönderir.
   */
  private broadcastToDashboard(data: Record<string, unknown>): void {
    for (const [, ws] of this.dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendDashboard(ws, data);
      }
    }
  }

  /**
   * Yüklenen OpenClaw kimliğini döner.
   */
  getOpenClawIdentity(): OpenClawIdentity | null {
    return this.openclawIdentity;
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
   * P2P manager instance'ını döner.
   */
  getP2PManager(): P2PManager {
    return this.p2pManager;
  }

  /**
   * UI klasörü yolunu çözümler.
   * Proje kökündeki ui/ dizinini arar.
   *
   * Birden fazla stratejiyi dener (ESM ve CJS uyumluluğu için):
   * 1. process.cwd()/ui — sunucu proje kökünden başlatıldığında (en yaygın)
   * 2. __dirname tabanlı — TypeScript src/server/ws-server.ts → proje kökü
   * 3. Derlenmiş dist dosyası için — dist/server/ws-server.js → proje kökü
   *
   * dashboard.html içeren ilk dizini döndürür.
   */
  private resolveUiPath(): string {
    const candidates: string[] = [];

    // Strategy 1: process.cwd() (en yaygın — npm scripts, tsx, ts-node)
    candidates.push(path.resolve(process.cwd(), 'ui'));

    // Strategy 2: __dirname tabanlı (CJS veya tsx shim — ESM'de de tsx sağlar)
    try {
      if (typeof __dirname === 'string' && __dirname.length > 0) {
        candidates.push(path.resolve(__dirname, '..', '..', 'ui'));
      }
    } catch {
      // ESM ortamında __dirname ReferenceError atabilir — yoksay
    }

    // Strategy 3: Test ortamı veya başka bir dizin için — en az 3 üst dizine kadar tara
    let walkPath = process.cwd();
    for (let i = 0; i < 3; i++) {
      const parent = path.dirname(walkPath);
      if (parent === walkPath) break;
      walkPath = parent;
      candidates.push(path.resolve(walkPath, 'ui'));
    }

    // dashboard.html içeren ilk adayı döndür
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(candidate, 'dashboard.html'))) {
          return candidate;
        }
      } catch {
        // ignore, devam et
      }
    }

    // Hiçbiri bulunamadı — ilk adayı döndür (fallback HTML tetiklenecek)
    return candidates[0] ?? path.resolve(process.cwd(), 'ui');
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

    // / → ui/dashboard.html (yeni dashboard)
    if (parsedPath === '/' || parsedPath === '/index.html') {
      const dashboardPath = path.join(uiDir, 'dashboard.html');
      fs.access(dashboardPath, fs.constants.R_OK, (err) => {
        if (!err) {
          this.serveStaticFile(res, dashboardPath, uiDir);
        } else {
          // Fallback: basit bilgi sayfası
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
      <p>Dashboard dosyası bulunamadı. <code>ui/dashboard.html</code> oluşturun.</p>
    </div>
  </div>
</body>
</html>`);
        }
      });
      return;
    }

    // /dashboard.js → ui/dashboard.js serve et
    if (parsedPath === '/dashboard.js') {
      const jsPath = path.join(uiDir, 'dashboard.js');
      this.serveStaticFile(res, jsPath, uiDir);
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
          this.p2pManager.startCleanup();
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
   * Dashboard WebSocket bağlantısını işler.
   * P2P davet kodu, agent mesajları ve konuşma kontrolü bu kanaldan yapılır.
   */
  private handleDashboardConnection(ws: WebSocket): void {
    // Max agent limiti kontrolü
    if (this.dashboardClients.size >= MAX_CONNECTED_AGENTS) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'MAX_AGENTS_REACHED',
        message: 'Maximum 7 agents can be connected simultaneously',
      }));
      ws.close(4007, 'Maximum agents reached');
      return;
    }

    const clientId = crypto.randomUUID();
    this.dashboardClients.set(clientId, ws);
    this.clientConnectedAt.set(clientId, new Date());
    this.clientLastMessageAt.set(clientId, new Date());
    this.clientSandboxActionCount.set(clientId, 0);

    // Varsayılan agent oluştur
    const agentConfig = loadAgentConfig();
    const agent = new Agent(agentConfig);
    this.clientAgents.set(clientId, agent);

    console.log(`[WS Server] Dashboard client connected: ${clientId}`);

    // OpenClaw workspace'inden LLM ayarlarını otomatik yükle
    const llmAuto = getOpenClawAutoConfig();
    const llmCfg = loadLLMConfig();
    if (llmAuto.hasApiKey && llmAuto.baseUrl && llmAuto.model) {
      agent.updateLLMConfig({
        baseUrl: llmCfg.baseUrl,
        apiKey: llmCfg.apiKey,
        model: llmCfg.model,
      });
    }

    // Client'a hoşgeldin mesajı (OpenClaw kimlik bilgileri + LLM otomatik config + agent sayacı + swarm bilgisi)
    this.sendDashboard(ws, {
      type: 'welcome',
      clientId,
      agentName: agent.name,
      agentSystemPrompt: agent.systemPrompt,
      connectedAgents: this.dashboardClients.size,
      maxAgents: MAX_CONNECTED_AGENTS,
      openclawConfigured: agent.isOpenClawConfigured,
      openclawIdentity: this.openclawIdentity ? {
        name: this.openclawIdentity.name,
        emoji: this.openclawIdentity.emoji,
        creature: this.openclawIdentity.creature,
        vibe: this.openclawIdentity.vibe,
      } : null,
      llmAutoConfig: {
        baseUrl: llmCfg.baseUrl,
        model: llmCfg.model,
        providerName: llmAuto.providerName,
        configured: agent.isLLMConfigured,
        source: llmAuto.hasApiKey ? 'openclaw' : (process.env['AGENT_LLM_API_KEY'] ? 'env' : 'manual'),
      },
      llmDiagnostic: (() => {
        const d = diagnoseLLMConfig();
        return {
          hasApiKey: d.hasApiKey,
          apiKeySource: d.apiKeySource,
          openclawProvider: d.openclawProvider,
          baseUrl: d.baseUrl,
          model: d.model,
          warnings: d.warnings,
          hints: d.hints,
        };
      })(),
      swarmEnabled: this.swarmManager !== null,
      swarmSessionInfo: this.swarmManager?.getSessionInfo() ?? null,
    });

    ws.on('message', (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleDashboardMessage(clientId, ws, message);
      } catch (error) {
        console.error('[WS Server] Dashboard message parse error:', error);
        this.sendDashboard(ws, { type: 'error', message: 'Geçersiz mesaj formatı' });
      }
    });

    ws.on('close', () => {
      console.log(`[WS Server] Dashboard client disconnected: ${clientId}`);
      // Aktif konuşmayı durdur
      const conv = this.activeConversations.get(clientId);
      if (conv) conv.running = false;
      this.activeConversations.delete(clientId);

      // P2P eşleşmesini temizle ve karşı tarafa bildir
      const match = this.p2pManager.disconnectClient(clientId);
      if (match) {
        const peerId = match.hostClientId === clientId ? match.guestClientId : match.hostClientId;
        const peerWs = this.dashboardClients.get(peerId);
        if (peerWs && peerWs.readyState === WebSocket.OPEN) {
          this.sendDashboard(peerWs, {
            type: 'connection_status',
            status: 'disconnected',
            message: 'Karşı taraf bağlantıyı kesti',
          });
        }
      }

      this.dashboardClients.delete(clientId);
      this.clientAgents.delete(clientId);
      this.clientConnectedAt.delete(clientId);
      this.clientLastMessageAt.delete(clientId);
      this.clientSandboxActionCount.delete(clientId);

      // Sandbox session temizle
      const sandboxSessionId = this.clientSandboxSessions.get(clientId);
      if (sandboxSessionId) {
        this.approvalManager.cleanupSession(sandboxSessionId);
        this.clientSandboxSessions.delete(clientId);
      }

      // Bağlı agent sayısını güncelle — diğer dashboard client'lara bildir
      this.broadcastAgentCount();
    });

    ws.on('error', (error) => {
      console.error(`[WS Server] Dashboard client error (${clientId}):`, error);
    });
  }

  /**
   * Dashboard client'tan gelen mesajı işler.
   */
  private handleDashboardMessage(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const msgType = message['type'] as string;

    switch (msgType) {
      case 'create_invitation':
        this.handleCreateInvitation(clientId, ws, message);
        break;
      case 'join_invitation':
        this.handleJoinInvitation(clientId, ws, message);
        break;
      case 'start_conversation':
        this.handleStartConversation(clientId, ws, message);
        break;
      case 'stop_conversation':
        this.handleStopConversation(clientId, ws);
        break;
      case 'update_agent':
        this.handleUpdateAgent(clientId, ws, message);
        break;
      case 'update_llm':
        this.handleUpdateLLM(clientId, ws, message);
        break;
      case 'end_session':
        this.handleEndSession(clientId, ws);
        break;
      case 'sandbox_action':
        this.handleSandboxAction(clientId, ws, message);
        break;
      case 'sandbox_approval_response':
        this.handleSandboxApprovalResponse(clientId, ws, message);
        break;
      case 'set_approval_mode':
        this.handleSetApprovalMode(clientId, ws, message);
        break;
      case 'get_sandbox_files':
        this.handleGetSandboxFiles(clientId, ws, message);
        break;
      case 'get_agent_statuses':
        this.handleGetAgentStatuses(ws);
        break;
      // ─── Swarm Message Handlers ─────────────────────────────────────
      case 'swarm_create_session':
        this.handleSwarmCreateSession(clientId, ws);
        break;
      case 'swarm_join_session':
        this.handleSwarmJoinSession(clientId, ws, message);
        break;
      case 'swarm_leave_session':
        this.handleSwarmLeaveSession(clientId, ws);
        break;
      case 'swarm_get_session_info':
        this.handleSwarmGetSessionInfo(ws);
        break;
      case 'swarm_broadcast':
        this.handleSwarmBroadcast(clientId, ws, message);
        break;
      default:
        this.sendDashboard(ws, { type: 'error', message: `Bilinmeyen mesaj tipi: ${msgType}` });
    }

    // Son mesaj zamanını güncelle
    this.clientLastMessageAt.set(clientId, new Date());
  }

  /**
   * Davet kodu oluşturma.
   */
  private handleCreateInvitation(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const agent = this.clientAgents.get(clientId);
    const agentName = (message['agentName'] as string) || agent?.name || 'Agent';

    try {
      const invite = this.p2pManager.createInvitation(clientId, agentName);
      this.sendDashboard(ws, {
        type: 'invitation_created',
        code: invite.code,
        expiresAt: invite.expiresAt.toISOString(),
      });
      console.log(`[WS Server] Invite code created: ${invite.code} by ${clientId}`);
    } catch (error) {
      this.sendDashboard(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Davet oluşturulamadı',
      });
    }
  }

  /**
   * Davete katılma.
   */
  private handleJoinInvitation(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const code = message['code'] as string;
    const agent = this.clientAgents.get(clientId);
    const agentName = (message['agentName'] as string) || agent?.name || 'Agent';

    if (!code) {
      this.sendDashboard(ws, { type: 'error', message: 'Davet kodu gerekli' });
      return;
    }

    // Debug log: gelen kod ve mevcut aktif davetler
    const activeInvites = this.p2pManager.getActiveCodes();
    const codeHex = Array.from(code).map(c => c.charCodeAt(0).toString(16)).join(' ');
    console.log(`[P2P] join_invitation received: code="${code}" (len=${code.length}, hex=${codeHex}) | active: [${activeInvites.join(', ')}]`);

    try {
      const match = this.p2pManager.joinInvitation(code, clientId, agentName);

      // Her iki tarafa da bağlantı bildirimi gönder
      const hostWs = this.dashboardClients.get(match.hostClientId);
      const guestWs = this.dashboardClients.get(match.guestClientId);

      if (hostWs && hostWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(hostWs, {
          type: 'connection_status',
          status: 'connected',
          peerAgentName: match.guestAgentName,
          role: 'host',
          message: `${match.guestAgentName} bağlandı!`,
        });
      }

      if (guestWs && guestWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(guestWs, {
          type: 'connection_status',
          status: 'connected',
          peerAgentName: match.hostAgentName,
          role: 'guest',
          message: `${match.hostAgentName} ile bağlantı kuruldu!`,
        });
      }

      console.log(`[WS Server] P2P match: ${match.hostAgentName} <-> ${match.guestAgentName}`);
    } catch (error) {
      this.sendDashboard(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Davete katılınamadı',
      });
    }
  }

  /**
   * Konuşma başlatma — kullanıcı ilk görevi verir, agent döngüsü başlar.
   * Swarm mode aktifse swarm path'e yönlendirir.
   */
  private handleStartConversation(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const task = message['task'] as string;
    if (!task) {
      this.sendDashboard(ws, { type: 'error', message: 'Görev metni gerekli' });
      return;
    }

    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    // OpenClaw agent kontrolü — asıl agent kimliği OpenClaw workspace'inden geliyor
    if (!agent.isOpenClawConfigured) {
      this.sendDashboard(ws, {
        type: 'error',
        message: 'OpenClaw agent yapılandırılmamış. ~/.openclaw/workspace altında IDENTITY.md ve SOUL.md dosyaları bulunmalı veya OPENCLAW_WORKSPACE env var\'ını ayarlayın.',
      });
      return;
    }

    // Swarm mode aktifse swarm path'i kullan
    if (this.swarmManager && this.swarmManager.hasSession) {
      this.startSwarmConversation(clientId, ws, task).catch((err) => {
        console.error('[WS Server] Swarm conversation error:', err);
        this.sendDashboard(ws, {
          type: 'conversation_error',
          error: err instanceof Error ? err.message : 'Swarm konuşma hatası',
        });
      });
      return;
    }

    // Legacy P2P path — eşleşme var mı?
    const peerId = this.p2pManager.getPeerId(clientId);
    if (!peerId) {
      this.sendDashboard(ws, { type: 'error', message: 'Henüz bir eşleşme yok. Önce bağlantı kurun.' });
      return;
    }

    const peerWs = this.dashboardClients.get(peerId);
    const peerAgent = this.clientAgents.get(peerId);

    if (!peerWs || peerWs.readyState !== WebSocket.OPEN || !peerAgent) {
      this.sendDashboard(ws, { type: 'error', message: 'Karşı taraf bağlı değil.' });
      return;
    }

    if (!peerAgent.isOpenClawConfigured) {
      this.sendDashboard(ws, {
        type: 'error',
        message: 'Karşı tarafın OpenClaw agent\'ı yapılandırılmamış. Karşı tarafın ~/.openclaw/workspace altında IDENTITY.md + SOUL.md dosyaları olmalı.',
      });
      return;
    }

    // Aktif konuşma varsa durdur
    const existingConv = this.activeConversations.get(clientId);
    if (existingConv) existingConv.running = false;
    const existingPeerConv = this.activeConversations.get(peerId);
    if (existingPeerConv) existingPeerConv.running = false;

    // Agent'ları sıfırla
    agent.reset();
    peerAgent.reset();

    // Konuşma döngüsünü başlat
    const conversationState = { running: true };
    this.activeConversations.set(clientId, conversationState);
    this.activeConversations.set(peerId, conversationState);

    // Her iki tarafa konuşma başladı bildirimi
    const startMsg = {
      type: 'conversation_started',
      task,
      maxTurns: agent.maxTurns,
    };
    this.sendDashboard(ws, startMsg);
    this.sendDashboard(peerWs, startMsg);

    // Async konuşma döngüsü
    this.runConversationLoop(clientId, peerId, task, conversationState).catch((error) => {
      const errMsg = error instanceof Error ? error.message : 'Konuşma hatası';
      console.error(`[WS Server] Conversation error:`, error);
      const ws1 = this.dashboardClients.get(clientId);
      const ws2 = this.dashboardClients.get(peerId);
      if (ws1) this.sendDashboard(ws1, { type: 'conversation_error', error: errMsg });
      if (ws2) this.sendDashboard(ws2, { type: 'conversation_error', error: errMsg });
    });
  }

  /**
   * Agent'lar arası konuşma döngüsü.
   * Host agent ilk mesajı üretir, sonra sırayla karşılıklı devam eder.
   */
  private async runConversationLoop(
    hostClientId: string,
    guestClientId: string,
    task: string,
    state: { running: boolean }
  ): Promise<void> {
    const hostAgent = this.clientAgents.get(hostClientId);
    const guestAgent = this.clientAgents.get(guestClientId);

    if (!hostAgent || !guestAgent) return;

    const maxTurns = Math.min(hostAgent.maxTurns, guestAgent.maxTurns);
    let currentMessage = task;
    let currentSender: 'host' | 'guest' = 'host';
    let turn = 0;

    while (state.running && turn < maxTurns) {
      const senderAgent = currentSender === 'host' ? hostAgent : guestAgent;
      const senderClientId = currentSender === 'host' ? hostClientId : guestClientId;
      const receiverClientId = currentSender === 'host' ? guestClientId : hostClientId;
      const fromRole = turn === 0 ? 'user' as const : 'peer' as const;

      // Gönderen tarafın dashboard'unda "düşünüyor" bildirimi
      const senderWs = this.dashboardClients.get(senderClientId);
      const receiverWs = this.dashboardClients.get(receiverClientId);

      if (senderWs) {
        this.sendDashboard(senderWs, {
          type: 'agent_thinking',
          agentName: senderAgent.name,
          turn: turn + 1,
        });
      }
      if (receiverWs) {
        this.sendDashboard(receiverWs, {
          type: 'agent_thinking',
          agentName: senderAgent.name,
          turn: turn + 1,
        });
      }

      // LLM çağrısı — streaming
      let fullResponse = '';
      try {
        fullResponse = await senderAgent.processMessageStream(
          currentMessage,
          (chunk: string) => {
            if (!state.running) return;
            // Streaming chunk'larını her iki tarafa da gönder
            const chunkMsg = {
              type: 'agent_stream_chunk',
              agentName: senderAgent.name,
              chunk,
              role: currentSender,
            };
            if (senderWs && senderWs.readyState === WebSocket.OPEN) {
              this.sendDashboard(senderWs, chunkMsg);
            }
            if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
              this.sendDashboard(receiverWs, chunkMsg);
            }
          },
          fromRole
        );
      } catch (error) {
        if (!state.running) return;
        throw error;
      }

      if (!state.running) return;

      turn++;

      // Tam mesajı her iki tarafa gönder
      const agentMsg = {
        type: 'agent_message',
        agentName: senderAgent.name,
        content: fullResponse,
        role: currentSender,
        turn,
        maxTurns,
        stats: senderAgent.getStats(),
      };

      if (senderWs && senderWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(senderWs, agentMsg);
      }
      if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(receiverWs, agentMsg);
      }

      // Sonraki tur için hazırlık
      currentMessage = fullResponse;
      currentSender = currentSender === 'host' ? 'guest' : 'host';
    }

    // Konuşma bitti
    state.running = false;
    this.activeConversations.delete(hostClientId);
    this.activeConversations.delete(guestClientId);

    const endMsg = {
      type: 'conversation_ended',
      reason: turn >= maxTurns ? 'max_turns_reached' : 'stopped',
      totalTurns: turn,
      hostStats: hostAgent.getStats(),
      guestStats: guestAgent.getStats(),
    };

    const ws1 = this.dashboardClients.get(hostClientId);
    const ws2 = this.dashboardClients.get(guestClientId);
    if (ws1) this.sendDashboard(ws1, endMsg);
    if (ws2) this.sendDashboard(ws2, endMsg);
  }

  /**
   * Konuşmayı durdurma.
   * Hem legacy P2P hem de swarm mode'da çalışır.
   */
  private handleStopConversation(clientId: string, ws: WebSocket): void {
    const conv = this.activeConversations.get(clientId);
    const swarmConv = this.activeConversations.get('__swarm__');

    if (conv) conv.running = false;
    if (swarmConv) swarmConv.running = false;

    if (conv || swarmConv) {
      this.sendDashboard(ws, { type: 'conversation_stopping' });
      // Swarm mode'da tüm peer'lara durdurma bildirimi
      if (swarmConv && this.swarmManager?.hasSession) {
        this.swarmManager.broadcastPayload('agent_message', {
          content: '[Konuşma durduruldu]',
          role: 'peer',
          turn: 0,
          maxTurns: 0,
        });
      }
    } else {
      this.sendDashboard(ws, { type: 'error', message: 'Aktif konuşma yok' });
    }
  }

  /**
   * Agent ayarlarını güncelleme.
   */
  private handleUpdateAgent(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    if (typeof message['name'] === 'string') {
      agent.setName(message['name']);
    }
    if (typeof message['systemPrompt'] === 'string') {
      agent.setSystemPrompt(message['systemPrompt']);
    }

    this.sendDashboard(ws, {
      type: 'agent_updated',
      name: agent.name,
      systemPrompt: agent.systemPrompt,
    });

    // P2P eşleşmesi varsa karşı tarafa da bildir
    const peerId = this.p2pManager.getPeerId(clientId);
    if (peerId) {
      const peerWs = this.dashboardClients.get(peerId);
      if (peerWs && peerWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(peerWs, {
          type: 'peer_agent_updated',
          name: agent.name,
        });
      }
    }
  }

  /**
   * LLM ayarlarını güncelleme.
   */
  private handleUpdateLLM(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    const updates: Partial<LLMConfig> = {};
    if (typeof message['baseUrl'] === 'string') updates.baseUrl = message['baseUrl'];
    if (typeof message['apiKey'] === 'string') updates.apiKey = message['apiKey'];
    if (typeof message['model'] === 'string') updates.model = message['model'];

    agent.updateLLMConfig(updates);

    this.sendDashboard(ws, {
      type: 'llm_updated',
      configured: agent.isLLMConfigured,
    });
  }

  /**
   * Oturumu sonlandırma — P2P bağlantısını kopar.
   */
  private handleEndSession(clientId: string, ws: WebSocket): void {
    // Konuşmayı durdur
    const conv = this.activeConversations.get(clientId);
    if (conv) conv.running = false;

    // P2P bağlantısını temizle
    const match = this.p2pManager.disconnectClient(clientId);

    if (match) {
      const peerId = match.hostClientId === clientId ? match.guestClientId : match.hostClientId;
      const peerConv = this.activeConversations.get(peerId);
      if (peerConv) peerConv.running = false;

      const peerWs = this.dashboardClients.get(peerId);
      if (peerWs && peerWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(peerWs, {
          type: 'connection_status',
          status: 'disconnected',
          message: 'Karşı taraf oturumu sonlandırdı',
        });
      }
    }

    // Agent'ı sıfırla
    const agent = this.clientAgents.get(clientId);
    if (agent) agent.reset();

    this.sendDashboard(ws, {
      type: 'session_ended_ack',
      message: 'Oturum sonlandırıldı',
    });
  }

  // ─── Swarm Handlers ──────────────────────────────────────────────────────

  /**
   * Dashboard'dan swarm session oluşturma isteği.
   */
  private handleSwarmCreateSession(_clientId: string, ws: WebSocket): void {
    if (!this.swarmManager) {
      this.sendDashboard(ws, { type: 'error', message: 'Swarm mode aktif degil. Server\'i swarm modunda baslatin.' });
      return;
    }

    try {
      if (this.swarmManager.hasSession) {
        this.sendDashboard(ws, { type: 'error', message: 'Zaten bir session acik. Once mevcut session\'i kapatin.' });
        return;
      }

      const { sessionKey } = this.swarmManager.createSession();
      this.sendDashboard(ws, {
        type: 'swarm_session_created',
        sessionKey,
        sessionInfo: this.swarmManager.getSessionInfo(),
      });
    } catch (error) {
      this.sendDashboard(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Session olusturulamadi',
      });
    }
  }

  /**
   * Dashboard'dan swarm session'a katılma isteği.
   */
  private handleSwarmJoinSession(_clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    if (!this.swarmManager) {
      this.sendDashboard(ws, { type: 'error', message: 'Swarm mode aktif degil.' });
      return;
    }

    const sessionKey = message['sessionKey'] as string;
    if (!sessionKey) {
      this.sendDashboard(ws, { type: 'error', message: 'Session key gerekli.' });
      return;
    }

    try {
      if (this.swarmManager.hasSession) {
        this.sendDashboard(ws, { type: 'error', message: 'Zaten bir session acik. Once mevcut session\'i kapatin.' });
        return;
      }

      this.swarmManager.joinSession(sessionKey);
      this.sendDashboard(ws, {
        type: 'swarm_session_joined',
        sessionKey,
        sessionInfo: this.swarmManager.getSessionInfo(),
      });
    } catch (error) {
      this.sendDashboard(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Session\'a katilinamadi',
      });
    }
  }

  /**
   * Dashboard'dan swarm session'dan ayrılma isteği.
   */
  private handleSwarmLeaveSession(_clientId: string, ws: WebSocket): void {
    if (!this.swarmManager) {
      this.sendDashboard(ws, { type: 'error', message: 'Swarm mode aktif degil.' });
      return;
    }

    try {
      this.swarmManager.leaveSession();
      this.sendDashboard(ws, { type: 'swarm_session_closed' });
    } catch (error) {
      this.sendDashboard(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Session kapatilamadi',
      });
    }
  }

  /**
   * Dashboard'a swarm session bilgisi gönderir.
   */
  private handleSwarmGetSessionInfo(ws: WebSocket): void {
    if (!this.swarmManager) {
      this.sendDashboard(ws, {
        type: 'swarm_session_info',
        swarmEnabled: false,
        sessionInfo: null,
      });
      return;
    }

    this.sendDashboard(ws, {
      type: 'swarm_session_info',
      swarmEnabled: true,
      sessionInfo: this.swarmManager.getSessionInfo(),
    });
  }

  /**
   * Dashboard'dan swarm broadcast isteği.
   * Dashboard üzerinden gönderilen mesajları swarm ağına yayar.
   */
  private handleSwarmBroadcast(_clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    if (!this.swarmManager) {
      this.sendDashboard(ws, { type: 'error', message: 'Swarm mode aktif degil.' });
      return;
    }

    if (!this.swarmManager.hasSession) {
      this.sendDashboard(ws, { type: 'error', message: 'Aktif session yok.' });
      return;
    }

    const swarmMessage = message['swarmMessage'] as Record<string, unknown> | undefined;
    if (!swarmMessage) {
      this.sendDashboard(ws, { type: 'error', message: 'swarmMessage gerekli.' });
      return;
    }

    const swarmType = (swarmMessage['type'] as import('../swarm/protocol').SwarmMessageType | undefined) ?? 'agent_message';
    this.swarmManager.broadcastPayload(
      swarmType,
      swarmMessage['payload'] ?? swarmMessage,
    );
  }

  // ─── Sandbox & Approval Handlers ─────────────────────────────────────────

  /**
   * Sandbox dosya işlemi isteğini işler.
   * Agent bir dosya oluşturma/düzenleme/silme vb. isteği gönderdiğinde çağrılır.
   */
  private handleSandboxAction(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    const action = message['action'] as string;
    const filePath = message['path'] as string;
    const content = message['content'] as string | undefined;
    const oldContent = message['old_content'] as string | undefined;
    const newContent = message['new_content'] as string | undefined;
    const fullContent = message['full_content'] as string | undefined;

    if (!action) {
      this.sendDashboard(ws, { type: 'error', message: 'sandbox_action: action gerekli' });
      return;
    }

    // Session sandbox'ını oluştur (yoksa)
    let sandboxSessionId = this.clientSandboxSessions.get(clientId);
    if (!sandboxSessionId) {
      sandboxSessionId = crypto.randomUUID();
      this.clientSandboxSessions.set(clientId, sandboxSessionId);
      this.sandboxFS.initSession(sandboxSessionId);
    }

    // Edit payload oluştur
    let editPayload: { oldContent: string; newContent: string } | { fullContent: string } | undefined;
    if (action === 'file_edit') {
      if (fullContent !== undefined) {
        editPayload = { fullContent };
      } else if (oldContent !== undefined && newContent !== undefined) {
        editPayload = { oldContent, newContent };
      }
    }

    // Onay isteği oluştur
    const [approvalRequest, needsHumanApproval] = this.approvalManager.createRequest(
      sandboxSessionId,
      agent.name,
      action as 'file_create' | 'file_edit' | 'file_delete' | 'file_read' | 'file_list' | 'dir_create',
      filePath || '.',
      content,
      oldContent,
      editPayload,
    );

    if (!needsHumanApproval) {
      // Otomatik onay — hemen uygula
      const result = this.executeSandboxAction(sandboxSessionId, agent.name, approvalRequest);
      this.sendDashboard(ws, {
        type: 'sandbox_action_result',
        action_id: approvalRequest.id,
        success: result.success,
        data: result.data,
        error: result.error,
      });

      // İşlem logunu tüm dashboard client'lara bildir
      this.broadcastSandboxLog(sandboxSessionId, approvalRequest, result.success);
    } else {
      // İnsan onayı gerekiyor — P2P eşleşmedeki karşı tarafa (ve kendisine) bildirim gönder
      const peerId = this.p2pManager.getPeerId(clientId);
      const approvalMsg = {
        type: 'sandbox_approval_request',
        action_id: approvalRequest.id,
        agent: agent.name,
        action: approvalRequest.action,
        path: approvalRequest.filePath,
        content: approvalRequest.content,
        old_content: approvalRequest.oldContent,
        risk_score: approvalRequest.riskScore,
        preview: this.generatePreview(approvalRequest),
      };

      // Her iki tarafa da gönder
      this.sendDashboard(ws, approvalMsg);
      if (peerId) {
        const peerWs = this.dashboardClients.get(peerId);
        if (peerWs && peerWs.readyState === WebSocket.OPEN) {
          this.sendDashboard(peerWs, approvalMsg);
        }
      }

      // Async: onay bekle ve sonucu ilet
      this.approvalManager.waitForApproval(approvalRequest.id).then((approved) => {
        if (approved) {
          const result = this.executeSandboxAction(sandboxSessionId, agent.name, approvalRequest);
          this.sendDashboard(ws, {
            type: 'sandbox_action_result',
            action_id: approvalRequest.id,
            success: result.success,
            data: result.data,
            error: result.error,
          });
          this.broadcastSandboxLog(sandboxSessionId, approvalRequest, result.success);
        } else {
          this.sendDashboard(ws, {
            type: 'sandbox_action_result',
            action_id: approvalRequest.id,
            success: false,
            error: 'Action rejected by human operator',
          });
        }
      }).catch(() => {
        // Ignore — timeout veya cleanup
      });
    }

    // Sandbox action count güncelle
    const count = (this.clientSandboxActionCount.get(clientId) ?? 0) + 1;
    this.clientSandboxActionCount.set(clientId, count);
  }

  /**
   * Sandbox onay yanıtını işler.
   * İnsan dashboard'dan "Onayla" veya "Reddet" tıkladığında çağrılır.
   */
  private handleSandboxApprovalResponse(_clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const actionId = message['action_id'] as string;
    const approved = message['approved'] as boolean;

    if (!actionId || typeof approved !== 'boolean') {
      this.sendDashboard(ws, { type: 'error', message: 'action_id ve approved gerekli' });
      return;
    }

    try {
      const request = this.approvalManager.resolveRequest(actionId, approved, 'human');

      // Sonucu tüm dashboard client'lara bildir
      const resultMsg = {
        type: 'sandbox_approval_resolved',
        action_id: actionId,
        approved,
        agent: request.agentName,
        action: request.action,
        path: request.filePath,
      };

      for (const [, clientWs] of this.dashboardClients) {
        if (clientWs.readyState === WebSocket.OPEN) {
          this.sendDashboard(clientWs, resultMsg);
        }
      }
    } catch (err) {
      this.sendDashboard(ws, {
        type: 'error',
        message: err instanceof Error ? err.message : 'Onay işlemi başarısız',
      });
    }
  }

  /**
   * Onay modunu değiştirir (manual ↔ allow_all).
   */
  private handleSetApprovalMode(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const mode = message['mode'] as string;
    if (mode !== 'manual' && mode !== 'allow_all') {
      this.sendDashboard(ws, { type: 'error', message: 'Geçersiz mod. "manual" veya "allow_all" olmalı.' });
      return;
    }

    const sandboxSessionId = this.clientSandboxSessions.get(clientId);
    if (sandboxSessionId) {
      this.approvalManager.setMode(sandboxSessionId, mode as ApprovalMode);
    }

    // Tüm dashboard client'lara bildir
    for (const [, clientWs] of this.dashboardClients) {
      if (clientWs.readyState === WebSocket.OPEN) {
        this.sendDashboard(clientWs, {
          type: 'approval_mode_changed',
          mode,
        });
      }
    }
  }

  /**
   * Sandbox dosya listesi isteğini işler.
   */
  private handleGetSandboxFiles(clientId: string, ws: WebSocket, message: Record<string, unknown>): void {
    const agent = this.clientAgents.get(clientId);
    if (!agent) {
      this.sendDashboard(ws, { type: 'error', message: 'Agent bulunamadı' });
      return;
    }

    const sandboxSessionId = this.clientSandboxSessions.get(clientId);
    if (!sandboxSessionId) {
      this.sendDashboard(ws, { type: 'sandbox_files', files: [], logs: [] });
      return;
    }

    const dirPath = (message['path'] as string) || '';
    const result = this.sandboxFS.fileList(sandboxSessionId, agent.name, dirPath);
    const logs = this.sandboxFS.getActionLog(sandboxSessionId);

    this.sendDashboard(ws, {
      type: 'sandbox_files',
      files: result.files ?? [],
      logs: logs.map(l => ({
        id: l.id,
        agentName: l.agentName,
        action: l.action,
        filePath: l.filePath,
        timestamp: l.timestamp.toISOString(),
        success: l.success,
        approvalStatus: l.approvalStatus,
        error: l.error,
      })),
    });
  }

  /**
   * Tüm bağlı agent'ların durumunu döner.
   */
  private handleGetAgentStatuses(ws: WebSocket): void {
    const statuses: DashboardAgentStatus[] = [];

    for (const [cId, cWs] of this.dashboardClients) {
      const agent = this.clientAgents.get(cId);
      statuses.push({
        clientId: cId,
        agentName: agent?.name ?? 'Unknown',
        online: cWs.readyState === WebSocket.OPEN,
        connectedAt: this.clientConnectedAt.get(cId) ?? new Date(),
        lastMessageAt: this.clientLastMessageAt.get(cId) ?? new Date(),
        sandboxActionCount: this.clientSandboxActionCount.get(cId) ?? 0,
      });
    }

    this.sendDashboard(ws, {
      type: 'agent_statuses',
      agents: statuses.map(s => ({
        ...s,
        connectedAt: s.connectedAt.toISOString(),
        lastMessageAt: s.lastMessageAt.toISOString(),
      })),
      connectedCount: this.dashboardClients.size,
      maxAgents: MAX_CONNECTED_AGENTS,
    });
  }

  /**
   * Sandbox işlemini gerçekten uygular.
   */
  private executeSandboxAction(
    sessionId: string,
    agentName: string,
    request: ApprovalRequest
  ): { success: boolean; data?: Record<string, unknown>; error?: string } {
    switch (request.action) {
      case 'file_create':
        {
          const result = this.sandboxFS.fileCreate(sessionId, agentName, request.filePath, request.content ?? '');
          return { success: result.success, error: result.error };
        }
      case 'file_edit':
        {
          if (request.editPayload) {
            const result = this.sandboxFS.fileEdit(sessionId, agentName, request.filePath, request.editPayload);
            return { success: result.success, error: result.error };
          }
          return { success: false, error: 'Edit payload missing' };
        }
      case 'file_delete':
        {
          const result = this.sandboxFS.fileDelete(sessionId, agentName, request.filePath);
          return { success: result.success, error: result.error };
        }
      case 'file_read':
        {
          const result = this.sandboxFS.fileRead(sessionId, agentName, request.filePath);
          return {
            success: result.success,
            data: result.fileContent !== undefined ? { content: result.fileContent } : undefined,
            error: result.error,
          };
        }
      case 'file_list':
        {
          const result = this.sandboxFS.fileList(sessionId, agentName, request.filePath);
          return {
            success: result.success,
            data: result.files ? { files: result.files } : undefined,
            error: result.error,
          };
        }
      case 'dir_create':
        {
          const result = this.sandboxFS.dirCreate(sessionId, agentName, request.filePath);
          return { success: result.success, error: result.error };
        }
      default:
        return { success: false, error: `Unknown action: ${request.action}` };
    }
  }

  /**
   * Sandbox işlem logunu tüm ilgili dashboard client'lara bildirir.
   */
  private broadcastSandboxLog(sessionId: string, request: ApprovalRequest, success: boolean): void {
    const logMsg = {
      type: 'sandbox_log_entry',
      sessionId,
      action_id: request.id,
      agent: request.agentName,
      action: request.action,
      path: request.filePath,
      success,
      risk_score: request.riskScore,
      approval_status: request.status,
      timestamp: new Date().toISOString(),
    };

    for (const [, ws] of this.dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendDashboard(ws, logMsg);
      }
    }
  }

  /**
   * Bağlı agent sayısını tüm dashboard client'lara bildirir.
   */
  private broadcastAgentCount(): void {
    const msg = {
      type: 'agent_count_updated',
      connectedAgents: this.dashboardClients.size,
      maxAgents: MAX_CONNECTED_AGENTS,
    };
    for (const [, ws] of this.dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendDashboard(ws, msg);
      }
    }
  }

  /**
   * Onay kartı için değişiklik önizlemesi üretir.
   */
  private generatePreview(request: ApprovalRequest): string {
    if (request.action === 'file_delete') {
      return `Dosya silinecek: ${request.filePath}`;
    }
    if (request.action === 'dir_create') {
      return `Klasör oluşturulacak: ${request.filePath}`;
    }
    if (request.content) {
      const lines = request.content.split('\n');
      if (lines.length > 10) {
        return lines.slice(0, 10).join('\n') + `\n... (+${lines.length - 10} satır)`;
      }
      return request.content;
    }
    return '';
  }

  // ─── Getters for new modules ───────────────────────────────────────────────

  /**
   * SandboxFS instance'ını döner.
   */
  getSandboxFS(): SandboxFS {
    return this.sandboxFS;
  }

  /**
   * ApprovalManager instance'ını döner.
   */
  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  /**
   * Bağlı dashboard client sayısını döner.
   */
  getDashboardClientCount(): number {
    return this.dashboardClients.size;
  }

  /**
   * Dashboard client'a JSON mesaj gönderir.
   */
  private sendDashboard(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Server'ı durdurur.
   */
  stop(): void {
    this.stopHeartbeat();
    this.invitationManager.stopCleanup();
    this.sessionManager.stopCleanup();
    this.sessionManager.endAll();
    this.p2pManager.stopCleanup();

    // Tüm bağlantıları kapat
    for (const conn of this.connections.values()) {
      conn.ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
    this.pendingAuth.clear();

    // Dashboard client'ları kapat
    for (const [id, ws] of this.dashboardClients.entries()) {
      const conv = this.activeConversations.get(id);
      if (conv) conv.running = false;

      // Sandbox session temizle
      const sandboxSessionId = this.clientSandboxSessions.get(id);
      if (sandboxSessionId) {
        this.approvalManager.cleanupSession(sandboxSessionId);
      }

      ws.close(1000, 'Server shutting down');
    }
    this.dashboardClients.clear();
    this.clientAgents.clear();
    this.activeConversations.clear();
    this.clientConnectedAt.clear();
    this.clientLastMessageAt.clear();
    this.clientSandboxActionCount.clear();
    this.clientSandboxSessions.clear();

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
   * URL path'e göre dashboard client veya agent bağlantısı olarak yönlendirir.
   */
  private handleConnection(ws: WebSocket, req: Record<string, unknown>): void {
    const url = req.url as string | undefined;
    const clientId = url?.split('?')[0] || 'unknown';
    console.log(`[WS Server] New connection from ${clientId}`);

    // Dashboard client'ları /dashboard path'inden bağlanır
    if (url?.startsWith('/dashboard')) {
      this.handleDashboardConnection(ws);
      return;
    }

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
