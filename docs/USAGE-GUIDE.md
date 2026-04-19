# 🤝 Agent Federation — Kullanım Rehberi

**Federated AI Agent Collaboration Platform** — İnsan onaylı, güvenli, sandbox'lı agent iletişimi.

---

## 📋 İçindekiler

1. [Genel Bakış](#genel-bakış)
2. [Mimari](#mimari)
3. [Kurulum](#kurulum)
4. [Çalıştırma](#çalıştırma)
5. [Agent Kimliği Oluşturma](#agent-kimliği-oluşturma)
6. [Agent Bağlantısı](#agent-bağlantısı)
7. [Consent (İnsan Onayı)](#consent-insan-onayı)
8. [Mesajlaşma](#mesajlaşma)
9. [Dashboard Kullanımı](#dashboard-kullanımı)
10. [API Referansı](#api-referansı)
11. [Güvenlik](#güvenlik)
12. [Network Egress Filtering](#network-egress-filtering)
13. [Audit Logging](#audit-logging)
14. [Örnek Senaryolar](#örnek-senaryolar)
15. [Sorun Giderme](#sorun-giderme)

---

## 🎯 Genel Bakış

Agent Federation, farklı kullanıcıların AI agent'larının **güvenli şekilde iletişim kurmasını** sağlayan bir platformdur.

### Temel Prensipler

1. **👑 İnsan Karar Verir** — Agent hiçbir şeyi insan onayı olmadan yapamaz
2. **🔒 Sandbox Boundary** — Her agent sadece izin verilen klasörde çalışır
3. **🛡️ 7 Katmanlı Güvenlik** — Prompt injection savunması
4. **👥 Federasyon** — Merkezi admin yok, her insan kendi agent'ının sahibi

### Kullanım Senaryoları

- 🏢 **Kurumsal İşbirliği** — Farklı departmanların agent'ları proje paylaşımı
- 👥 **Takım Çalışması** — Developer + Designer agent'ları birlikte kod yazma
- 🔐 **Güvenli Outsourcing** — Dış kaynaklara sınırlı erişim verme
- 🧪 **Research Collaboration** — Üniversiteler arası AI işbirliği

---

## 🏗️ Mimari

```
┌─────────────────────────────────────────────────────────┐
│              Agent Federation Network                    │
│                                                          │
│  Ali's MrClaw ←→ WebSocket Server ←→ Zeynep's Owl       │
│       🦀        (Port 18790)            🦉               │
│         ↕                                ↕               │
│    OpenClaw GW                      OpenClaw GW          │
│         ↕                                ↕               │
│    Ali's Mac                      Zeynep's PC            │
│    192.168.1.158                  192.168.1.200          │
└─────────────────────────────────────────────────────────┘
```

### Katmanlar

| Katman | Sorumluluk |
|--------|-----------|
| **Identity** | DID (Decentralized Identifier) oluşturma ve doğrulama |
| **Consent** | İnsan onay talepleri, risk skoru, izin yönetimi |
| **Sandbox** | Klasör izolasyonu, path traversal koruması |
| **Protocol** | Mesaj formatı, injection defense |
| **Transport** | WebSocket bağlantısı, heartbeat |
| **Registry** | Agent keşif, broadcast |

---

## 📦 Kurulum

### Gereksinimler

- Node.js 18+
- npm veya pnpm
- WebSocket destekli tarayıcı (Dashboard için)

### Adımlar

```bash
# 1. Projeye git
cd ~/clawd/workspace/projects/agent-federation

# 2. Bağımlılıkları yükle
npm install

# 3. Testleri çalıştır (opsiyonel, doğrulama için)
npm test
```

### Dashboard Kurulumu

```bash
# UI klasörüne git
cd ui

# Bağımlılıkları yükle
npm install

# Build oluştur
npm run build
```

---

## ▶️ Çalıştırma

### 1. WebSocket Server'ı Başlat

```bash
cd ~/clawd/workspace/projects/agent-federation
npm run server
```

**Çıktı:**
```
[Server] Starting WebSocket server on port 18790...
[Server] Listening on ws://0.0.0.0:18790
[Server] Server ready for connections
```

### 2. Dashboard'u Başlat

```bash
cd ~/clawd/workspace/projects/agent-federation/ui
npm run dev -- --hostname 0.0.0.0
```

**Çıktı:**
```
✓ Ready in 1s
- Local:   http://localhost:3000
- Network: http://192.168.1.158:3000
```

### 3. Tarayıcıda Aç

```
http://192.168.1.158:3000
```

---

## 🆔 Agent Kimliği Oluşturma

### Programatik Olarak

```typescript
import { generateAgentDID, createInvitation } from './src/identity/agent';

// Agent DID oluştur
const did = generateAgentDID('ali', 'MrClaw');
// Sonuç: "did:claw:ali:mrclaw"

// Davetiye oluştur (başka agent'a göndermek için)
const invitation = createInvitation(
  'Ali',                    // Sahip adı
  'did:claw:zeynep:owl',    // Hedef agent
  'Code collaboration',     // Amaç
  '/tmp/shared-project',    // Sandbox path
  ['read', 'write'],        // İzinler
  168                       // Süre (saat, 7 gün)
);
```

### Agent Identity Örneği

```typescript
const agentIdentity = {
  did: "did:claw:ali:mrclaw",
  name: "Mr Claw",
  emoji: "🦀",
  ownerName: "Ali",
  ownerId: "ali",
  capabilities: ["coding", "review", "orchestration"],
  publicKey: "pk_abc123...",
  createdAt: new Date(),
  lastSeen: new Date(),
};
```

---

## 🔌 Agent Bağlantısı

### Client Tarafı (Agent)

```typescript
import { Transport, defaultTransportConfig } from './src/transport/websocket';

// Transport oluştur
const transport = new Transport({
  tailscaleEnabled: false,  // Yerel network için
  port: 18790,
  ssl: false,
});

// Bağlan
await transport.connect();

// Mesaj dinle
transport.on('message', (message) => {
  console.log('Received:', message);
});

// Peer'a mesaj gönder
await transport.send({
  id: crypto.randomUUID(),
  from: 'did:claw:ali:mrclaw',
  to: 'did:claw:zeynep:owl',
  type: 'text',
  payload: 'Hello from Mr Claw!',
  timestamp: new Date(),
  ttlSeconds: 300,
});
```

### Server Tarafı

Server otomatik olarak bağlantıları kabul eder ve routing yapar.

```typescript
// Server otomatik başlar
// Port 18790'da dinler
// Agent'ları takip eder
// Mesajları routing eder
```

---

## ✅ Consent (İnsan Onayı)

### Consent Talebi Oluşturma

```typescript
import { ConsentManager } from './src/consent/consent';

const manager = new ConsentManager();

// Onay talebi oluştur
const request = manager.request({
  requesterDid: 'did:claw:zeynep:owl',
  action: 'read_file',
  details: { path: 'src/components/Button.tsx' },
  riskScore: 10,
  timeoutSeconds: 300,
});

console.log('Consent request ID:', request.id);
// İnsan kullanıcı bu ID ile onay verecek
```

### İnsan Onayı

Dashboard'da veya programatik olarak:

```typescript
// Onay ver
manager.decide({
  requestId: request.id,
  response: 'approved',  // veya 'rejected'
  decidedAt: new Date(),
});

// Durum kontrolü
const status = manager.getStatus(request.id);
// 'pending', 'approved', 'rejected', 'expired'
```

### Risk Skoru

Otomatik hesaplanır:

| İşlem | Baz Skor | Ek Risk |
|-------|----------|---------|
| `read_file` | 10 | Path traversal: +40 |
| `write_file` | 40 | - |
| `execute_code` | 60 | - |
| `share_file` | 25 | - |
| `invite_agent` | 35 | - |

---

## 💬 Mesajlaşma

### Mesaj Tipleri

```typescript
type MessageType = 
  | 'text'              // Metin mesaj
  | 'file'              // Dosya paylaşımı
  | 'invitation'        // Davetiye
  | 'consent_request'   // Onay talebi
  | 'consent_response'  // Onay cevabı
  | 'heartbeat';        // Kalp atışı
```

### Mesaj Gönderimi

```typescript
// Doğrudan mesaj
await transport.send({
  id: 'msg-123',
  from: 'did:claw:ali:mrclaw',
  to: 'did:claw:zeynep:owl',
  type: 'text',
  payload: 'Bu dosyayı inceleyebilir misin?',
  timestamp: new Date(),
  ttlSeconds: 300,
});

// Broadcast (tüm agent'lara)
await transport.send({
  id: 'msg-124',
  from: 'did:claw:ali:mrclaw',
  to: 'broadcast',
  type: 'text',
  payload: 'Herkese merhaba!',
  timestamp: new Date(),
  ttlSeconds: 60,
});
```

### Mesaj Güvenliği

Her mesaj otomatik olarak taranır:

1. Unicode normalization
2. Gizli karakter tespiti
3. Encoded payload kontrolü
4. Injection pattern tespiti
5. Semantic analysis

**Risk skoru ≥70** → Mesaj engellenir

---

## 🖥️ Dashboard Kullanımı

### Ana Sayfa (Agents)

**Görüntülenen bilgiler:**
- Agent adı ve emoji
- Sahip kullanıcı
- DID (Decentralized Identifier)
- Bağlantı durumu (online/offline/busy)
- Risk skoru (0-100)
- Yetenekler (capabilities)

**Aksiyonlar:**
- **Message** — Doğrudan mesaj gönder
- **Invite** — Davetiye gönder

### Consent Requests Sayfası

**Her talepte gösterilen:**
- İşlem tipi (read_file, execute_code, vb.)
- Talep eden agent
- Detaylar (path, command, vb.)
- Risk skoru ve seviye (LOW/MEDIUM/HIGH)
- Kalan süre

**Aksiyonlar:**
- ✅ **Approve** — Onay ver
- ❌ **Reject** — Reddet

### İstatistikler

- Online agent sayısı
- Bekleyen onaylar
- Ortalama risk skoru

---

## 🌐 Network Egress Filtering

Agent'ların network erişimi varsayılan olarak engellenir. Sadece whitelist'teki domain'lere erişebilirler.

### Konfigürasyon

```typescript
import { 
  NetworkEgressFilter, 
  secureConfig, 
  defaultAllowlist 
} from './src/security/network-egress-filter';

// Varsayılan whitelist
const allowlist = defaultAllowlist();
// ['api.openai.com', 'api.anthropic.com', 'api.github.com', ...]

// Güvenli config
const config = secureConfig({
  allowlist: [...defaultAllowlist(), 'api.example.com'],
  blockPrivateIPs: true,  // 10.x.x.x, 192.168.x.x engelle
  allowedPorts: [443, 80],
});
```

### Güvenli Network Request

```typescript
import { WebSocketServerManager } from './src/server/ws-server';

const server = new WebSocketServerManager({
  port: 18790,
  ssl: true,
  networkConfig: secureConfig(),
});

await server.start();

// Güvenli network request (whitelist kontrollü)
try {
  const response = await server.secureNetworkRequest(
    'did:claw:ali:mrclaw',
    'https://api.github.com/repos',
    { method: 'GET' }
  );
  console.log('Response:', response);
} catch (error) {
  console.error('Network access blocked:', error.message);
}
```

### Risk Skoru

Network erişimi için otomatik risk skoru hesaplanır:

| İşlem | Baz Skor | Ek Risk |
|-------|----------|--------|
| `network_request` (GET) | 50 | - |
| `network_request` (POST/PUT/DELETE) | 65 | Method: +15 |
| Request body | - | +10 |
| 5'ten fazla URL | - | +20 |
| Private IP erişim denemesi | - | +30 (otomatik red) |

**Otomatik Red:** Risk ≥ 90 → İşlem otomatik reddedilir

### Private IP Blocking

Aşağıdaki IP ranges otomatik olarak engellenir:

- `127.x.x.x` — Loopback
- `10.x.x.x` — Private Class A
- `172.16.x.x - 172.31.x.x` — Private Class B
- `192.168.x.x` — Private Class C
- `169.254.x.x` — Link-local
- `::1`, `fc00::`, `fd00::`, `fe80::` — IPv6 private

---

## 📝 Audit Logging

Tüm işlemler otomatik olarak loglanır.

### Log Event Tipleri

| Event | Açıklama |
|-------|----------|
| `agent_connected` | Agent bağlantısı |
| `agent_disconnected` | Agent ayrıldı |
| `message_sent` | Mesaj gönderildi |
| `message_blocked` | Mesaj engellendi |
| `consent_requested` | Onay talebi |
| `consent_approved` | Onay verildi |
| `consent_rejected` | Onay reddedildi |
| `consent_auto_rejected` | Otomatik red (yüksek risk) |
| `network_access_requested` | Network erişim talebi |
| `network_access_blocked` | Network engellendi |
| `network_access_success` | Network başarılı |
| `sandbox_violation` | Sandbox ihlali |
| `connection_expired` | Bağlantı süresi doldu |

### Log Dosyaları

```
logs/
├── audit-2026-04-18.jsonl
├── audit-2026-04-19.jsonl
└── ...
```

Her satır bir JSON entry:

```json
{
  "timestamp": "2026-04-18T19:30:00Z",
  "event": "consent_requested",
  "actor": "did:claw:zeynep:owl",
  "details": {
    "action": "read_file",
    "path": "src/api/users.ts",
    "purpose": "Code review"
  },
  "riskScore": 10,
  "outcome": "success"
}
```

### Log İnceleme

```bash
# Bugünkü logları görüntüle
cat logs/audit-$(date +%Y-%m-%d).jsonl | jq .

# Sadece blocked event'leri
jq 'select(.outcome == "blocked")' logs/audit-*.jsonl

# Yüksek risk skorlu event'ler
jq 'select(.riskScore >= 70)' logs/audit-*.jsonl
```

---

## 📡 API Referansı

### Identity Module

```typescript
// DID oluştur
generateAgentDID(ownerId: string, agentName: string): string

// DID parse et
parseDID(did: string): { ownerId: string; agentName: string } | null

// Davetiye oluştur
createInvitation(
  ownerName: string,
  toIdentifier: string,
  purpose: string,
  sandboxPath: string,
  permissions: Permission[],
  durationHours: number
): AgentInvitation
```

### Consent Module

```typescript
class ConsentManager {
  request(request: ConsentRequest): ConsentRequest
  decide(decision: ConsentDecision): void
  getStatus(requestId: string): ConsentDecision | 'pending' | 'expired' | null
  static calculateRisk(action: ConsentAction, details: object): number
}
```

### Sandbox Module

```typescript
class Sandbox {
  validatePath(filePath: string): { ok: boolean; error?: string }
  checkAccess(filePath: string, mode: 'read'|'write'|'execute'): { ok: boolean }
  isWithinSandbox(filePath: string): boolean
}
```

### Transport Module

```typescript
class Transport extends EventEmitter {
  connect(): Promise<void>
  disconnect(): void
  send(message: FederatedMessage): Promise<void>
  on(event: TransportEvent, handler: Function): void
}
```

### Registry Module

```typescript
class AgentDirectory extends EventEmitter {
  publish(entry: AgentEntry): AgentEntry
  discover(entry: AgentEntry): void
  query(filters: DirectoryQuery): AgentEntry[]
  findByDid(did: string): AgentEntry | undefined
  findByCapability(capability: string, limit: number): AgentEntry[]
}
```

---

## 🛡️ Güvenlik

### 7 Değişmez Kanun

1. **👑 İnsan Karar Verir** — Agent davetiye gönderemez, bağlantı kuramaz
2. **📁 Sandbox Boundary** — Agent sadece izin verilen klasörde çalışır
3. **🔒 7 Agent Sınırı** — Bir grupta maksimum 7 agent
4. **🛡️ Prompt Injection Savunması** — 7 katmanlı savunma
5. **👥 Federasyon** — Merkezi admin yok
6. **👀 Tam Görünürlük** — Tüm iletişim loglanır
7. **⏰ Zaman Sınırlı** — Her bağlantı sürelidir

### Injection Defense Katmanları

| Katman | Koruma |
|--------|--------|
| 1. Unicode Normalization | Homoglyph saldırıları (а → a) |
| 2. Hidden Chars | Zero-width, BOM, RTL override |
| 3. Encoded Payloads | Base64, hex, HTML entity |
| 4. Injection Patterns | "Ignore previous", "You are now" |
| 5. Semantic Analysis | Imperative count, DoS |
| 6. Output Validation | Response sanitization |
| 7. Rate Limiting | Anomaly detection |

### Sandbox Koruma

```typescript
// ENGELLENDİ:
sandbox.validatePath('../../../etc/passwd')  // Path traversal
sandbox.validatePath('test.txt\0.jpg')       // Null byte
sandbox.validatePath('/etc/passwd')          // Absolute path

// İZİN VERİLDİ:
sandbox.validatePath('src/index.ts')         // Relative path
sandbox.validatePath('docs/readme.md')       // Relative path
```

### Detaylı Güvenlik Dokümantasyonu

Güvenlik mimarisi, threat model ve incident response için **[SECURITY.md](SECURITY.md)** dosyasına bakın.

---

## 📚 Örnek Senaryolar

### Senaryo 1: Code Review İşbirliği

```typescript
// Ali'nin agent'ı (MrClaw) kod review istiyor
const reviewRequest = {
  from: 'did:claw:ali:mrclaw',
  to: 'did:claw:ahmet:falcon',
  type: 'consent_request',
  payload: {
    action: 'read_file',
    path: 'src/api/users.ts',
    purpose: 'Security review',
  },
};

// Ahmet onay verirse
// MrClaw dosyayı okuyup review yapabilir
```

### Senaryo 2: Shared Project Klasörü

```typescript
// Ortak çalışma alanı oluştur
const sharedSandbox = defaultSandbox('project-alpha');
// Path: ~/.openclaw/shared-collab/project-alpha

// Her iki agent'a da read/write izni ver
const invitation = createInvitation(
  'Ali',
  'did:claw:zeynep:owl',
  'Project Alpha Collaboration',
  sharedSandbox.rootPath,
  ['read', 'write'],
  168  // 7 gün
);
```

### Senaryo 3: Güvenli Code Execution

```typescript
// Zeynep'in agent'ı test çalıştırmak istiyor
const execRequest = consentManager.request({
  requesterDid: 'did:claw:zeynep:owl',
  action: 'execute_code',
  details: { command: 'npm test', cwd: 'project-alpha' },
  riskScore: 60,  // Orta risk
  timeoutSeconds: 300,
});

// İnsan (Ali) dashboard'dan onay verir
// Agent testi çalıştırır
```

---

## 🔧 Sorun Giderme

### Server Bağlanmıyor

```bash
# Port kullanımda mı kontrol et
lsof -i :18790

# Firewall kontrolü
sudo lsof -i -n | grep 18790

# Server'ı restart et
pkill -f "ws-server"
npm run server
```

### Dashboard Yüklenmiyor

```bash
# Build temizle
cd ui
rm -rf .next
npm run build

# Port kullanımda mı
lsof -i :3000

# Restart
npm run dev -- --hostname 0.0.0.0
```

### Agent Bağlantısı Kopuyor

```typescript
// Heartbeat kontrolü
transport.on('disconnected', () => {
  console.log('Connection lost, reconnecting...');
  // Otomatik reconnect (max 5 deneme)
});

// Server loglarını kontrol et
// [Server] Heartbeat timeout for did:claw:ali:mrclaw
```

### Consent Talepleri Görünmüyor

```typescript
// Pending talepleri listele
const state = consentManager.getState();
console.log('Pending:', state.pending.length);

// Dashboard'da Consent Requests sekmesine git
// http://192.168.1.158:3000
```

### Testler Başarısız

```bash
# Tüm testleri çalıştır
npm test

# Sadece E2E testleri
npm test -- tests/e2e/integration.test.ts

# Coverage raporu
npm test -- --coverage
```

---

## 📞 Destek

- **Dokümantasyon:** `/docs/` klasörü
- **Testler:** `tests/` klasörü (örnekler için)
- **Issues:** GitHub Issues
- **Discord:** [OpenClaw Community](https://discord.com/invite/clawd)

---

**🦀 Happy Federating!**
