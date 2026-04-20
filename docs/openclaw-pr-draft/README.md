# OpenClaw PR Draft — `feat/identity-llm-methods`

Bu klasör, `openclaw/openclaw` reposuna gönderilecek PR'ın **agent-federation tarafında hazırlanmış taslağıdır**.

Phase 1a kapsamı: **sadece `identity.get` metodu.** `llm.chat` Phase 1b'ye bırakıldı — bu sayede ship tempo'su hızlı kalır, API key bağımsızlık borcu açıkça belgelenir.

---

## Klasör yapısı

```
docs/openclaw-pr-draft/
└─ src/gateway/server-methods/
   ├─ identity.ts          ← yeni handler
   └─ identity.test.ts     ← unit testler
```

Bu yol openclaw'daki yola **birebir eşleşir**.

---

## PR adımları (Ali'nin yapacağı)

1. **Fork'u hazırla**
   ```bash
   gh repo fork openclaw/openclaw --clone=true
   cd openclaw
   git checkout -b feat/identity-llm-methods
   ```

2. **İki dosyayı kopyala**
   ```bash
   cp /path/to/agent-federation/docs/openclaw-pr-draft/src/gateway/server-methods/identity.ts \
      src/gateway/server-methods/identity.ts
   cp /path/to/agent-federation/docs/openclaw-pr-draft/src/gateway/server-methods/identity.test.ts \
      src/gateway/server-methods/identity.test.ts
   ```

3. **Handler registration noktasını bul**
   `healthHandlers` nerede import ediliyorsa, `identityHandlers`'ı da aynı yere ekle. Muhtemelen şu desende bir merge var:
   ```bash
   grep -r "healthHandlers" src/gateway/
   ```
   Çıkan dosyada:
   ```typescript
   import { healthHandlers } from "./server-methods/health.js";
   import { identityHandlers } from "./server-methods/identity.js"; // yeni

   const handlers: GatewayRequestHandlers = {
     ...healthHandlers,
     ...cronHandlers,
     ...identityHandlers,   // yeni
     // ...
   };
   ```

4. **Testleri çalıştır**
   ```bash
   npm test -- identity.test
   ```
   Beş test de yeşil olmalı.

5. **Tip kontrolü**
   ```bash
   npm run build   # veya tsc --noEmit
   ```

6. **Commit + push**
   ```bash
   git add src/gateway/server-methods/identity.ts \
           src/gateway/server-methods/identity.test.ts \
           <handler-merge-file>
   git commit -m "feat(gateway): add identity.get method for external clients

   Allows clients like agent-federation to fetch the local agent's
   identity (IDENTITY.md + SOUL.md) through Gateway RPC instead of
   reading files directly from ~/.openclaw/workspace. Keeps the
   workspace as the single source of truth and lets OpenClaw
   mediate access.

   Returns parsed frontmatter fields (name, did, emoji, creature,
   vibe) plus raw file contents for callers that need to build
   system prompts. Gracefully handles missing workspace or missing
   IDENTITY.md with { available: false, reason }."
   git push origin feat/identity-llm-methods
   ```

7. **PR aç**
   ```bash
   gh pr create \
     --repo openclaw/openclaw \
     --title "feat(gateway): add identity.get method" \
     --body-file docs/openclaw-pr-draft/PR_BODY.md
   ```

---

## `identity.get` sözleşmesi

**Request** — parametre yok.

**Response** (success):
```json
{
  "available": true,
  "workspacePath": "/home/user/.openclaw/workspace",
  "name": "Mr Claw",
  "did": "did:claw:mrclaw",
  "emoji": "🦀",
  "creature": "Crab",
  "vibe": "Security-first engineer",
  "identityRaw": "---\nname: ...\n---\n\n# Mr Claw\n...",
  "soulRaw": "# Soul\n\n..."
}
```

**Response** (workspace/dosya yok):
```json
{
  "available": false,
  "reason": "no_workspace",
  "workspacePath": "/home/user/.openclaw/workspace"
}
```

Hata kodları: yalnızca kritik sistem hatalarında `errorShape(ErrorCodes.UNAVAILABLE, ...)`. Eksik dosya "error" değildir — `available: false` ile graceful dönülür.

---

## Phase 1b (sonra)

Bu PR merge + release olduktan sonra `llm.chat` + streaming event'leri için ikinci bir PR hazırlanacak. O PR OpenClaw'ın mevcut iç LLM client'ını sarmalayarak API key'lerin agent-federation'a hiç inmemesini sağlar.
