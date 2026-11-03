import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed one-click "Acknowledge" links for alerts. The signature covers the flag
 * id, so a link can only acknowledge the flag it was sent for.
 */
export function ackSignature(secret: string, flagId: number): string {
  return createHmac('sha256', secret).update(`ack:${flagId}`).digest('base64url').slice(0, 32);
}

export function ackUrl(baseUrl: string, secret: string, flagId: number): string {
  return `${baseUrl.replace(/\/$/, '')}/ack/${flagId}?sig=${ackSignature(secret, flagId)}`;
}

export function verifyAck(secret: string, flagId: number, sig: string): boolean {
  const expected = Buffer.from(ackSignature(secret, flagId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
