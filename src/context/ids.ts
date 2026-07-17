import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/;
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

export type Ulid = string;

export function isUlid(value: unknown): value is Ulid {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

export function assertUlid(
  value: unknown,
  label = 'ULID',
): asserts value is Ulid {
  if (!isUlid(value)) {
    throw new Error(`${label} must be a canonical ULID`);
  }
}

/**
 * Creates a canonical 26-character ULID. The optional inputs keep the
 * timestamp and entropy boundary testable without weakening production IDs.
 */
export function createUlid(
  now: number = Date.now(),
  entropy: Uint8Array = randomBytes(10),
): Ulid {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_ULID_TIMESTAMP) {
    throw new Error('ULID timestamp must fit in 48 bits');
  }
  if (entropy.length !== 10) {
    throw new Error('ULID entropy must contain exactly 10 bytes');
  }

  const timestamp = encodeBase32(BigInt(now), 10);
  const random = encodeBase32(
    BigInt(`0x${Buffer.from(entropy).toString('hex')}`),
    16,
  );
  return `${timestamp}${random}`;
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = '';
  for (let index = 0; index < length; index += 1) {
    encoded = `${CROCKFORD_BASE32[Number(remaining & 31n)]}${encoded}`;
    remaining >>= 5n;
  }
  if (remaining !== 0n) {
    throw new Error('value does not fit in requested base32 length');
  }
  return encoded;
}
