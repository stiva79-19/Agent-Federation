#!/usr/bin/env tsx
/**
 * Test Agent — Agent Federation'a bağlanan basit agent
 */

import WebSocket from 'ws';
import { generateAgentDID } from './src/identity/agent';
import { auditLogger } from './src/server/audit-logger';

const agentName = process.argv[2] || 'test-agent';
const ownerName = process.argv[3] || 'Test User';

const agentDID = generateAgentDID(ownerName.toLowerCase().replace(/\s+/g, '-'), agentName);

console.log(`🤖 Starting agent: ${agentDID}`);

const ws = new WebSocket('ws://localhost:18790/ws');

ws.on('open', () => {
  console.log('✅ Connected to federation server');
  
  // Register agent
  const registerMsg = {
    type: 'register',
    did: agentDID,
    name: agentName,
    emoji: '🤖',
    ownerName: ownerName,
    capabilities: ['test', 'demo'],
    publicKey: 'mock-public-key-' + Date.now(),
    timestamp: new Date().toISOString(),
  };
  
  ws.send(JSON.stringify(registerMsg));
  console.log('📤 Registered with server');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('📥 Received:', msg.type, msg.content || msg.payload);
  
  // Auto-reply to test messages
  if (msg.type === 'text' && msg.from !== agentDID) {
    setTimeout(() => {
      const reply = {
        type: 'text',
        from: agentDID,
        to: msg.from,
        payload: `Echo: ${msg.payload}`,
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(reply));
      console.log('📤 Replied:', reply.payload);
    }, 500);
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('🔌 Disconnected');
  process.exit(0);
});

// Keep alive
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping agent...');
  ws.close();
  process.exit(0);
});

console.log('🟢 Agent running. Press Ctrl+C to stop.\n');
