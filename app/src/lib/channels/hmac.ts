import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHmac(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
  prefix = '',
): boolean {
  if (!signatureHeader) return false;
  if (prefix && !signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  if (!/^[a-fA-F0-9]{64}$/.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
