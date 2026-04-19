#!/usr/bin/env tsx
/**
 * @deprecated Bu dosya artik onerilmiyor. Bunun yerine Hyperswarm tabanli
 * swarm mode kullanin: npx tsx start-server.ts (varsayilan swarm mode).
 *
 * Agent Federation — Relay Server Entry Point
 *
 * Fly.io'da calistirilan minimal relay sunucusu.
 * Sadece mesaj relay yapar — LLM cagrisi YAPMAZ, dashboard SUNMAZ.
 *
 * Kullanim:
 *   npx tsx relay-server.ts
 *
 * Ortam degiskenleri:
 *   PORT              — Dinlenecek port (varsayilan: 8080, Fly.io otomatik atar)
 *   HOST              — Host (varsayilan: 0.0.0.0)
 *   RELAY_MAX_ROOMS   — Maksimum esanli room sayisi (varsayilan: 100)
 *   RELAY_ROOM_TTL_HOURS — Room gecerlilik suresi saat (varsayilan: 24)
 */

import { RelayServer, defaultRelayConfig } from './src/server/relay';

const config = defaultRelayConfig();

console.log(`🔄 Starting Agent Federation Relay Server...`);
console.log(`   Port: ${config.port}`);
console.log(`   Host: ${config.host}`);
console.log(`   Max Rooms: ${config.maxRooms}`);
console.log(`   Room TTL: ${config.roomTTLHours}h`);
console.log(`   Max Participants/Room: ${config.maxParticipantsPerRoom}`);

const relay = new RelayServer(config);

relay.start()
  .then(() => {
    console.log(`✅ Relay server running!`);
    console.log(`   Health: http://localhost:${config.port}/health`);
    console.log(`   Stats:  http://localhost:${config.port}/stats`);
    console.log('');
    console.log('📡 Relay modu — sadece mesaj iletimi.');
    console.log('   LLM cagrisi yapilmaz, API key gerekmez.');
    console.log('   Kullanicilar kendi bilgisayarlarinda LLM calistirir.');
  })
  .catch((err) => {
    console.error('❌ Relay server failed to start:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down relay...');
  relay.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down relay...');
  relay.stop();
  process.exit(0);
});
