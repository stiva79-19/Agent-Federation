#!/usr/bin/env tsx
/**
 * Agent Federation WebSocket Server Starter
 *
 * Sunucuyu başlatır:
 * - HTTP: Dashboard UI serve eder (http://localhost:18790)
 * - WebSocket: Agent bağlantıları ve dashboard client'ları
 * - P2P: Davet kodu ile eşleştirme
 * - LLM: OpenClaw Gateway üzerinden AI konuşması
 */

import { WebSocketServerManager, defaultServerConfig } from './src/server/ws-server';
import { loadOpenClawIdentity } from './src/agent/agent';
import { loadLLMConfig } from './src/agent/llm';
import { auditLogger } from './src/server/audit-logger';

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

// OpenClaw bilgilerini göster
const identity = loadOpenClawIdentity();
const llmConfig = loadLLMConfig();

console.log(`🚀 Starting Agent Federation Server...`);
console.log(`   Port: ${config.port}`);
console.log(`   Host: ${config.host}`);
console.log(`   SSL: ${config.ssl}`);
console.log(`   LLM: ${llmConfig.model} (${llmConfig.baseUrl})`);
if (identity) {
  console.log(`   Agent: ${identity.name} ${identity.emoji} — ${identity.creature}`);
  console.log(`   OpenClaw: workspace yüklendi`);
} else {
  console.log(`   Agent: ${process.env['AGENT_NAME'] || 'MrClaw'}`);
  console.log(`   OpenClaw: workspace bulunamadı (varsayılan ayarlar kullanılıyor)`);
}

const server = new WebSocketServerManager(config);

server.start()
  .then(() => {
    console.log(`✅ Server running!`);
    console.log(`   Dashboard: http://localhost:${config.port}`);
    console.log(`   Health:    http://localhost:${config.port}/health`);
    console.log(`   WebSocket: ws://localhost:${config.port}/dashboard`);
    console.log('');
    console.log('📋 Kullanım:');
    console.log('   1. Tarayıcıda http://localhost:' + config.port + " adresini açın");
    console.log('   2. OpenClaw Gateway çalışıyorsa LLM otomatik yapılandırılır');
    console.log('   3. "Davet Oluştur" ile kod alın veya karşı tarafın kodunu girin');
    console.log('   4. Bağlantı kurulunca agent\'ınıza görev verin');
    console.log('');

    auditLogger.log({
      eventType: 'server_started',
      details: {
        port: config.port,
        host: config.host,
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
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  server.stop();
  process.exit(0);
});
