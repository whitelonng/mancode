export type CapabilityLevel = 'enforced' | 'advisory' | 'unavailable';
export type Freshness = 'fresh' | 'stale' | 'unknown' | 'unavailable';

const CAPABILITY_LEVELS = new Set<CapabilityLevel>([
  'enforced',
  'advisory',
  'unavailable',
]);
const FRESHNESS_LEVELS = new Set<Freshness>([
  'fresh',
  'stale',
  'unknown',
  'unavailable',
]);

export function parseCapabilityLevel(
  value: unknown,
  label: string,
): CapabilityLevel {
  if (
    typeof value !== 'string' ||
    !CAPABILITY_LEVELS.has(value as CapabilityLevel)
  ) {
    throw new Error(`${label} must be enforced, advisory, or unavailable`);
  }
  return value as CapabilityLevel;
}

export function parseFreshness(value: unknown, label: string): Freshness {
  if (typeof value !== 'string' || !FRESHNESS_LEVELS.has(value as Freshness)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Freshness;
}
