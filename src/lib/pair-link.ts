/**
 * Pairing QR / deep-link helpers. The QR encodes a deep link (scheme from
 * app.json) so system camera apps can open ZapFile directly; the in-app
 * scanner additionally accepts a raw pairing code.
 */

export function buildPairLink(code: string): string {
  return `zapfileapp://?pair=${encodeURIComponent(code)}`;
}

/** Extract a pairing code from scanned QR data (pair link or raw code). */
export function extractPairCode(data: string): string | null {
  const trimmed = data.trim();
  const match = trimmed.match(/[?&]pair=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]).trim().toUpperCase();
  if (/^[A-Z0-9-]{4,16}$/i.test(trimmed)) return trimmed.toUpperCase();
  return null;
}
