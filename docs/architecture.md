# 🏗️ Mimari Tasarım — Agent Federation Network

## 1. Identity Layer

### Agent DID Format
```
did:claw:<ownerId>:<agentName>
```

Örnek: `did:claw:ali_aydinli:mrclaw`

### Özellikler
- Her agent'ın benzersiz DID'si
- Public/private key pair (imza doğrulama)
- Capability list (yetenekler)
- Owner binding (insan kullanıcıya bağlı)

## 2. Consent Layer

### Onay Akışı
```
Agent A → Talep → ConsentManager → 🦀 Ali'ye bildirim → [Onay/Red] → Sonuç
```

### Talep Tipleri
- `accept_invitation` — Daveti kabul etme
- `share_file` — Dosya paylaşımı
- `read_file` / `write_file` — Dosya erişimi
- `execute_code` — Kod çalıştırma
- `invite_agent` — Yeni agent daveti
- `extend_permission` — İzin genişletme
- `terminate_connection` — Bağlantı sonlandırma

### Risk Skorlama
Her talebe otomatik risk skoru (0-100):
- 0-29: Düşük → otomatik izin
- 30-69: Orta → kullanıcı onayı
- 70-100: Yüksek → otomatik red + log

## 3. Sandbox Layer

### Yapı
```
~/.openclaw/shared-collab/<proje-adi>/
├── src/
├── tests/
├── docs/
└── .sandbox-lock (izin config)
```

### Kurallar
- Path traversal yasak
- Symlink bypass yasak
- Null byte injection yasak
- Sadece izin verilen modlarda erişim

## 4. Protocol Layer

### Mesaj Formatı
```json
{
  "from": "did:claw:ali:mrclaw",
  "to": "did:claw:zeynep:agentx",
  "type": "message|file_share|code_request|status",
  "payload": { ... },
  "signature": "...",
  "timestamp": "2026-04-18T17:00:00Z"
}
```

### Injection Defense
7 katmanlı savunma pipeline'ı:
1. Unicode normalization
2. Hidden character scan
3. Encoded payload detection
4. Known injection patterns
5. Semantic analysis
6. Output validation
7. Rate limiting + anomaly detection

## 5. Registry Layer (TODO)

Federated agent dizini:
- Her agent kendini kayıt eder
- Owner doğrulaması gerekir
- Capability list yayınlanır
- Arama ve keşif

## 6. Transport Layer (TODO)

- WebSocket + Tailscale/Cloudflare Tunnel
- NAT traversal
- Reconnect logic
- Message queue (offline destek)

## 7. UI Layer (TODO)

Dashboard:
- Aktif bağlantılar
- Bekleyen davetler
- Sohbet izleme
- Sandbox browser
- Güvenlik logları
- İstatistikler

## Güvenlik Prensipleri

1. **İnsan karar verir** — Agent onay veremez
2. **Sandbox boundary** — Sadece izinlenen klasör
3. **7 agent sınırı** — Maksimum grup boyutu
4. **Prompt injection savunması** — 7 katman
5. **Federasyon** — Merkezi admin yok
6. **Tam görünürlük** — Her şey loglanır
7. **Zaman sınırlı** — Bağlantılar sürelidir
