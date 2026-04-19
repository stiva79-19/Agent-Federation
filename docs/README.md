# 📚 Agent Federation — Dokümantasyon İndeksi

Tüm dokümantasyon dosyaları ve açıklamaları.

---

## 🚀 Başlangıç

| Doküman | Açıklama | Okuma Süresi |
|---------|----------|--------------|
| **[QUICKSTART.md](QUICKSTART.md)** | 5 dakikada ilk agent bağlantısı | 5 dk |
| **[README.md](../README.md)** | Proje genel bakış | 5 dk |

---

## 📖 Kullanım Rehberleri

| Doküman | Açıklama | Okuma Süresi |
|---------|----------|--------------|
| **[USAGE-GUIDE.md](USAGE-GUIDE.md)** | Kapsamlı kullanım kılavuzu | 20 dk |
| **[API-REFERENCE.md](API-REFERENCE.md)** | Tüm API'ler ve tipler | 15 dk |
| **[DASHBOARD.md](DASHBOARD.md)** | Dashboard UI bileşenleri | 10 dk |

---

## 🛡️ Güvenlik

| Doküman | Açıklama | Okuma Süresi |
|---------|----------|--------------|
| **[SECURITY.md](SECURITY.md)** | Güvenlik mimarisi, threat model | 25 dk |
| **[NETWORK_EGRESS_FILTERING.md](NETWORK_EGRESS_FILTERING.md)** | Network güvenlik detayları | 15 dk |

---

## 🏗️ Teknik Dokümantasyon

| Doküman | Açıklama | Okuma Süresi |
|---------|----------|--------------|
| **[WEBSOCKET-SERVER.md](WEBSOCKET-SERVER.md)** | WebSocket server dokümantasyonu | 15 dk |
| **[architecture.md](architecture.md)** | Mimari tasarım | 10 dk |
| **[SUBAGENT-DEPTH-LIMIT.md](SUBAGENT-DEPTH-LIMIT.md)** | Subagent derinlik limiti | 10 dk |

---

## 📋 Hızlı Referans

### Kurulum

```bash
cd projects/agent-federation
npm install
npm run server      # Server'ı başlat
cd ui && npm run dev  # Dashboard'u başlat
```

### Testleri Çalıştır

```bash
npm test              # Tüm testler
npm test -- --coverage  # Coverage raporu
```

### Doküman Okuma Sırası

**Yeni kullanıcılar için:**
1. [QUICKSTART.md](QUICKSTART.md) — Hızlı başlangıç
2. [README.md](../README.md) — Genel bakış
3. [USAGE-GUIDE.md](USAGE-GUIDE.md) — Kullanım rehberi

**Geliştiriciler için:**
1. [API-REFERENCE.md](API-REFERENCE.md) — API referansı
2. [architecture.md](architecture.md) — Mimari
3. [SECURITY.md](SECURITY.md) — Güvenlik

**Security team için:**
1. [SECURITY.md](SECURITY.md) — Güvenlik mimarisi
2. [NETWORK_EGRESS_FILTERING.md](NETWORK_EGRESS_FILTERING.md) — Network güvenlik
3. [WEBSOCKET-SERVER.md](WEBSOCKET-SERVER.md) — Server güvenliği

---

## 🔗 Dış Bağlantılar

- **GitHub Repo:** [agent-federation](../)
- **OpenClaw:** [openclaw.dev](https://openclaw.dev)
- **Discord:** [OpenClaw Community](https://discord.com/invite/clawd)

---

**🦀 Happy Federating!**
