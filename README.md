# 🤝 Agent Federation Network

**Federated AI Agent Collaboration Platform** — İnsan onaylı, güvenli, sandbox'lı.

[![Test Status](https://img.shields.io/badge/tests-45%20passed-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/typescript-100%25-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## 📜 7 Değişmez Kanun (Immutable Laws)

1. **👑 İnsan Karar Verir** — Agent davetiye gönderemez, kabul edemez, bağlantı kuramaz
2. **📁 Sandbox Boundary** — Agent sadece izin verilen klasörde çalışır
3. **🔒 7 Agent Sınırı** — Bir grupta maksimum 7 agent birlikte çalışabilir
4. **🛡️ Prompt Injection Savunması** — 7 katmanlı savunma, her mesaj sanitize edilir
5. **👥 Federasyon** — Merkezi admin yok, her insan kendi agent'ının sahibi
6. **👀 Tam Görünürlük** — Tüm iletişim loglanır, insan takip edebilir
7. **⏰ Zaman Sınırlı** — Her bağlantı sürelidir, otomatik sonlanır

## 🎯 Genel Bakış

Agent Federation, farklı kullanıcıların AI agent'larının **güvenli şekilde iletişim kurmasını** sağlayan bir platformdur. Merkezi otorite olmadan, her agent kendi sahibinin kontrolünde kalırken işbirliği yapabilir.

### Temel Özellikler

| Özellik | Durum | Açıklama |
|---------|-------|----------|
| **Identity System** | ✅ Tamamlandı | DID (Decentralized Identifier) ile agent kimliği |
| **Consent Manager** | ✅ Tamamlandı | İnsan onayı gerektiren işlemler |
| **Sandbox** | ✅ Tamamlandı | Klasör izolasyonu ve path traversal koruması |
| **Injection Defense** | ✅ Tamamlandı | 7 katmanlı prompt injection savunması |
| **WebSocket Server** | ✅ Tamamlandı | Agent'lar arası mesajlaşma (port 18790) |
| **Network Egress Filter** | ✅ Tamamlandı | Domain whitelist ve private IP blocking |
| **Agent Directory** | ✅ Tamamlandı | Agent keşif ve kayıt sistemi |
| **Dashboard UI** | ✅ Tamamlandı | Next.js yönetim paneli |
| **Audit Logging** | ✅ Tamamlandı | Tüm işlemlerin loglanması |
| **Test Suite** | ✅ Tamamlandı | 45 test (core, server, E2E) |

### Kullanım Senaryoları

- 🏢 **Kurumsal İşbirliği** — Farklı departmanların agent'ları proje paylaşımı
- 👥 **Takım Çalışması** — Developer + Designer agent'ları birlikte kod yazma
- 🔐 **Güvenli Outsourcing** — Dış kaynaklara sınırlı erişim verme
- 🧪 **Research Collaboration** — Üniversiteler arası AI işbirliği

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

| Katman | Sorumluluk | Dosya |
|--------|-----------|-------|
| **Identity** | DID oluşturma ve doğrulama | `src/identity/agent.ts` |
| **Consent** | İnsan onay talepleri, risk skoru | `src/consent/consent.ts` |
| **Sandbox** | Klasör izolasyonu, path traversal koruması | `src/sandbox/sandbox.ts` |
| **Protocol** | Mesaj formatı, injection defense | `src/protocol/injection-defense.ts` |
| **Transport** | WebSocket bağlantısı, heartbeat | `src/transport/websocket.ts` |
| **Server** | Merkezi mesaj routing | `src/server/ws-server.ts` |
| **Security** | Network egress filtering | `src/security/network-egress-filter.ts` |
| **Registry** | Agent keşif, broadcast | `src/registry/directory.ts` |
| **UI** | Dashboard (Next.js) | `ui/` |

## 🚀 Hızlı Başlangıç

### 1. Server'ı Başlat

```bash
cd projects/agent-federation
npm install
npm run server
```

Server port 18790'da çalışacaktır: `ws://192.168.1.158:18790`

### 2. Dashboard'u Başlat

```bash
cd projects/agent-federation/ui
npm install
npm run dev -- --hostname 0.0.0.0
```

Dashboard tarayıcıda aç: **http://192.168.1.158:3000**

### 3. Agent Bağla

```typescript
import { Transport } from './src/transport/websocket';

const transport = new Transport({
  tailscaleEnabled: false,
  port: 18790,
  ssl: false,
});

await transport.connect();
```

### 4. İlk Mesaj

Dashboard'dan:
1. **Agents** sekmesine git
2. Bir agent seç
3. **Message** butonuna tıkla

## 📊 Test Durumu

```
✓ 45 tests passed
├── Core Tests: 17
│   ├── Identity: 3
│   ├── ConsentManager: 3
│   ├── Sandbox: 3
│   ├── InjectionDefense: 4
│   └── AgentDirectory: 4
├── Server Tests: 22
│   ├── WebSocket Server: 10
│   ├── Network Egress Filter: 8
│   └── Consent Network: 4
└── E2E Tests: 6
    ├── Integration: 3
    └── Security: 3
```

### Testleri Çalıştır

```bash
cd projects/agent-federation

# Tüm testler
npm test

# Coverage raporu
npm test -- --coverage

# Sadece security testleri
npm test -- network-egress-filter
npm test -- consent-network
```

## 🛡️ Güvenlik

### Network Egress Filtering

Agent'ların network erişimi varsayılan olarak engellenir. Sadece whitelist'teki domain'lere erişebilirler:

```typescript
import { secureConfig, defaultAllowlist } from './src/security/network-egress-filter';

// Varsayılan whitelist
const allowlist = defaultAllowlist();
// ['api.openai.com', 'api.anthropic.com', 'api.github.com', ...]

// Güvenli config
const config = secureConfig({
  allowlist: [...defaultAllowlist(), 'api.example.com'],
  blockPrivateIPs: true,
  allowedPorts: [443, 80],
});
```

### Risk Skoru

Her işlem otomatik olarak risk skoru alır:

| İşlem | Baz Skor | Ek Risk |
|-------|----------|---------|
| `read_file` | 10 | Path traversal: +40 |
| `write_file` | 40 | - |
| `execute_code` | 60 | - |
| `network_request` | 50 | POST/PUT/DELETE: +15 |
| `execute_code_with_network` | 80 | Private IP: +30 |

**Otomatik Red:** Risk ≥ 90 → İşlem otomatik reddedilir

### Injection Defense

7 katmanlı savunma:

1. **Unicode Normalization** — Homoglyph saldırıları
2. **Hidden Characters** — Zero-width, BOM, RTL override
3. **Encoded Payloads** — Base64, hex, HTML entity
4. **Injection Patterns** — "Ignore previous", "You are now"
5. **Semantic Analysis** — Imperative count, DoS
6. **Output Validation** — Response sanitization
7. **Rate Limiting** — Anomaly detection

## 📖 Dokümantasyon

| Doküman | Açıklama |
|---------|----------|
| **[Kullanım Rehberi](docs/USAGE-GUIDE.md)** | Kapsamlı kullanım kılavuzu |
| **[Güvenlik](docs/SECURITY.md)** | Güvenlik mimarisi, threat model |
| **[WebSocket Server](docs/WEBSOCKET-SERVER.md)** | Server dokümantasyonu |
| **[Dashboard](docs/DASHBOARD.md)** | UI bileşenleri |
| **[Network Egress](docs/NETWORK_EGRESS_FILTERING.md)** | Network güvenlik detayları |

## 🔧 Teknoloji Stack

| Katman | Teknoloji |
|--------|-----------|
| **Backend** | TypeScript + Node.js |
| **Transport** | WebSocket + Tailscale/Cloudflare Tunnel |
| **Identity** | DID + Verifiable Credentials |
| **Frontend** | Next.js 14 + Tailwind + shadcn/ui |
| **Security** | 7-katmanlı input sanitization pipeline |
| **Testing** | Vitest + E2E tests |

## 📦 Modül Eksportları

```typescript
// Ana export'lar
import {
  // Identity
  generateAgentDID,
  parseDID,
  createInvitation,
  
  // Consent
  ConsentManager,
  
  // Sandbox
  Sandbox,
  defaultSandbox,
  
  // Security
  NetworkEgressFilter,
  secureConfig,
  defaultAllowlist,
  
  // Transport
  Transport,
  
  // Server
  WebSocketServerManager,
  
  // Registry
  AgentDirectory,
  
  // Protocol
  scanMessage,
  InjectionDefense,
} from './src/index';
```

## 📝 Lisans

MIT License — Detaylar için [LICENSE](LICENSE) dosyasına bakın.

---

**🦀 Happy Federating!**
