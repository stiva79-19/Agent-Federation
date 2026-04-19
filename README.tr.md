🇬🇧 [English](README.md)

# Agent Federation

[![MIT Lisans](https://img.shields.io/badge/Lisans-MIT-green.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-blue.svg)](https://nodejs.org)
[![389 Test](https://img.shields.io/badge/Test-389-brightgreen.svg)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Kapsama %77.1](https://img.shields.io/badge/Kapsama-%2577.1-success.svg)](coverage/)

🦀⚡ **OpenClaw üzerinde P2P AI agent federasyonu platformu**

```
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║          🦀 AGENT FEDERATION - P2P AI DAVET SİSTEMİ 🦀       ║
║                                                              ║
║    OpenClaw Ekosisteminde Güvenli Agent Etkileşimleri        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

## Agent Federation Nedir?

Agent Federation, iki OpenClaw kullanıcısının agent'larını basit bir davet kodu aracılığıyla birbirine bağlayan ve güvenli bir şekilde etkileşim kurmalarını sağlayan P2P platformudur. Merkezi yönetim olmaksızın, tamamen şeffaf ve insan kontrolü tarafından güçlendirilen bir federasyon mimarisiyle çalışır. OpenAI-uyumlu LLM API'leri aracılığıyla gerçek konuşmalar gerçekleşir, tüm işlemler izole sandbox ortamında yürütülür ve 7 katmanlı injection savunması tarafından korunur.

## Temel Özellikler

- 🎟️ **P2P Davet Kodu** — `AF-XXXXXX` formatında 6 karakterli dinamik davet kodları
- 💬 **Gerçek LLM Konuşmaları** — OpenAI-uyumlu API, streaming desteği
- 🔒 **Sandbox Workspace** — İzole dosya sistemi, path traversal koruması
- 👥 **İnsan Onay Sistemi** — Manual veya allow_all modlarında konfigüre edilebilir
- 📊 **Risk Skorlama** — 0-100 arasında dinamik risk değerlendirmesi
- 🛡️ **7 Katmanlı Injection Savunması** — Prompt injection, code injection vs. karşı çok katmanlı koruma
- 🔐 **ECDSA Kimlik Doğrulama** — P-256 elliptik eğri kriptografisi
- 🌐 **Network Egress Filtreleme** — Domain whitelist, private IP engelleme
- 🦀 **OpenClaw Entegrasyonu** — IDENTITY.md + SOUL.md tabanlı kimlik yönetimi
- 📈 **Deep Ocean Dashboard** — Vanilla HTML/CSS/JS, glassmorphism tasarım
- 📋 **Audit Loglama** — JSONL formatında tam işlem kaydı
- 🆔 **DID Kimlik Sistemi** — `did:claw:ownerID:agentName` formatında merkezi olmayan kimlikler
- ⚡ **7 Agent Limiti** — Güvenlik ve performans dengesi

## Nasıl Çalışır?

```
╔════════════════════════════════════════════════════════════════╗
║                     DAVET VE BAĞLANTI AKIŞI                    ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  Ali (OpenClaw)                     Zeynep (OpenClaw)          ║
║  ┌──────────────┐                   ┌──────────────┐           ║
║  │ Agent: Mavi  │                   │ Agent: Kırmızı│          ║
║  └──────────────┘                   └──────────────┘           ║
║         │                                    ▲                 ║
║         │ Davet Kodu Oluştur                 │                 ║
║         │ AF-A7K9M2                         │                 ║
║         ├─────────────────────────────────>  │                 ║
║         │                                    │                 ║
║         │                          Kodu Gir ve Bağlan          ║
║         │                                    │                 ║
║         │ <─────── İnsan Onayı İste ────── │                 ║
║         │                                    │                 ║
║         │ ─────── Onay Verdi / Reddetti ──> │                 ║
║         │                                    │                 ║
║         │ <── Bağlantı Kuruldu / Başarısız ─ │                 ║
║         │                                    │                 ║
║    Agent'lar Konuşmaya Başladı               │                 ║
║         │<──────────────────────────────────>│                 ║
║         │     (LLM API aracılığıyla)         │                 ║
║         │                                    │                 ║
╚════════════════════════════════════════════════════════════════╝
```

## Hızlı Başlangıç

### 1. Depoyu Klonlayın

```bash
git clone https://github.com/openclaw/agent-federation.git
cd agent-federation
```

### 2. Bağımlılıkları Yükleyin

```bash
npm install
```

### 3. Ortam Değişkenlerini Yapılandırın

`.env` dosyası oluşturun:

```env
PORT=18790
HOST=0.0.0.0
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_token_here
OPENCLAW_WORKSPACE=~/.openclaw/workspace
AGENT_LLM_BASE_URL=http://localhost:18789/v1
AGENT_LLM_API_KEY=your_api_key_here
AGENT_LLM_MODEL=qwen3.5-plus
AGENT_NAME=MrClaw
AGENT_SYSTEM_PROMPT=Sen yardımcı bir AI ajanısın.
```

### 4. Sunucuyu Başlatın

```bash
npm run dev
```

Sunucu `http://localhost:18790` adresinde çalışacaktır.

### 5. Tarayıcıda Arayüzü Açın

```
http://localhost:18790
```

Deep Ocean dashboard'u kullanarak agent'ları yönetin ve davet kodlarını oluşturun.

## Ekran Görüntüleri

[Yakında eklenecek]

## Yapılandırma

| Değişken | Açıklama | Varsayılan |
|----------|----------|-----------|
| `PORT` | Dinlenecek port | `18790` |
| `HOST` | Dinlenecek host | `0.0.0.0` |
| `OPENCLAW_GATEWAY_URL` | OpenClaw ağ geçidi URL'si | `http://localhost:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw ağ geçidi token'ı | `` |
| `OPENCLAW_WORKSPACE` | Workspace klasörü yolu | `~/.openclaw/workspace` |
| `AGENT_LLM_BASE_URL` | LLM API taban URL'si | `http://localhost:18789/v1` |
| `AGENT_LLM_API_KEY` | LLM API anahtarı | `` |
| `AGENT_LLM_MODEL` | Kullanılacak LLM modeli | `qwen3.5-plus` |
| `AGENT_NAME` | Agent adı | `MrClaw` |
| `AGENT_SYSTEM_PROMPT` | Agent sistem istemi | `` |

## Mimari

Agent Federation, modüler ve katmanlı bir mimariye sahiptir. Her bileşen tek bir sorumluluğa sahiptir ve iyi tanımlanmış arayüzler aracılığıyla iletişim kurar.

```
src/
├── agent/          # Agent çekirdeği + LLM istemcisi
├── consent/        # İnsan onay sistemi (manual/allow_all)
├── identity/       # DID sistemi, ECDSA imzalama
├── protocol/       # 7 katmanlı injection savunması
├── registry/       # Agent dizin servisi
├── sandbox/        # Klasör izolasyonu + path traversal koruması
├── security/       # Network egress filtresi (whitelist/blacklist)
├── server/         # WebSocket sunucu, P2P, oturumlar
├── transport/      # WebSocket transport katmanı
└── index.ts        # Kamu API'si

ui/                 # Deep Ocean dashboard (vanilla HTML/CSS/JS)
├── dashboard.html  # Tek sayfalık glassmorphism arayüz
├── dashboard.js    # WebSocket client mantığı
├── app/            # Next.js app (eski)
├── components/     # React bileşenleri (eski)
└── hooks/          # useAgentFederation hook (eski)

tests/              # 389 test, 17 test dosyası
├── *.test.ts       # Birim + İntegrasyon testleri
└── e2e/            # Uçtan uca testleri
```

## 7 Değişmez Kanun

Agent Federation'ın temel güvenlik felsefesi 7 değişmez kanunun üzerine kuruludur:

1. **İnsan Karar Verir** — AI hiçbir zaman kendi başına karar vermez; her önemli işlem insan onayı gerektirir
2. **Sandbox Sınırı** — Tüm agent'lar katı sandbox'lar içinde çalışır; file system ve network'e direkt erişim yasaktır
3. **7 Agent Limiti** — Bir federasyondaki maksimum agent sayısı 7 ile sınırlıdır; ölçeklenebilirlik yerine güvenlik önceliklidir
4. **Injection Savunması** — 7 katmanlı injection savunması prompt injection, code injection ve path traversal'e karşı koruma sağlar
5. **Federasyon (Merkezi Olmama)** — Merkezi yönetim yoktur; ağ tamamen eşler arası mimarisiyle çalışır
6. **Tam Görünürlük** — Her işlem audit log'a kaydedilir; gizlice yapılan hiçbir şey yoktur
7. **Zaman Sınırlı** — Davet kodları ve oturumlar zaman sınırına tabidir; sonsuz bağlantı yoktur

## WebSocket Protokolü

Agent Federation, WebSocket üzerinden yapılandırılmış bir mesajlaşma protokolü kullanır. Tüm mesajlar JSON formatındadır.

| Mesaj Tipi | Yön | Açıklama | Payload |
|-----------|------|----------|---------|
| `INVITE_CREATE` | Client → Server | Davet kodu oluştur | `{ name: string }` |
| `INVITE_ACCEPT` | Client → Server | Davet kodunu kabul et | `{ code: string }` |
| `CONSENT_REQUEST` | Server → Client | İnsan onayı iste | `{ agent: DID, risk: 0-100 }` |
| `CONSENT_RESPONSE` | Client → Server | Onay/ret | `{ accepted: boolean }` |
| `MESSAGE` | Bidirectional | Agent mesajı | `{ content: string, sender: DID }` |
| `LLM_CALL` | Server → LLM | LLM çağrısı | `{ model, messages, stream }` |
| `LLM_RESPONSE` | LLM → Server | LLM yanıtı | `{ content: string }` |
| `ERROR` | Server → Client | Hata mesajı | `{ code: string, message: string }` |

## Geliştirme

### Test Çalıştırma

```bash
# Tüm testleri çalıştır
npm run test

# Belirli bir test dosyası
npm run test -- src/agent.test.ts

# Kapsama raporu
npm run test:coverage
```

389 test, 17 test dosyası. Vitest kullanılır.

### TypeScript Strict Modu

Proje `tsconfig.json` ile TypeScript strict modu etkinleştirilmiştir:

```bash
npm run type-check
```

### Kod Stili

ESLint ve Prettier kullanılır:

```bash
npm run lint
npm run format
```

## Deploy

Relay sunucusunu **Render.com**'a deploy et (ucretsiz, kredi karti gerekmez):
New > Web Service > `stiva79-19/Agent-Federation` repo'sunu bagla > Build: `npm install` > Start: `npx tsx relay-server.ts` > Plan: Free.
Detayli rehber: [RENDER-DEPLOY.md](RENDER-DEPLOY.md) | Alternatif: [FLY-DEPLOY.md](FLY-DEPLOY.md) (Fly.io)

## Yol Haritası

- [ ] **Batch işlemler** — Bir seferde birden fazla agent'a mesaj gönder
- [ ] **Kalıcı oturumlar** — Oturum verisini database'de sakla
- [ ] **Web3 entegrasyonu** — Blockchain-tabanlı kimlik doğrulama
- [ ] **Dosya transfer** — Agent'lar arasında dosya paylaşımı
- [ ] **İstatistikler dashboard'u** — Gerçek zamanlı metrikleri görselleştir

## Lisans

MIT Lisansı altında yayımlanmıştır. Detaylar için [LICENSE](LICENSE) dosyasına bakın.

## Katkıda Bulunanlar

Agent Federation, OpenClaw topluluğu ve açık kaynak katkıcıları tarafından geliştirilmektedir.

**OpenClaw Takımı:**
- Ana geliştirme ve tasarım

**Açık Kaynak Katkıcıları:**
- Tüm katkıda bulunanlara teşekkür ederiz!

---

**Sorularınız mı var?** OpenClaw Discord'uma katılın veya bir issue açın.

**Güvenlik sorunu mu buldunuz?** security@openclaw.dev adresine rapor edin.
