# WebSocket Server Documentation

## Overview

Merkezi WebSocket server untuk Agent Federation ağı. Agent'lar arası güvenli mesajlaşma, routing ve bağlantı yönetimi sağlar.

## Özellikler

### ✅ Tamamlanan Özellikler

1. **WebSocket Server (Port 18790)**
   - `src/server/ws-server.ts` dosyasında implement edildi
   - Port 18790'da dinler
   - `ws` paketi kullanıldı
   - **SSL/TLS varsayılan olarak aktif** (production için zorunlu)

2. **Agent Bağlantı Yönetimi**
   - Connect/disconnect eventleri
   - Connection tracking (DID bazlı)
   - Connection istatistikleri (sent/received counts)
   - Stale connection detection (5 dakika idle)

3. **Mesaj Routing**
   - Peer'dan peer'a direkt mesajlaşma
   - Broadcast desteği (`to: 'broadcast'` veya `to: '*'`)
   - Message delivery status tracking
   - TTL (Time-To-Live) kontrolü

4. **Heartbeat Desteği**
   - 30 saniyede bir otomatik heartbeat
   - Server → tüm connected agent'lar
   - Ping-pong keepalive mekanizması

5. **Connection Authentication**
   - DID (Decentralized Identifier) doğrulama
   - Auth challenge-response flow
   - Nonce-based authentication
   - Signature verification (placeholder - production'da cryptographic)
   - Auth timeout (10 saniye)

6. **Güvenlik**
   - Message injection defense (scanMessage entegrasyonu)
   - DID format validation
   - TTL expiration check
   - Signature verification
   - **SSL/TLS encryption** (varsayılan: aktif, WSS protocol)

## Kullanım

### Server Başlatma

```typescript
import { WebSocketServerManager, defaultServerConfig } from './src/server/ws-server';

// Varsayılan config: SSL/TLS aktif (production-safe)
const server = new WebSocketServerManager(defaultServerConfig());

await server.start();
console.log('Server started on port 18790 with SSL/TLS enabled');
```

### SSL/TLS Yapılandırması

```typescript
import * as fs from 'fs';

const server = new WebSocketServerManager({
  port: 18790,
  host: '0.0.0.0',
  ssl: true, // Varsayılan: true
  certPath: '/path/to/cert.pem',
  keyPath: '/path/to/key.pem',
});

await server.start();
```

> **⚠️ Önemli:** `ssl: false` kullanımı deprecated. Production ortamlarında SSL/TLS zorunludur.

// Event listeners
server.on('agent_connected', (connection) => {
  console.log(`Agent connected: ${connection.did}`);
});

server.on('agent_disconnected', (data) => {
  console.log(`Agent disconnected: ${data.did}`);
});

server.on('message', (message) => {
  console.log(`Message received: ${message.id}`);
});

server.on('heartbeat', (heartbeat) => {
  console.log(`Heartbeat: ${heartbeat.payload}`);
});
```

### Server Durdurma

```typescript
server.stop();
```

### Bağlantı Bilgileri

```typescript
// Tüm bağlantıları listele
const connections = server.getConnections();

// Bağlantı sayısını al
const count = server.getConnectionCount();

// Belirli bir DID'ye ait bağlantıyı bul
const conn = server.getConnectionByDid('did:claw:ali:mrclaw');

// Server istatistikleri
const stats = server.getStats();
// {
//   totalConnections: number,
//   uptime: number,
//   connections: Array<{did, connectedAt, sentCount, receivedCount}>
// }
```

## Mesaj Formatı

```typescript
interface FederatedMessage {
  id: string;                    // Unique message ID
  from: string;                  // Gönderen DID
  to: string;                    // Alıcı DID veya 'broadcast'
  type: 'text' | 'file' | 'invitation' | 'consent_request' | 'consent_response' | 'heartbeat';
  payload: unknown;              // Mesaj içeriği
  signature?: string;            // İmza
  timestamp: Date;               // Oluşturulma zamanı
  ttlSeconds: number;            // TTL (saniye)
}
```

## Auth Flow

```
1. Client → Server: WebSocket connection
2. Server → Client: auth_challenge { challengeId, nonce }
3. Client → Server: auth_response { did, signature, identity }
4. Server: DID format check + signature verify
5. Server → Client: auth_success veya auth_error
```

## Event Types

| Event | Description |
|-------|-------------|
| `agent_connected` | Yeni agent bağlandığında |
| `agent_disconnected` | Agent bağlantısı koptuğunda |
| `message` | Mesaj alındığında |
| `message_routed` | Mesaj yönlendirildiğinde |
| `heartbeat` | Heartbeat gönderildiğinde |
| `error` | Hata oluştuğunda |

## Test

```bash
# Server testlerini çalıştır
npm test -- tests/server.test.ts

# Tüm testleri çalıştır
npm test -- run
```

### Test Coverage

- ✅ Server start/stop
- ✅ Connection management
- ✅ Message routing
- ✅ Heartbeat
- ✅ Server stats
- ✅ Auth challenge structure
- ✅ DID validation
- ✅ Message structure
- ✅ Connection lifecycle
- ✅ Server configuration
- ✅ SSL/TLS default enabled

## TODO (Production)

- [ ] Cryptographic signature verification (currently placeholder)
- [ ] Offline message queue
- [ ] Rate limiting
- [ ] Connection persistence
- [ ] Metrics/monitoring integration
- [ ] Graceful shutdown handling
- [ ] Connection recovery/retry logic

## İlgili Dosyalar

- `src/server/ws-server.ts` - Server implementation
- `src/transport/websocket.ts` - Client implementation
- `tests/server.test.ts` - Server tests
- `src/identity/agent.ts` - DID generation/validation
- `src/protocol/injection-defense.ts` - Message security
