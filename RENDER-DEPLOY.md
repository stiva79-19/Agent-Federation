# Render.com Deploy Rehberi / Deploy Guide

Agent Federation relay sunucusunu Render.com'a deploy et.
Deploy the Agent Federation relay server to Render.com.

## Neden Render.com? / Why Render.com?

- **Ucretsiz plan** — kredi karti gerekmez (Free tier, no credit card required)
- **WebSocket destegi** — Agent Federation'in kalbi (native WebSocket support)
- **Otomatik HTTPS** — Let's Encrypt ile (automatic TLS)
- **GitHub entegrasyonu** — push'la otomatik deploy (auto-deploy on push)
- **Kolay kurulum** — 5 dakikada canli (live in 5 minutes)

> **Not / Note:** Render Free plan'da 15 dakika trafik yoksa servis uyur (spin down).
> Sonraki istekte ~30-50 saniye cold start olur. Bu beklenen davranistir.

---

## Hizli Deploy / Quick Deploy

### 1. Render.com'a giris yap / Sign in

[render.com](https://render.com) adresine git, **GitHub** ile giris yap veya yeni hesap ac.
Go to [render.com](https://render.com), sign in with **GitHub** or create a new account.

### 2. Yeni Web Service olustur / Create New Web Service

1. Dashboard'da **"New"** > **"Web Service"** tikla
2. GitHub repo'nu bagla: `stiva79-19/Agent-Federation`
3. Asagidaki ayarlari gir:

| Ayar / Setting       | Deger / Value                  |
|----------------------|-------------------------------|
| **Name**             | `agent-federation-relay`       |
| **Runtime**          | `Node`                         |
| **Build Command**    | `npm install`                  |
| **Start Command**    | `npx tsx relay-server.ts`      |
| **Plan**             | `Free`                         |

### 3. Environment Variables ekle / Add Environment Variables

"Environment" sekmesinde su degiskenleri ekle:

| Key                    | Value        |
|-----------------------|-------------|
| `RELAY_MODE`          | `true`       |
| `RELAY_MAX_ROOMS`     | `100`        |
| `RELAY_ROOM_TTL_HOURS`| `24`         |
| `NODE_ENV`            | `production` |

> **Not:** `PORT` ekleme — Render otomatik olarak `PORT` env var'ini atar (genelde 10000).
> `HOST` da gerekmez, Render `0.0.0.0` kullanir.

### 4. Deploy et / Deploy

**"Create Web Service"** butonuna tikla. Render:

1. Repo'yu clone'lar
2. `npm install` calistirir
3. `npx tsx relay-server.ts` ile servisi baslatir

Ilk build 2-3 dakika surer. Basarili olunca URL'ini alirsin:

```
https://agent-federation-relay.onrender.com
```

### 5. Test et / Test

```bash
# Health check
curl https://agent-federation-relay.onrender.com/health

# Beklenen cevap: {"status":"ok","uptime":...,"rooms":0}
```

### 6. Client'i yapilandir / Configure Client

`.env` dosyana (veya terminal'de) relay URL'ini ekle:

```bash
RELAY_URL=wss://agent-federation-relay.onrender.com
```

Veya baslatirken:

```bash
npx tsx start-server.ts --relay wss://agent-federation-relay.onrender.com
```

---

## Blueprint ile Deploy (Alternatif)

Repo'da `render.yaml` dosyasi var. Render Blueprint ile tek tikla deploy edebilirsin:

1. Render Dashboard > **"New"** > **"Blueprint"**
2. Repo'yu sec: `stiva79-19/Agent-Federation`
3. Render `render.yaml`'i okur ve servisi otomatik olusturur
4. **"Apply"** tikla

---

## LLM Yapilandirmasi / LLM Configuration

Kullanicilar kendi API key'lerini dashboard'dan girebilir. Paylasilan bir LLM endpoint ayarlamak istersen, Render Dashboard > Environment sekmesinden ekle:

| Key                  | Value                           |
|---------------------|--------------------------------|
| `AGENT_LLM_BASE_URL`| `https://api.openai.com/v1`    |
| `AGENT_LLM_API_KEY` | `sk-...`                       |
| `AGENT_LLM_MODEL`   | `gpt-4o-mini`                  |

---

## Operasyon / Operations

### Log'lari gor / View Logs

Render Dashboard > servis sayfasi > **"Logs"** sekmesi.

### Manuel deploy / Manual Deploy

Render Dashboard > **"Manual Deploy"** > **"Deploy latest commit"**.

### Restart

Render Dashboard > **"Manual Deploy"** > **"Clear build cache & deploy"**.

---

## Sorun Giderme / Troubleshooting

**Build basarisiz:** Render Logs'tan hatayi kontrol et. En yaygin: `npm install` dep uyusmazligi — `package-lock.json`'in commit edilmis oldugundan emin ol.

**WebSocket baglanmiyor:** Render otomatik HTTPS/WSS saglar. Client tarafinda `wss://` kullandigindan emin ol (`ws://` degil).

**Health check fail:** `/health` endpoint cevap vermiyor. Logs'ta crash var mi kontrol et.

**Cold start yavasi:** Free plan'da servis 15 dakika inaktif kalinca uyur. Ilk istekte 30-50 saniye bekle. Surekli calismasini istersen Starter plan'a ($7/ay) gec.

---

**Kisa versiyon / TL;DR:**

```
1. render.com > GitHub ile giris
2. New > Web Service > repo sec
3. Build: npm install | Start: npx tsx relay-server.ts | Plan: Free
4. Create Web Service
5. URL'i al: wss://agent-federation-relay.onrender.com
```
