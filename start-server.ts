#!/usr/bin/env tsx
/**
 * Agent Federation WebSocket Server Starter
 *
 * Iki modda calisir:
 *
 * 1. HOSTED MODE (varsayilan):
 *    - Local dashboard'u acar (http://localhost:18790)
 *    - Fly.io relay sunucusuna WebSocket ile baglanir
 *    - Davet kodu relay uzerinden olusturulur/katilir
 *    - Mesajlar relay sunucusu uzerinden akar
 *    - LLM cagirilari LOCAL kalir (API key paylasilmaz)
 *
 * 2. LOCAL MODE (--mode local):
 *    - Eski P2P davranis — dogrudan IP ile baglanti
 *    - Relay sunucusu kullanilmaz
 *
 * Kullanim:
 *   npx tsx start-server.ts                           # Hosted mode (varsayilan)
 *   npx tsx start-server.ts --mode local              # Self-hosted P2P mode
 *   npx tsx start-server.ts --relay wss://my-relay.com  # Custom relay sunucusu
 */

import { WebSocketServerManager, defaultServerConfig } from './src/server/ws-server';
import { RelayClient, defaultRelayUrl } from './src/client/relay-client';
import { loadOpenClawIdentity } from './src/agent/agent';
import { loadLLMConfig } from './src/agent/llm';
import { auditLogger } from './src/server/audit-logger';

// ─── CLI Argumanlari Parse ──────────────────────────────────────────────────

type ConnectionMode = 'hosted' | 'local';

interface StartupArgs {
  mode: ConnectionMode;
  relayUrl: string;
}

function parseArgs(): StartupArgs {
  const args = process.argv.slice(2);
  let mode: ConnectionMode = 'hosted';
  let relayUrl = defaultRelayUrl();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode' && args[i + 1]) {
      const val = args[i + 1].toLowerCase();
      if (val === 'local' || val === 'p2p' || val === 'self-hosted') {
        mode = 'local';
      } else if (val === 'hosted' || val === 'relay' || val === 'global') {
        mode = 'hosted';
      }
      i++;
    } else if (arg === '--relay' && args[i + 1]) {
      relayUrl = args[i + 1];
      mode = 'hosted'; // --relay implies hosted mode
      i++;
    }
  }

  // Env var override
  const envMode = process.env['CONNECTION_MODE'];
  if (envMode === 'local' || envMode === 'p2p') {
    mode = 'local';
  }
  const envRelay = process.env['RELAY_URL'];
  if (envRelay) {
    relayUrl = envRelay;
  }

  return { mode, relayUrl };
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

console.log(`🚀 Starting Agent Federation Server...`);
console.log(`   Mode: ${startupArgs.mode === 'hosted' ? '🌐 Hosted (Relay)' : '🏠 Local (P2P)'}`);
console.log(`   Port: ${config.port}`);
console.log(`   Host: ${config.host}`);
console.log(`   SSL: ${config.ssl}`);
console.log(`   LLM: ${llmConfig.model} (${llmConfig.baseUrl})`);
if (startupArgs.mode === 'hosted') {
  console.log(`   Relay: ${startupArgs.relayUrl}`);
}
if (identity) {
  console.log(`   Agent: ${identity.name} ${identity.emoji} — ${identity.creature}`);
  console.log(`   OpenClaw: workspace yuklendi`);
} else {
  console.log(`   Agent: ${process.env['AGENT_NAME'] || 'MrClaw'}`);
  console.log(`   OpenClaw: workspace bulunamadi (varsayilan ayarlar kullaniliyor)`);
}

const server = new WebSocketServerManager(config);

// Relay client (hosted mode icin)
let relayClient: RelayClient | null = null;

server.start()
  .then(() => {
    console.log(`✅ Server running!`);
    console.log(`   Dashboard: http://localhost:${config.port}`);
    console.log(`   Health:    http://localhost:${config.port}/health`);
    console.log(`   WebSocket: ws://localhost:${config.port}/dashboard`);

    if (startupArgs.mode === 'hosted') {
      console.log('');
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

    if (startupArgs.mode === 'hosted') {
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
  server.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
