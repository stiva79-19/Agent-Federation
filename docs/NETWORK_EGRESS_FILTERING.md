# Network Egress Filtering

Agent Federation'da agent'ların network erişimini güvenli hale getirmek için domain whitelist ve private IP blocking sistemi.

## 🎯 Özellikler

### 1. Domain Whitelist
- Sadece izin verilen domain'lere HTTP/HTTPS erişimi
- Wildcard desteği (`*.example.com`)
- Blacklist desteği (whitelist'te olsa bile engelle)
- Case-insensitive domain matching

### 2. Private IP Blocking
- Loopback addresses (127.x.x.x, ::1)
- Private Class A (10.x.x.x)
- Private Class B (172.16.x.x - 172.31.x.x)
- Private Class C (192.168.x.x)
- Link-local (169.254.x.x, fe80::)
- IPv6 unique local (fc00::, fd00::)

### 3. DNS Rebinding Protection
- DNS lookup interception
- Çözümlenen IP'lerin whitelist/blacklist kontrolü
- Private IP'lere otomatik erişim engelleme

### 4. Consent Layer Entegrasyonu
- `execute_code_with_network` action tipi
- `network_request` action tipi
- Risk skoru hesaplama (network erişimine göre)
- İnsan onayı gerektiren network istekleri

## 📦 Kullanım

### Temel Kullanım

```typescript
import { NetworkEgressFilter, secureConfig } from './security/network-egress-filter';

// Güvenli varsayılan yapılandırma
const filter = new NetworkEgressFilter(secureConfig());

// URL validate
const validation = filter.validateUrl('https://api.example.com/data');
if (validation.allowed) {
  // İstek yap
  const response = await filter.fetch('https://api.example.com/data');
} else {
  console.error('Blocked:', validation.reason);
}
```

### Custom Whitelist

```typescript
const filter = new NetworkEgressFilter({
  allowedDomains: [
    'api.myapp.com',
    '*.openai.com',        // Wildcard subdomain
    'github.com',
    'registry.npmjs.org',
  ],
  blockedDomains: [
    'malicious.com',       // Whitelist'te olsa bile engelle
  ],
  allowPrivateIPs: false,  // Private IP'lere erişim yok
  allowedPorts: [80, 443], // Sadece bu port'lar
  interceptDNS: true,      // DNS lookup'ı intercept et
});
```

### WebSocket Server ile Entegrasyon

```typescript
import { WebSocketServerManager } from './server/ws-server';
import { secureConfig } from './security/network-egress-filter';

const server = new WebSocketServerManager({
  port: 18790,
  ssl: true,
  networkConfig: {
    allowedDomains: ['api.example.com', '*.openai.com'],
    allowPrivateIPs: false,
  },
});

await server.start();

// Network filter'a erişim
const networkFilter = server.getNetworkFilter();

// Güvenli network request
const response = await server.secureNetworkRequest(
  'did:agent:test123',
  'https://api.example.com/data',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test' }),
  }
);
```

### Execute Code ile Network Erişimi

```typescript
import { ConsentManager } from './consent/consent';

const consentManager = new ConsentManager();

// Code execution with network access consent
const consentResult = await server.requestExecuteCodeConsent(
  'did:agent:test123',
  'console.log(fetch("https://api.example.com"))',
  {
    requiresNetwork: true,
    networkUrls: ['https://api.example.com'],
  }
);

console.log('Risk Score:', consentResult.riskScore);
console.log('Consent Required:', consentResult.consentRequired);
console.log('Request ID:', consentResult.requestId);

// İnsan onayı bekle...
// Consent manager üzerinden onay durumu kontrol edilir
```

## ⚠️ Risk Skorları

Network erişimi içeren işlemler için risk skorları:

| Action | Base Risk | Açıklama |
|--------|-----------|----------|
| `read_file` | 10 | Düşük risk |
| `network_request` | 50 | Orta risk |
| `execute_code` | 60 | Yüksek risk |
| `execute_code_with_network` | 80 | Çok yüksek risk |

### Risk Artış Faktörleri

- **POST/PUT/DELETE method**: +15
- **Request body**: +10
- **5'ten fazla URL**: +20
- **Private IP erişim denemesi**: +30
- **Path traversal denemesi**: +40

## 🧪 Test

```bash
cd projects/agent-federation
npm test -- network-egress-filter
npm test -- consent-network
```

### Test Kapsamı

1. **Domain Whitelist Tests**
   - Exact domain match
   - Wildcard subdomain matching
   - Blacklist enforcement
   - Case insensitivity

2. **Private IP Blocking Tests**
   - All private IP ranges
   - IPv6 addresses
   - Link-local addresses
   - Public IP allowance

3. **URL Validation Tests**
   - Protocol filtering (HTTP/HTTPS only)
   - Port restrictions
   - Invalid URL handling

4. **Consent Integration Tests**
   - Risk calculation with network access
   - Consent request/response flow
   - High-risk scenario detection

## 🔒 Güvenlik Best Practices

### 1. Minimal Whitelist
```typescript
// ❌ Kötü - Çok geniş izinler
allowedDomains: ['*']

// ✅ İyi - Spesifik domain'ler
allowedDomains: ['api.example.com', '*.openai.com']
```

### 2. Private IP Blocking
```typescript
// ❌ Kötü - Private IP'lere izin
allowPrivateIPs: true

// ✅ İyi - Private IP'leri engelle (production)
allowPrivateIPs: false
```

### 3. Port Restrictions
```typescript
// ❌ Kötü - Tüm port'lar
allowedPorts: []

// ✅ İyi - Sadece gerekli port'lar
allowedPorts: [80, 443]
```

### 4. DNS Interception
```typescript
// ✅ Her zaman aktif tut
interceptDNS: true
```

## 📊 Audit Logging

Tüm network erişim denemeleri audit log'a kaydedilir:

- `network_access_requested` - İnsan onayı istendi
- `network_access_blocked` - Whitelist/blacklist nedeniyle engellendi
- `network_access_success` - Başarılı erişim
- `network_access_error` - Hata oluştu
- `consent_auto_rejected` - Yüksek risk nedeniyle otomatik reddedildi

```typescript
// Audit log örneği
{
  eventType: 'network_access_blocked',
  agentDid: 'did:agent:test123',
  details: {
    url: 'http://192.168.1.1/admin',
    reason: 'Domain not in whitelist: 192.168.1.1',
  },
  severity: 'high',
  timestamp: '2026-04-18T19:23:00.000Z',
}
```

## 🚀 Production Deployment

Production ortamında network egress filtering aktif olmalıdır:

```typescript
const server = new WebSocketServerManager({
  port: 18790,
  ssl: true,
  certPath: '/path/to/cert.pem',
  keyPath: '/path/to/key.pem',
  
  // Production network config
  networkConfig: secureConfig(),
});
```

### Environment Variables

```bash
# İzin verilen domain'ler (comma-separated)
AGENT_NETWORK_WHITELIST=api.example.com,*.openai.com,github.com

# Private IP erişimi (default: false)
AGENT_ALLOW_PRIVATE_IPS=false

# İzin verilen port'lar (comma-separated)
AGENT_ALLOWED_PORTS=80,443
```

## 📝 Notlar

- Network egress filtering **default olarak aktiftir**
- Private IP blocking production'da **asla devre dışı bırakılmamalıdır**
- Her network erişimi **audit log**'a kaydedilir
- Yüksek riskli işlemler (risk >= 90) **otomatik reddedilir**
- Consent timeout süresi network istekleri için **2 dakika**, code execution için **5 dakika**
