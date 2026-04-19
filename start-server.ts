#!/usr/bin/env tsx
/**
 * Agent Federation WebSocket Server Starter
 */

import { WebSocketServerManager, defaultServerConfig } from './src/server/ws-server';
import { auditLogger } from './src/server/audit-logger';

const config = defaultServerConfig();
config.ssl = false; // Development mode - no SSL

console.log(`🚀 Starting Agent Federation WebSocket Server...`);
console.log(`   Port: ${config.port}`);
console.log(`   Host: ${config.host}`);
console.log(`   SSL: ${config.ssl}`);

const server = new WebSocketServerManager(config);

server.start()
  .then(() => {
    console.log(`✅ Server running on ws://${config.host}:${config.port}`);
    auditLogger.log({
      eventType: 'server_started',
      details: { port: config.port, host: config.host },
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
