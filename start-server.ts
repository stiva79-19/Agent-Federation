#!/usr/bin/env tsx
/**
 * Agent Federation WebSocket Server Starter
 *
 * Uc modda calisir:
 *
 * 1. SWARM MODE (varsayilan):
 *    - Hyperswarm DHT uzerinden torrent-style P2P
 *    - Merkezi sunucu yok — NAT traversal otomatik
 *    - Session key (32 byte hex) paylasilir
 *    - IP adresi paylasmaniza gerek yok!
 *
 * 2. LOCAL MODE (--mode local):
 *    - Eski P2P davranis — dogrudan IP ile baglanti
 *    - Relay/swarm kullanilmaz
 *
 * 3. HOSTED MODE (--mode hosted) [DEPRECATED]:
 *    - Fly.io/Render relay sunucusu uzerinden baglanti
 *    - Artik swarm mode onerilir
 *
 * Kullanim:
 *   npx tsx start-server.ts                           # Swarm mode (varsayilan)
 *   npx tsx start-server.ts --create-session          # Session olustur, key'i yazdir
 *   npx tsx start-server.ts --join <session-key>      # Session'a katil
 *   npx tsx start-server.ts --mode local              # Self-hosted P2P mode
 *   npx tsx start-server.ts --mode hosted             # [DEPRECATED] Relay mode
 *   npx tsx start-server.ts --relay wss://my-relay.com  # [DEPRECATED] Custom relay
 */

import { WebSocketServerManager, defaultServerConfig } from './src/server/ws-server';
import { RelayClient, defaultRelayUrl } from './src/client/relay-client';
import { SwarmManager, defaultSwarmConfig } from './src/swarm/swarm-manager';
import { loadOpenClawIdentity } from './src/agent/agent';
import { loadLLMConfig, diagnoseLLMConfig } from './src/agent/llm';
import { auditLogger } from './src/server/audit-logger';

// ─── CLI Argumanlari Parse ──────────────────────────────────────────────────

type ConnectionMode = 'swarm' | 'hosted' | 'local';

interface StartupArgs {
  mode: ConnectionMode;
  relayUrl: string;
  createSession: boolean;
  joinSessionKey: string | null;
}

function parseArgs(): StartupArgs {
  const args = process.argv.slice(2);
  let mode: ConnectionMode = 'swarm';
  let relayUrl = defaultRelayUrl();
  let createSession = false;
  let joinSessionKey: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode' && args[i + 1]) {
      const val = args[i + 1].toLowerCase();
      if (val === 'local' || val === 'p2p' || val === 'self-hosted') {
        mode = 'local';
      } else if (val === 'hosted' || val === 'relay' || val === 'global') {
        mode = 'hosted';
      } else if (val === 'swarm' || val === 'torrent' || val === 'dht') {
        mode = 'swarm';
      }
      i++;
    } else if (arg === '--relay' && args[i + 1]) {
      relayUrl = args[i + 1];
      mode = 'hosted'; // --relay implies hosted mode
      i++;
    } else if (arg === '--create-session') {
      createSession = true;
      mode = 'swarm';
    } else if (arg === '--join' && args[i + 1]) {
      joinSessionKey = args[i + 1];
      mode = 'swarm';
      i++;
    }
  }

  // Env var override
  const envMode = process.env['CONNECTION_MODE'];
  if (envMode === 'local' || envMode === 'p2p') {
    mode = 'local';
  } else if (envMode === 'hosted' || envMode === 'relay') {
    mode = 'hosted';
  } else if (envMode === 'swarm' || envMode === 'torrent') {
    mode = 'swarm';
  }
  const envRelay = process.env['RELAY_URL'];
  if (envRelay && mode === 'hosted') {
    relayUrl = envRelay;
  }

  return { mode, relayUrl, createSession, joinSessionKey };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const startupArgs = parseArgs();

