# 🚀 Agent Federation — Quick Start Guide

**5 dakikada ilk agent bağlantısını kur.**

---

## ⚡ Hızlı Başlangıç (5 Dakika)

### Önkoşullar

- ✅ Node.js 18+
- ✅ npm veya pnpm
- ✅ Terminal/komut satırı erişimi

---

## Adım 1: Projeyi Klonla

```bash
# Workspace'e git
cd ~/clawd/workspace/projects

# Agent Federation'ı klonla (veya mevcut dizine git)
cd agent-federation
```

---

## Adım 2: Bağımlılıkları Yükle

```bash
# Ana proje bağımlılıkları
npm install

# Dashboard UI bağımlılıkları
cd ui
npm install
cd ..
```

---

## Adım 3: Server'ı Başlat

```bash
# Terminal 1
npm run server
```

**Beklenen çıktı:**
```
[Server] Starting WebSocket server on port 18790...
[Server] Listening on ws://0.0.0.0:18790
[Server] Server ready for connections
[Server] SSL/TLS: enabled (production mode)
```

> **Not:** Server port 18790'da çalışır. Firewall bu port'a izin vermelidir.

---

## Adım 4: Dashboard'u Başlat

```bash
# Terminal 2 (yeni terminal aç)
cd ui
npm run dev -- --hostname 0.0.0.0
```

**Beklenen çıktı:**
```
✓ Ready in 1s
- Local:   http://localhost:3000
- Network: http://192.168.1.158:3000
```

---

## Adım 5: Tarayıcıda Aç

```
http://localhost:3000
```

veya network'ten erişim için:

```
http://<your-ip>:3000
```

---

## Adım 6: İlk Agent'ı Bağla

### Basit Client Örneği

`test-client.ts` dosyası oluştur:

```typescript
import { Transport } from './src/transport/websocket';
import { generateAgentDID } from './src/identity/agent';

// Agent kimliği oluştur
const did = generateAgentDID('ali', 'testagent');
console.log('Agent DID:', did);

// Transport oluştur
const transport = new Transport({
  tailscaleEnabled: false,  // Yerel network için
  port: 18790,
  ssl: false,  // Production'da true yap
});

// Bağlan
transport.on('connected', () => {
  console.log('✅ Connected to server!');
});

transport.on('message', (message) => {
  console.log('📨 Received:', message);
});

transport.on('disconnected', () => {
  console.log('❌ Disconnected');
});

// Bağlantıyı başlat
await transport.connect();

// Test mesajı gönder
await transport.send({
  id: crypto.randomUUID(),
  from: did,
  to: 'broadcast',
  type: 'text',
  payload: 'Hello from test agent!',
  timestamp: new Date(),
  ttlSeconds: 60,
});

console.log('📤 Message sent!');

// 5 saniye bekle ve kapat
setTimeout(() => {
  transport.disconnect();
  process.exit(0);
}, 5000);
```

### Client'ı Çalıştır

```bash
npx tsx test-client.ts
```

**Beklenen çıktı:**
```
Agent DID: did:claw:ali:testagent
✅ Connected to server!
📤 Message sent!
📨 Received: { id: '...', from: 'did:claw:ali:testagent', ... }
```

---

## Adım 7: Dashboard'da Kontrol Et

Tarayıcıda **http://localhost:3000** adresine git:

1. **Agents** sekmesinde test agent'ını gör
2. Bağlantı durumu **online** (yeşil)
3. Agent detaylarını görüntüle

---

## 🎯 Sonraki Adımlar

### Consent Testi

```typescript
import { ConsentManager } from './src/consent/consent';

const manager = new ConsentManager();

// Onay talebi oluştur
const request = manager.request({
  requesterDid: 'did:claw:ali:testagent',
  action: 'read_file',
  details: { path: 'src/index.ts' },
  riskScore: 10,
  timeoutSeconds: 300,
});

console.log('Consent request ID:', request.id);
// Dashboard'da Consent Requests sekmesinde görün
```

### Network Egress Testi

```typescript
import { WebSocketServerManager } from './src/server/ws-server';
import { secureConfig } from './src/security/network-egress-filter';

const server = new WebSocketServerManager({
  port: 18790,
  ssl: false,
  networkConfig: secureConfig(),
});

await server.start();

// Güvenli network request
try {
  const response = await server.secureNetworkRequest(
    'did:claw:ali:testagent',
    'https://api.github.com/repos',
    { method: 'GET' }
  );
  console.log('✅ Network request successful:', response.status);
} catch (error) {
  console.error('❌ Network access blocked:', error.message);
}
```

---

## 🔧 Sorun Giderme

### Port Kullanımda

```bash
# Port 18790 kullanımda mı kontrol et
lsof -i :18790

# Kullanımdaysa process'i öldür
kill -9 <PID>

# Veya farklı port kullan
npm run server -- --port 18791
```

### Dashboard Yüklenmiyor

```bash
# Build temizle
cd ui
rm -rf .next node_modules
npm install
npm run build

# Restart
npm run dev -- --hostname 0.0.0.0
```

### SSL Certificate Hatası

Development için SSL'i kapat:

```typescript
const server = new WebSocketServerManager({
  port: 18790,
  ssl: false,  // Development için
});
```

> **⚠️ Uyarı:** Production'da `ssl: true` zorunludur.

### Agent Bağlanmıyor

```typescript
// Debug mode aktif et
const transport = new Transport({
  port: 18790,
  debug: true,  // Bağlantı loglarını göster
});

transport.on('error', (error) => {
  console.error('Connection error:', error);
});
```

---

## 📚 Daha Fazla Bilgi

| Doküman | Açıklama |
|---------|----------|
| **[Kullanım Rehberi](USAGE-GUIDE.md)** | Kapsamlı kullanım kılavuzu |
| **[Güvenlik](SECURITY.md)** | Güvenlik mimarisi, threat model |
| **[API Referansı](USAGE-GUIDE.md#api-referansı)** | Tüm API'ler |
| **[README](../README.md)** | Genel bakış |

---

## ✅ Kontrol Listesi

Başarılı kurulum için:

- [ ] Server çalışıyor (port 18790)
- [ ] Dashboard çalışıyor (port 3000)
- [ ] Tarayıcıda dashboard açık
- [ ] Test agent bağlandı
- [ ] Mesaj gönderildi/alındı
- [ ] Dashboard'da agent görünüyor

**Tümü ✅ ise:** Tebrikler! Agent Federation çalışıyor. 🦀

---

**🚀 Happy Federating!**
