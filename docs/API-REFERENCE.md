# 📡 Agent Federation — API Reference

**Tüm modüller, fonksiyonlar ve tipler.**

---

## 📋 İçindekiler

1. [Identity Module](#identity-module)
2. [Consent Module](#consent-module)
3. [Sandbox Module](#sandbox-module)
4. [Protocol Module](#protocol-module)
5. [Transport Module](#transport-module)
6. [Server Module](#server-module)
7. [Security Module](#security-module)
8. [Registry Module](#registry-module)
9. [Audit Logger](#audit-logger)
10. [Types](#types)

---

## 🆔 Identity Module

**Dosya:** `src/identity/agent.ts`

Agent kimliği (DID) oluşturma ve yönetimi.

### `generateAgentDID()`

Agent için benzersiz DID oluşturur.

```typescript
function generateAgentDID(ownerId: string, agentName: string): string
```

**Parametreler:**
- `ownerId` (string) — Sahip kullanıcı ID (alphanumeric + underscore)
- `agentName` (string) — Agent adı (alphanumeric + underscore)

**Döndürür:** `string` — DID format: `did:claw:<ownerId>:<agentName>`

**Örnek:**
```typescript
import { generateAgentDID } from './src/identity/agent';

const did = generateAgentDID('ali', 'mrclaw');
// "did:claw:ali:mrclaw"
```

---

### `parseDID()`

DID'yi parse eder ve bileşenlerini çıkarır.

```typescript
function parseDID(did: string): { ownerId: string; agentName: string } | null
```

**Parametreler:**
- `did` (string) — Parse edilecek DID

**Döndürür:** Object veya `null` (geçersiz DID)

**Örnek:**
```typescript
import { parseDID } from './src/identity/agent';

const result = parseDID('did:claw:ali:mrclaw');
// { ownerId: 'ali', agentName: 'mrclaw' }

const invalid = parseDID('invalid-did');
// null
```

---

### `validateDID()`

DID formatını doğrular.

```typescript
function validateDID(did: string): boolean
```

**Döndürür:** `boolean` — Geçerli ise `true`

---

### `createInvitation()`

Başka agent'a göndermek için davetiye oluşturur.

```typescript
function createInvitation(
  ownerName: string,
  toIdentifier: string,
  purpose: string,
  sandboxPath: string,
  permissions: Permission[],
  durationHours: number
): AgentInvitation
```

**Parametreler:**
- `ownerName` (string) — Davetiye gönderen sahibi adı
- `toIdentifier` (string) — Hedef agent DID
- `purpose` (string) — Davetiye amacı
- `sandboxPath` (string) — Sandbox klasör yolu
- `permissions` (Permission[]) — İzinler: `['read', 'write', 'execute']`
- `durationHours` (number) — Davetiye süresi (saat)

**Döndürür:** `AgentInvitation`

**Örnek:**
```typescript
import { createInvitation } from './src/identity/agent';

const invitation = createInvitation(
  'Ali',
  'did:claw:zeynep:owl',
  'Code collaboration',
  '/tmp/shared-project',
  ['read', 'write'],
  168  // 7 gün
);
```

---

### `AgentIdentity` Interface

```typescript
interface AgentIdentity {
  did: string;
  name: string;
  emoji: string;
  ownerName: string;
  ownerId: string;
  capabilities: string[];
  publicKey: string;
  createdAt: Date;
  lastSeen: Date;
}
```

---

## ✅ Consent Module

**Dosya:** `src/consent/consent.ts`

İnsan onayı yönetimi ve risk skoru hesaplama.

### `ConsentManager` Class

```typescript
class ConsentManager extends EventEmitter
```

#### `request()`

Yeni onay talebi oluşturur.

```typescript
request(request: ConsentRequest): ConsentRequest
```

**Parametreler:**
- `request` (ConsentRequest) — Onay talebi detayları

**Döndürür:** `ConsentRequest` — Oluşturulan talep

**Örnek:**
```typescript
import { ConsentManager } from './src/consent/consent';

const manager = new ConsentManager();

const request = manager.request({
  requesterDid: 'did:claw:zeynep:owl',
  action: 'read_file',
  details: { path: 'src/index.ts' },
  riskScore: 10,
  timeoutSeconds: 300,
});
```

---

#### `decide()`

Onay talebine karar verir (approve/reject).

```typescript
decide(decision: ConsentDecision): void
```

**Parametreler:**
- `decision` (ConsentDecision) — Karar detayları

**Örnek:**
```typescript
manager.decide({
  requestId: request.id,
  response: 'approved',  // veya 'rejected'
  decidedBy: 'human:ali',
  decidedAt: new Date(),
});
```

---

#### `getStatus()`

Onay talebi durumunu alır.

```typescript
getStatus(requestId: string): ConsentDecision | 'pending' | 'expired' | null
```

**Döndürür:** Karar durumu veya `null`

---

#### `getState()`

Tüm consent state'ini alır.

```typescript
getState(): {
  pending: ConsentRequest[];
  approved: ConsentRequest[];
  rejected: ConsentRequest[];
  expired: ConsentRequest[];
}
```

---

#### `calculateRisk()` (Static)

Otomatik risk skoru hesaplar.

```typescript
static calculateRisk(action: ConsentAction, details: any): number
```

**Döndürür:** `number` — Risk skoru (0-100)

**Örnek:**
```typescript
const risk = ConsentManager.calculateRisk('read_file', {
  path: 'src/index.ts'
});
// 10

const highRisk = ConsentManager.calculateRisk('execute_code', {
  command: 'rm -rf /',
  network: true
});
// 90+ (otomatik red)
```

---

### `ConsentRequest` Interface

```typescript
interface ConsentRequest {
  id: string;
  requesterDid: string;
  action: ConsentAction;
  details: any;
  riskScore: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  decidedAt?: Date;
  decidedBy?: string;
}
```

---

### `ConsentAction` Type

```typescript
type ConsentAction =
  | 'read_file'
  | 'write_file'
  | 'execute_code'
  | 'execute_code_with_network'
  | 'network_request'
  | 'share_file'
  | 'invite_agent'
  | 'accept_invitation'
  | 'extend_permission'
  | 'terminate_connection';
```

---

### Baz Risk Skorları

| Action | Baz Skor |
|--------|----------|
| `read_file` | 10 |
| `write_file` | 40 |
| `execute_code` | 60 |
| `execute_code_with_network` | 80 |
| `network_request` | 50 |
| `share_file` | 25 |
| `invite_agent` | 35 |

---

## 📁 Sandbox Module

**Dosya:** `src/sandbox/sandbox.ts`

Dosya sistemi izolasyonu ve path validation.

### `Sandbox` Class

```typescript
class Sandbox
```

#### `constructor()`

```typescript
constructor(projectName: string)
```

**Parametreler:**
- `projectName` (string) — Proje adı (sandbox klasörü adı)

**Örnek:**
```typescript
import { Sandbox } from './src/sandbox/sandbox';

const sandbox = new Sandbox('project-alpha');
// Sandbox root: ~/.openclaw/shared-collab/project-alpha
```

---

#### `validatePath()`

Path geçerliliğini doğrular.

```typescript
validatePath(filePath: string): { ok: boolean; error?: string }
```

**Döndürür:** Validation sonucu

**Örnek:**
```typescript
const result1 = sandbox.validatePath('src/index.ts');
// { ok: true }

const result2 = sandbox.validatePath('../../../etc/passwd');
// { ok: false, error: 'Path traversal detected' }

const result3 = sandbox.validatePath('/etc/passwd');
// { ok: false, error: 'Absolute paths not allowed' }
```

---

#### `checkAccess()`

Erişim iznini kontrol eder.

```typescript
checkAccess(
  filePath: string,
  mode: 'read' | 'write' | 'execute'
): { ok: boolean }
```

---

#### `isWithinSandbox()`

Path'in sandbox içinde olup olmadığını kontrol eder.

```typescript
isWithinSandbox(filePath: string): boolean
```

---

### `defaultSandbox()`

Varsayılan sandbox konfigürasyonu oluşturur.

```typescript
function defaultSandbox(projectName?: string): {
  rootPath: string;
  allowedPatterns: string[];
  deniedPatterns: string[];
}
```

---

## 🛡️ Protocol Module

**Dosya:** `src/protocol/injection-defense.ts`

Mesaj güvenliği ve injection defense.

### `scanMessage()`

Mesajı güvenlik taramasından geçirir.

```typescript
async function scanMessage(
  message: FederatedMessage
): Promise<ScanResult>
```

**Döndürür:** `ScanResult`

**Örnek:**
```typescript
import { scanMessage } from './src/protocol/injection-defense';

const result = await scanMessage({
  id: 'msg-123',
  from: 'did:claw:ali:mrclaw',
  to: 'did:claw:zeynep:owl',
  type: 'text',
  payload: 'Hello!',
  timestamp: new Date(),
  ttlSeconds: 300,
});

console.log(result.riskScore);  // 0-100
console.log(result.blocked);    // true/false
console.log(result.flags);      // ['pattern_detected', ...]
```

---

### `ScanResult` Interface

```typescript
interface ScanResult {
  riskScore: number;      // 0-100
  flags: string[];        // Tespit edilen sorunlar
  blocked: boolean;       // Engellendi mi?
  details: {
    unicodeNormalized: boolean;
    hiddenChars: string[];
    encodedPayload: boolean;
    injectionPatterns: string[];
    imperativeCount: number;
  };
}
```

---

### `InjectionDefense` Class

7 katmanlı savunma pipeline'ı.

```typescript
class InjectionDefense {
  normalize(message: string): string;
  detectHiddenChars(message: string): string[];
  detectEncodedPayload(message: string): boolean;
  detectInjectionPatterns(message: string): string[];
  semanticAnalysis(message: string): { imperativeCount: number };
  scan(message: string): ScanResult;
}
```

---

## 🔌 Transport Module

**Dosya:** `src/transport/websocket.ts`

WebSocket client ve mesajlaşma.

### `Transport` Class

```typescript
class Transport extends EventEmitter
```

#### `constructor()`

```typescript
constructor(config?: TransportConfig)
```

**Config:**
```typescript
interface TransportConfig {
  tailscaleEnabled: boolean;
  port: number;
  ssl: boolean;
  host?: string;
  debug?: boolean;
}
```

**Örnek:**
```typescript
import { Transport } from './src/transport/websocket';

const transport = new Transport({
  tailscaleEnabled: false,
  port: 18790,
  ssl: false,
  debug: true,
});
```

---

#### `connect()`

Server'a bağlanır.

```typescript
connect(): Promise<void>
```

---

#### `disconnect()`

Bağlantıyı keser.

```typescript
disconnect(): void
```

---

#### `send()`

Mesaj gönderir.

```typescript
send(message: FederatedMessage): Promise<void>
```

**Örnek:**
```typescript
await transport.send({
  id: crypto.randomUUID(),
  from: 'did:claw:ali:mrclaw',
  to: 'did:claw:zeynep:owl',
  type: 'text',
  payload: 'Hello!',
  timestamp: new Date(),
  ttlSeconds: 300,
});
```

---

#### `on()`

Event listener ekler.

```typescript
on(event: TransportEvent, handler: Function): void
```

**Eventler:**
- `connected` — Bağlantı başarılı
- `disconnected` — Bağlantı koptu
- `message` — Mesaj alındı
- `error` — Hata oluştu
- `heartbeat` — Heartbeat alındı

**Örnek:**
```typescript
transport.on('connected', () => {
  console.log('✅ Connected!');
});

transport.on('message', (message) => {
  console.log('📨 Received:', message);
});

transport.on('disconnected', () => {
  console.log('❌ Disconnected');
});
```

---

### `FederatedMessage` Interface

```typescript
interface FederatedMessage {
  id: string;
  from: string;              // Gönderen DID
  to: string;                // Alıcı DID veya 'broadcast'
  type: MessageType;
  payload: unknown;
  signature?: string;
  timestamp: Date;
  ttlSeconds: number;
}
```

---

### `MessageType` Type

```typescript
type MessageType =
  | 'text'
  | 'file'
  | 'invitation'
  | 'consent_request'
  | 'consent_response'
  | 'heartbeat';
```

---

## 🖥️ Server Module

**Dosya:** `src/server/ws-server.ts`

WebSocket server ve mesaj routing.

### `WebSocketServerManager` Class

```typescript
class WebSocketServerManager extends EventEmitter
```

#### `constructor()`

```typescript
constructor(config?: ServerConfig)
```

**Config:**
```typescript
interface ServerConfig {
  port: number;
  host?: string;
  ssl: boolean;
  certPath?: string;
  keyPath?: string;
  networkConfig?: NetworkEgressConfig;
}
```

**Örnek:**
```typescript
import { WebSocketServerManager } from './src/server/ws-server';
import { secureConfig } from './src/security/network-egress-filter';

const server = new WebSocketServerManager({
  port: 18790,
  ssl: true,
  certPath: '/path/to/cert.pem',
  keyPath: '/path/to/key.pem',
  networkConfig: secureConfig(),
});
```

---

#### `start()`

Server'ı başlatır.

```typescript
start(): Promise<void>
```

---

#### `stop()`

Server'ı durdurur.

```typescript
stop(): Promise<void>
```

---

#### `getConnections()`

Tüm bağlantıları listeler.

```typescript
getConnections(): ConnectionInfo[]
```

---

#### `getConnectionByDid()`

DID'ye göre bağlantı bulur.

```typescript
getConnectionByDid(did: string): ConnectionInfo | undefined
```

---

#### `getStats()`

Server istatistiklerini alır.

```typescript
getStats(): {
  totalConnections: number;
  uptime: number;
  connections: ConnectionInfo[];
}
```

---

#### `secureNetworkRequest()`

Güvenli network request yapar (whitelist kontrollü).

```typescript
secureNetworkRequest(
  agentDid: string,
  url: string,
  options?: RequestInit
): Promise<Response>
```

**Örnek:**
```typescript
const response = await server.secureNetworkRequest(
  'did:claw:ali:mrclaw',
  'https://api.github.com/repos',
  { method: 'GET' }
);
```

---

### Eventler

```typescript
server.on('agent_connected', (connection) => {
  console.log('Agent connected:', connection.did);
});

server.on('agent_disconnected', (data) => {
  console.log('Agent disconnected:', data.did);
});

server.on('message', (message) => {
  console.log('Message received:', message.id);
});

server.on('heartbeat', (heartbeat) => {
  console.log('Heartbeat:', heartbeat.payload);
});
```

---

## 🔒 Security Module

**Dosya:** `src/security/network-egress-filter.ts`

Network egress filtering ve domain whitelist.

### `NetworkEgressFilter` Class

```typescript
class NetworkEgressFilter
```

#### `constructor()`

```typescript
constructor(config?: NetworkEgressConfig)
```

**Config:**
```typescript
interface NetworkEgressConfig {
  allowlist: string[];       // İzin verilen domain'ler
  blocklist: string[];       // Engellenen domain'ler
  blockPrivateIPs: boolean;  // Private IP'leri engelle
  allowedPorts: number[];    // İzin verilen port'lar
}
```

---

#### `validateUrl()`

URL'in whitelist'e uygun olup olmadığını kontrol eder.

```typescript
validateUrl(url: string): Promise<{ ok: boolean; reason?: string }>
```

---

#### `fetch()`

Whitelist kontrollü HTTP request yapar.

```typescript
fetch(url: string, options?: RequestInit): Promise<Response>
```

---

#### `isPrivateIP()`

IP'nin private range'de olup olmadığını kontrol eder.

```typescript
isPrivateIP(ip: string): boolean
```

---

### `secureConfig()`

Güvenli varsayılan konfigürasyon oluşturur.

```typescript
function secureConfig(
  overrides?: Partial<NetworkEgressConfig>
): NetworkEgressConfig
```

**Örnek:**
```typescript
import { secureConfig, defaultAllowlist } from './src/security/network-egress-filter';

const config = secureConfig({
  allowlist: [...defaultAllowlist(), 'api.example.com'],
  blockPrivateIPs: true,
  allowedPorts: [443, 80],
});
```

---

### `defaultAllowlist()`

Varsayılan izin verilen domain'leri döndürür.

```typescript
function defaultAllowlist(): string[]
// ['api.openai.com', 'api.anthropic.com', 'api.github.com', ...]
```

---

### `createEgressFilteredAgent()`

Network-filtered HTTP agent oluşturur.

```typescript
function createEgressFilteredAgent(
  filter: NetworkEgressFilter
): http.Agent
```

---

## 📇 Registry Module

**Dosya:** `src/registry/directory.ts`

Agent keşif ve kayıt sistemi.

### `AgentDirectory` Class

```typescript
class AgentDirectory extends EventEmitter
```

#### `publish()`

Agent'ı dizine kaydeder.

```typescript
publish(entry: AgentEntry): AgentEntry
```

---

#### `discover()`

Agent keşif bildirimi yapar.

```typescript
discover(entry: AgentEntry): void
```

---

#### `query()`

Filtrelerle agent sorgular.

```typescript
query(filters: DirectoryQuery): AgentEntry[]
```

---

#### `findByDid()`

DID'ye göre agent bulur.

```typescript
findByDid(did: string): AgentEntry | undefined
```

---

#### `findByCapability()`

Yeteneğe göre agent bulur.

```typescript
findByCapability(capability: string, limit?: number): AgentEntry[]
```

---

### `AgentEntry` Interface

```typescript
interface AgentEntry {
  did: string;
  name: string;
  emoji: string;
  ownerName: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy';
  lastSeen: Date;
  endpoint?: string;  // WebSocket endpoint
}
```

---

## 📝 Audit Logger

**Dosya:** `src/server/audit-logger.ts`

Tüm işlemlerin loglanması.

### `AuditLogger` Class

```typescript
class AuditLogger
```

#### `constructor()`

```typescript
constructor(config?: AuditLoggerConfig)
```

**Config:**
```typescript
interface AuditLoggerConfig {
  logDir: string;
  rotationDays?: number;
  centralEndpoint?: string;
}
```

---

#### `log()`

Log entry oluşturur.

```typescript
log(event: AuditEvent, details: any): void
```

**Örnek:**
```typescript
import { AuditLogger } from './src/server/audit-logger';

const logger = new AuditLogger({ logDir: 'logs' });

logger.log('consent_requested', {
  action: 'read_file',
  path: 'src/index.ts',
  riskScore: 10,
});
```

---

### `AuditEvent` Type

```typescript
type AuditEvent =
  | 'agent_connected'
  | 'agent_disconnected'
  | 'message_sent'
  | 'message_blocked'
  | 'consent_requested'
  | 'consent_approved'
  | 'consent_rejected'
  | 'consent_auto_rejected'
  | 'network_access_requested'
  | 'network_access_blocked'
  | 'network_access_success'
  | 'network_access_error'
  | 'sandbox_violation'
  | 'connection_expired';
```

---

## 📦 Ana Export'lar

```typescript
// src/index.ts'den tüm export'lar
import {
  // Identity
  generateAgentDID,
  parseDID,
  validateDID,
  createInvitation,
  
  // Consent
  ConsentManager,
  
  // Sandbox
  Sandbox,
  defaultSandbox,
  
  // Protocol
  scanMessage,
  InjectionDefense,
  
  // Transport
  Transport,
  
  // Server
  WebSocketServerManager,
  
  // Security
  NetworkEgressFilter,
  secureConfig,
  defaultAllowlist,
  createEgressFilteredAgent,
  
  // Registry
  AgentDirectory,
  
  // Audit
  AuditLogger,
  
  // Types
  FederatedMessage,
  MessageType,
  ConsentRequest,
  ConsentAction,
  AgentEntry,
  AuditEvent,
} from './src/index';
```

---

## 🔗 İlgili Dokümantasyon

- **[Kullanım Rehberi](USAGE-GUIDE.md)** — Genel kullanım
- **[Quick Start](QUICKSTART.md)** — 5 dakikada başlangıç
- **[Güvenlik](SECURITY.md)** — Güvenlik mimarisi
- **[WebSocket Server](WEBSOCKET-SERVER.md)** — Server detayları

---

**📡 Happy Coding!**