const config = defaultServerConfig();
config.ssl = false; // Development mode - no SSL

// Env var'lardan port override
const envPort = process.env['PORT'];
if (envPort) {
  config.port = parseInt(envPort, 10);
}
const envHost = process.env['HOST'];
if (envHost) {
  config.host = envHost;
}

// OpenClaw bilgilerini goster
const identity = loadOpenClawIdentity();
const llmConfig = loadLLMConfig();

const modeLabels: Record<ConnectionMode, string> = {
  swarm: '🐝 Swarm (DHT P2P)',
  hosted: '🌐 Hosted (Relay) [DEPRECATED]',
  local: '🏠 Local (P2P)',
};

console.log(`🚀 Starting Agent Federation Server...`);
console.log(`   Mode: ${modeLabels[startupArgs.mode]}`);
console.log(`   Port: ${config.port}`);
console.log(`   Host: ${config.host}`);
console.log(`   SSL: ${config.ssl}`);
console.log(`   LLM: ${llmConfig.model} (${llmConfig.baseUrl})`);
if (startupArgs.mode === 'hosted') {
  console.log(`   Relay: ${startupArgs.relayUrl}`);
  console.warn('   ⚠️  Hosted/relay mode is DEPRECATED. Use swarm mode instead (default).');
}
if (identity) {
  console.log(`   Agent: ${identity.name} ${identity.emoji} — ${identity.creature}`);
  console.log(`   OpenClaw: workspace yuklendi`);
} else {
  console.log(`   Agent: ${process.env['AGENT_NAME'] || 'MrClaw'}`);
  console.log(`   OpenClaw: workspace bulunamadi (varsayilan ayarlar kullaniliyor)`);
}

// ─── LLM config tanisi — erken uyari ─────────────────────────────────────
// Konusma baslatincaya kadar beklemeden, kullaniciya simdi soyle
const llmDiag = diagnoseLLMConfig();
if (llmDiag.warnings.length > 0) {
  console.log('');
  console.log('⚠️  LLM yapilandirma uyarisi:');
  for (const w of llmDiag.warnings) console.log(`   ${w}`);
  if (llmDiag.hints.length > 0) {
    console.log('   Nasil duzeltirim:');
    for (const h of llmDiag.hints) console.log(`     → ${h}`);
  }
  console.log('');
  console.log('   Server yine de baslatiliyor. Konusma baslatmak icin key gerekli.');
}

const server = new WebSocketServerManager(config);

// Relay client (hosted mode icin — deprecated)
let relayClient: RelayClient | null = null;

// Swarm manager (swarm mode icin)
let swarmManager: SwarmManager | null = null;

