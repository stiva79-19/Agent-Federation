#!/usr/bin/env tsx
/**
 * Agent Federation — Live Demo Test
 * 2 gerçek agent oluşturup birbirleriyle konuşturur.
 */

import { Transport, FederatedMessage } from './src/transport/websocket';
import { generateAgentDID, createInvitation } from './src/identity/agent';
import { auditLogger } from './src/server/audit-logger';

console.log('🧪 Agent Federation Live Test\n');

// Agent 1: Mr Claw (Ali'nin agent'ı)
const agent1DID = generateAgentDID('ali', 'mr-claw');
console.log(`🦀 Agent 1 (Mr Claw): ${agent1DID}`);

// Agent 2: Owl (Zeynep'in agent'ı - mock)
const agent2DID = generateAgentDID('zeynep', 'owl');
console.log(`🦉 Agent 2 (Owl): ${agent2DID}\n`);

// Invitation oluştur (İnsan kullanıcı oluşturur)
const invitation = createInvitation(
  'Ali', // ownerName
  'zeynep:owl', // toIdentifier
  'Proje işbirliği', // purpose
  '/tmp/sandbox', // sandboxPath
  ['read', 'write', 'execute'], // permissions
  24 // durationHours
);
console.log(`📨 Invitation created: ${invitation.id}`);
console.log(`   From: ${invitation.fromDid}`);
console.log(`   To: ${invitation.toIdentifier}`);
console.log(`   Permissions: ${invitation.permissions.join(', ')}`);
console.log(`   Expires: ${invitation.expiresAt.toISOString()}\n`);

// Transport bağlantıları
const transport1 = new Transport({
  tailscaleEnabled: false,
  port: 18790,
  ssl: false,
});

const transport2 = new Transport({
  tailscaleEnabled: false,
  port: 18790,
  ssl: false,
});

// Mesaj dinleyicileri
transport1.on('message', (msg: FederatedMessage) => {
  const content = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
  console.log(`🦀 ← Aldı: "${content}" (from: ${msg.from})`);
});

transport2.on('message', (msg: FederatedMessage) => {
  const content = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
  console.log(`🦉 ← Aldı: "${content}" (from: ${msg.from})`);
});

// Test akışı
async function runTest() {
  console.log('🔌 Bağlanıyor...\n');
  
  try {
    await transport1.connect();
    console.log('✅ Mr Claw connected');
    
    await transport2.connect();
    console.log('✅ Owl connected\n');
    
    // Daveti gönder
    console.log('📨 Mr Claw → Owl: Davet gönderiliyor...');
    await transport1.send({
      to: agent2DID,
      type: 'invitation',
      payload: invitation,
    });
    console.log('✅ Davet iletildi\n');
    
    // Mesajlaşma testi
    console.log('💬 Mesajlaşma testi:\n');
    
    await new Promise(r => setTimeout(r, 500));
    await transport1.send({
      to: agent2DID,
      type: 'text',
      payload: 'Merhaba Owl! Proje durumu nedir?',
    });
    
    await new Promise(r => setTimeout(r, 500));
    await transport2.send({
      to: agent1DID,
      type: 'text',
      payload: 'Merhaba Mr Claw! Araştırma tamamlandı, 3 bulgu var.',
    });
    
    await new Promise(r => setTimeout(r, 500));
    await transport1.send({
      to: agent2DID,
      type: 'text',
      payload: 'Harika! Raporu paylaşır mısın?',
    });
    
    await new Promise(r => setTimeout(r, 500));
    await transport2.send({
      to: agent1DID,
      type: 'text',
      payload: 'Tabii, PDF hazırlıyorum. 5 dakika içinde gönderirim.',
    });
    
    console.log('\n✅ Test tamamlandı!\n');
    
    // Audit log
    auditLogger.log({
      eventType: 'demo_test_completed',
      details: {
        agent1: agent1DID,
        agent2: agent2DID,
        messagesExchanged: 4,
      },
      severity: 'low',
    });
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Bağlantıları kapat
    await transport1.disconnect();
    await transport2.disconnect();
    console.log('🔌 Bağlantılar kapatıldı.\n');
    process.exit(0);
  }
}

runTest();
