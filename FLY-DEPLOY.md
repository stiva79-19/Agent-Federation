# 🚀 Fly.io Deploy Rehberi

Agent Federation sunucunu Fly.io'ya deploy ederek dünyanın her yerinden erişilebilir yap.

## Neden Fly.io?

- **Ücretsiz katman** cömert (3 shared-cpu VM, 256MB her biri — biz 512MB kullanıyoruz, o da ücretsiz sınırda)
- **WebSocket** desteği native — Agent Federation'ın kalbi
- **Global edge** — ABD, Avrupa, Asya'dan düşük latency
- **HTTPS** otomatik (Let's Encrypt)
- **Auto-stop/start** — trafik yoksa makine kapanır, istek geldiğinde otomatik açılır (ücret düşer)

## Ön hazırlık

### 1. flyctl kur

```bash
# macOS
brew install flyctl

# veya doğrudan script
curl -L https://fly.io/install.sh | sh
```

### 2. Fly hesabı aç

```bash
fly auth signup    # yeni hesap
# veya
fly auth login     # mevcut hesap
```

Fly.io kredit kartı ister (ama ücretsiz katmanı aşmazsan ücret almaz).

## Deploy

### 3. İlk launch

Proje kökünden:

```bash
cd ~/.openclaw/workspace/projects/agent-federation
fly launch --no-deploy --copy-config
```

flyctl soracak:

- **App name:** `agent-federation` (veya benzersiz bir isim — alınmışsa suffix ekle: `agent-federation-ali`)
- **Organization:** kişisel hesabın
- **Region:** `iad` (Washington DC) önerilir, ama en yakın region seç
- **PostgreSQL/Redis:** hayır (in-memory state yeterli)

`--copy-config` flag'i bizim `fly.toml`'u olduğu gibi kullanır, sadece `app` adını günceller.

### 4. Deploy

```bash
fly deploy
```

İlk build 2-3 dakika sürer (Docker image build edilir). Sonraki deploy'lar 30 saniye.

Başarılı olunca şöyle bir çıktı görürsün:

```
==> Successfully deployed!
Visit your newly deployed app at https://agent-federation.fly.dev/
```

### 5. Test et

```bash
# Health check
curl https://agent-federation.fly.dev/health

# Dashboard
open https://agent-federation.fly.dev
```

Dashboard açıldığında her kullanıcı kendi LLM API key'ini sağ paneldeki ayarlardan girer.

## LLM yapılandırması (opsiyonel)

Kullanıcılar kendi API key'lerini dashboard'dan girebilir. Ama sen paylaşılan bir LLM endpoint'i ayarlamak istersen:

```bash
fly secrets set \
  AGENT_LLM_BASE_URL=https://api.openai.com/v1 \
  AGENT_LLM_API_KEY=sk-... \
  AGENT_LLM_MODEL=gpt-4o-mini
```

Secret eklenince app otomatik restart olur.

## Operasyon

### Log'ları izle

```bash
fly logs
```

### Server durumu

```bash
fly status
```

### Restart

```bash
fly deploy --strategy immediate
```

### Makine boyutunu büyüt (gerekirse)

```bash
fly scale memory 1024
fly scale vm shared-cpu-2x
```

### Hibernate'den çıkar (elle)

```bash
fly machine start
```

### Durdur (ücret durdur)

```bash
fly scale count 0
```

## 3 Kıtadan 3 Kullanıcı — Test Senaryosu

Deploy sonrası:

1. 🇺🇸 ABD'deki kullanıcı tarayıcıda `https://agent-federation.fly.dev` açar
2. 🇮🇹 İtalya'daki kullanıcı aynı URL'i açar
3. 🇬🇧 İngiltere'deki kullanıcı aynı URL'i açar

Her biri kendi LLM key'ini girer. ABD'li davet oluşturur (örn. `AF-ABC123`), kodu İtalya'ya paylaşır, İtalya'dan bağlanır. İki agent konuşmaya başlar.

**Maksimum 7 agent** eşzamanlı bağlanabilir (`MAX_CONNECTED_AGENTS`).

## Önemli Notlar

- **State in-memory:** davet kodları, eşleşmeler ve sandbox dosyaları makine restart'ında kaybolur. Kalıcılık istersen Fly volume ekle (bu demo için gerek yok).
- **Auto-stop:** 5 dakika trafik yoksa makine durur. Sonraki istekte 1-2 saniye cold start olur. Bu ücreti minimize eder.
- **Tek makine:** şu an tek bir Fly machine çalışır. P2P eşleştirmeler in-memory olduğu için birden fazla replica kullanmak state'i böler. Ölçekleme ihtiyacı olduğunda federation bridge protokolü gerekecek (roadmap'te).
- **Logs:** audit log JSONL formatında ephemeral. Kalıcılık istersen volume veya Fly Logs → Datadog/Grafana'ya forward et.

## Sorun giderme

**Deploy hata veriyor:** `fly logs` ile detayı gör. En yaygın: `npm ci` dep uyuşmazlığı → `package-lock.json` commit edilmiş mi kontrol et.

**WebSocket bağlanmıyor:** `fly.toml`'da `force_https = true` olduğundan dashboard tarayıcıdan `wss://` kullanır. Dashboard.js otomatik doğru protokolü seçer.

**Health check fail:** `/health` endpoint cevap vermiyor demek. Logs'ta crash var mı bak.

---

**Kısa versiyon:**
```bash
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config
fly deploy
```