server.start()
  .then(() => {
    console.log(`✅ Server running!`);
    console.log(`   Dashboard: http://localhost:${config.port}`);
    console.log(`   Health:    http://localhost:${config.port}/health`);
    console.log(`   WebSocket: ws://localhost:${config.port}/dashboard`);

    if (startupArgs.mode === 'swarm') {
      console.log('');
      console.log('🐝 Swarm mode — Hyperswarm DHT ile P2P baglanti');

      const swarmConfig = defaultSwarmConfig();
      if (identity) {
        swarmConfig.agentName = identity.name;
        swarmConfig.agentDid = `did:claw:${identity.name.toLowerCase()}`;
      }

      swarmManager = new SwarmManager(swarmConfig);

      // Swarm event'lerini loglama
      swarmManager.on('peer_connected', (peer) => {
        console.log(`   ✅ Peer baglandi: ${peer.agentName} (${peer.agentDid})`);
      });

      swarmManager.on('peer_disconnected', (peerId: string, agentName: string) => {
        console.log(`   ❌ Peer ayrildi: ${agentName} [${peerId}]`);
      });

      swarmManager.on('error', (error: Error) => {
        console.error(`   ❌ Swarm hatasi: ${error.message}`);
      });

      // Swarm manager'ı server'a bağla (ws-server bridge)
      server.setSwarmManager(swarmManager);

      // CLI'dan session oluştur/katıl
      if (startupArgs.createSession) {
        const { sessionKey } = swarmManager.createSession();
        console.log('');
        console.log('🔑 Session Key (bunu paylasin):');
        console.log(`   ${sessionKey}`);
        console.log('');
        console.log('   Katilmak icin: npx tsx start-server.ts --join ' + sessionKey);
      } else if (startupArgs.joinSessionKey) {
        swarmManager.joinSession(startupArgs.joinSessionKey);
        console.log(`   🔗 Session'a katiliniyor: ${startupArgs.joinSessionKey.slice(0, 16)}...`);
      } else {
        console.log('');
        console.log('   Dashboard\'dan "Session Olustur" veya "Session\'a Katil" butonunu kullanin.');
        console.log('   Veya CLI: --create-session / --join <key>');
      }
    } else if (startupArgs.mode === 'hosted') {
      console.log('');
      console.warn('⚠️  DEPRECATED: Hosted/relay mode artik onerilmiyor.');
      console.log('🌐 Hosted mode — Relay sunucusuna baglaniyor...');

      relayClient = new RelayClient({
        relayUrl: startupArgs.relayUrl,
        agentName: identity?.name ?? process.env['AGENT_NAME'] ?? 'MrClaw',
        agentDid: identity ? `did:claw:${identity.name.toLowerCase()}` : undefined,
      });

      relayClient.on('connected', (token: string) => {
        console.log(`   ✅ Relay baglantisi kuruldu (token: ${token.slice(0, 8)}...)`);
      });

      relayClient.on('disconnected', (reason: string) => {
        console.log(`   ⚠️  Relay baglantisi kesildi: ${reason}`);
      });

      relayClient.on('reconnecting', (attempt: number, max: number) => {
        console.log(`   🔄 Relay yeniden baglaniyor (${attempt}/${max})...`);
      });

      relayClient.on('error', (code: string, message: string) => {
        console.error(`   ❌ Relay hatasi: [${code}] ${message}`);
      });

      relayClient.connect();
    }

    console.log('');
    console.log('📋 Kullanim:');
    console.log('   1. Tarayicida http://localhost:' + config.port + ' adresini acin');
    console.log('   2. OpenClaw Gateway calisiyorsa LLM otomatik yapilandirilir');

    if (startupArgs.mode === 'swarm') {
      console.log('   3. "Session Olustur" ile torrent key alin');
      console.log('   4. Key\'i paylasın — IP adresi paylasmaniza gerek yok!');
      console.log('   5. Karsi taraf "Session\'a Katil" ile key\'i girer');
    } else if (startupArgs.mode === 'hosted') {
      console.log('   3. "Davet Olustur" ile relay uzerinden kod alin');
      console.log('   4. Kodu paylasın — IP adresi paylasmaniza gerek yok!');
    } else {
      console.log('   3. "Davet Olustur" ile P2P kod alin veya karsi tarafin kodunu girin');
      console.log('   4. Baglanti kurulunca agent\'iniza gorev verin');
    }
    console.log('');

    auditLogger.log({
      eventType: 'server_started',
      details: {
        port: config.port,
        host: config.host,
        mode: startupArgs.mode,
        relayUrl: startupArgs.mode === 'hosted' ? startupArgs.relayUrl : null,
        swarmEnabled: startupArgs.mode === 'swarm',
        openclawIdentity: identity?.name ?? null,
        llmBaseUrl: llmConfig.baseUrl,
        llmModel: llmConfig.model,
      },
      severity: 'low',
    });
  })
  .catch((err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

// Graceful shutdown
function shutdown(): void {
  console.log('\n🛑 Shutting down...');
  if (relayClient) {
    relayClient.disconnect();
  }
  if (swarmManager) {
    swarmManager.destroy().catch(() => {});
  }
  server.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
