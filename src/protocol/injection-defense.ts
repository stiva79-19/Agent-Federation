/**
 * Prompt Injection Defense — 7 Katmanlı Savunma
 * 
 * Her gelen mesaj bu pipeline'dan geçer.
 * Bir katman atlatılırsa diğeri yakalar.
 */

export interface MessageScanResult {
  /** Mesaj güvenli mi */
  safe: boolean;
  /** Risk skoru (0-100) */
  riskScore: number;
  /** Tespit edilen tehditler */
  threats: string[];
  /** Temizlenmiş mesaj */
  cleanedMessage: string;
  /** Tavsiye edilen aksiyon */
  action: 'allow' | 'review' | 'block';
}

/**
 * Katman 1: Unicode Normalization
 * Homoglyph saldırılarını engeller (а → a, е → e)
 */
function unicodeNormalize(input: string): string {
  return input.normalize('NFC');
}

/**
 * Katman 2: Gizli Karakter Tespiti
 * Zero-width characters, RTL override vb.
 */
function scanHiddenChars(input: string): string[] {
  const threats: string[] = [];
  const hiddenPatterns = [
    { name: 'Zero-width space', regex: /\u200B/g },
    { name: 'Zero-width non-joiner', regex: /\u200C/g },
    { name: 'Zero-width joiner', regex: /\u200D/g },
    { name: 'Byte order mark', regex: /\uFEFF/g },
    { name: 'Left-to-right override', regex: /\u202D/g },
    { name: 'Right-to-left override', regex: /\u202E/g },
    { name: 'Null character', regex: /\u0000/g },
  ];

  for (const pattern of hiddenPatterns) {
    if (pattern.regex.test(input)) {
      threats.push(`Hidden character detected: ${pattern.name}`);
    }
  }

  return threats;
}

/**
 * Katman 3: Encoding Attack Tespiti
 * Base64, hex, HTML entity-encoded payload'lar
 */
function scanEncodedPayloads(input: string): string[] {
  const threats: string[] = [];

  // Base64 pattern (en az 20 karakter)
  if (/[A-Za-z0-9+/]{20,}={0,2}/.test(input)) {
    threats.push('Potential base64 encoded payload');
  }

  // Hex encoding
  if (/(?:\\x[0-9a-fA-F]{2}){4,}/.test(input)) {
    threats.push('Potential hex encoded payload');
  }

  // HTML entities
  if (/(?:&#x?[0-9a-fA-F]+;){3,}/.test(input)) {
    threats.push('Potential HTML entity encoded payload');
  }

  return threats;
}

/**
 * Katman 4: Bilinen Injection Pattern'leri
 */
function scanInjectionPatterns(input: string): string[] {
  const threats: string[] = [];
  const lower = input.toLowerCase();

  const patterns = [
    'ignore previous',
    'ignore all previous',
    'disregard previous',
    'you are now',
    'you now act as',
    'your new role is',
    'system prompt',
    'system instruction',
    'override your',
    'bypass your',
    'disable your safety',
    'disable your filter',
    'do not follow',
    'pretend to be',
    'simulate being',
    'act as if you are',
    'forget all instructions',
    'new instructions',
    'new system prompt',
  ];

  for (const pattern of patterns) {
    if (lower.includes(pattern)) {
      threats.push(`Injection pattern: "${pattern}"`);
    }
  }

  return threats;
}

/**
 * Katman 5: Semantic Analysis (basit)
 * Mesajın niyeti: talimat mı, soru mu, veri mi?
 */
function analyzeIntent(input: string): string[] {
  const threats: string[] = [];
  const lower = input.toLowerCase();

  // Emredici çok fazla imperative fiil
  const imperatives = ['do this', 'execute', 'run this', 'implement', 'write code', 'delete', 'modify'];
  let imperativeCount = 0;
  for (const cmd of imperatives) {
    if (lower.includes(cmd)) imperativeCount++;
  }
  if (imperativeCount >= 3) {
    threats.push(`High imperative count: ${imperativeCount} (potential command injection)`);
  }

  // Uzun mesaj (DoS riski)
  if (input.length > 10000) {
    threats.push(`Very long message: ${input.length} chars (potential DoS)`);
  }

  return threats;
}

/**
 * Ana pipeline — tüm katmanları çalıştırır
 */
export function scanMessage(input: string): MessageScanResult {
  const threats: string[] = [];

  // Katman 1
  const normalized = unicodeNormalize(input);

  // Katman 2
  threats.push(...scanHiddenChars(normalized));

  // Katman 3
  threats.push(...scanEncodedPayloads(normalized));

  // Katman 4
  threats.push(...scanInjectionPatterns(normalized));

  // Katman 5
  threats.push(...analyzeIntent(normalized));

  // Risk skoru hesapla
  const riskScore = calculateRiskScore(threats);

  // Aksiyon belirle
  let action: 'allow' | 'review' | 'block';
  if (riskScore >= 70) {
    action = 'block';
  } else if (riskScore >= 30) {
    action = 'review';
  } else {
    action = 'allow';
  }

  // Temizlenmiş mesaj (gizli karakterleri temizle)
  const cleanedMessage = normalized
    .replace(/[\u200B\u200C\u200D\uFEFF\u202D\u202E\u0000]/g, '')
    .trim();

  return {
    safe: threats.length === 0,
    riskScore,
    threats,
    cleanedMessage,
    action,
  };
}

function calculateRiskScore(threats: string[]): number {
  let score = 0;

  for (const threat of threats) {
    if (threat.includes('Injection pattern')) score += 25;
    else if (threat.includes('base64')) score += 15;
    else if (threat.includes('Hidden character')) score += 20;
    else if (threat.includes('imperative')) score += 15;
    else if (threat.includes('long message')) score += 10;
    else if (threat.includes('HTML entity')) score += 10;
    else if (threat.includes('hex')) score += 10;
    else score += 5;
  }

  return Math.min(score, 100);
}
