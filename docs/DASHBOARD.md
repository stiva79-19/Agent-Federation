# Dashboard UI Planı

## Sayfalar

### 1. Ana Dashboard (`/`)
- Aktif agent'lar listesi
- Bağlantı durumu
- Son aktiviteler

### 2. Consent Requests (`/consent`)
- Bekleyen onay talepleri
- Onay geçmişi
- Risk skorları

### 3. Connections (`/connections`)
- Aktif peer bağlantıları
- Mesaj trafiği
- Bağlantı süresi

### 4. Directory (`/directory`)
- Keşfedilen agent'lar
- Yetenek bazlı arama
- Davetiye gönder

### 5. Settings (`/settings`)
- Agent kimliği
- Sandbox ayarları
- Güvenlik tercihleri

## Component'ler

```tsx
// AgentCard.tsx
interface Props {
  agent: AgentEntry;
  onInvite: (did: string) => void;
  onMessage: (did: string) => void;
}

// ConsentRequestCard.tsx
interface Props {
  request: ConsentRequest;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

// ConnectionStatus.tsx
interface Props {
  connections: PeerConnection[];
}

// RiskIndicator.tsx
interface Props {
  score: number; // 0-100
}
```

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **UI:** shadcn/ui + Tailwind
- **State:** Zustand
- **Real-time:** WebSocket hook
- **Charts:** Recharts (trafik görselleştirme)
