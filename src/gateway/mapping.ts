import { randomBytes } from 'node:crypto';
import { scanSensitiveText } from '../privacy/detect.js';
import { GatewayError } from './errors.js';

export const TOKEN_PREFIX = '__MANCODE_';
const TOKEN_PATTERN = /__MANCODE_[a-f0-9]{32}__/g;
interface Entry {
  original: string;
  expires: number;
  pins: number;
  bytes: number;
}
interface Lineage {
  tokens: Set<string>;
  expires: number;
}
export interface MappingLimits {
  entries: number;
  bytes: number;
  ttlMs: number;
  lineage: number;
}
export const DEFAULT_MAPPING_LIMITS: MappingLimits = {
  entries: 4096,
  bytes: 4 * 1024 * 1024,
  ttlMs: 15 * 60_000,
  lineage: 256,
};

/** One authenticated principal / checkout / launch / upstream / policy scope. */
export class MappingStore {
  private entries = new Map<string, Entry>();
  private originals = new Map<string, string>();
  private responses = new Map<string, Lineage>();
  private bytes = 0;
  constructor(
    readonly scope: string,
    private readonly limits = DEFAULT_MAPPING_LIMITS,
    private readonly now = Date.now,
  ) {}

  begin(previousResponseId?: string): RequestMapping {
    this.prune();
    const inherited = previousResponseId
      ? this.responses.get(previousResponseId)
      : undefined;
    if (previousResponseId && !inherited)
      throw new GatewayError('MANCODE_GATEWAY_HISTORY_UNAVAILABLE');
    const request = new RequestMapping(this);
    for (const token of inherited?.tokens ?? []) request.authorize(token);
    return request;
  }

  allocate(original: string): string {
    this.prune();
    const existing = this.originals.get(original);
    if (existing) return existing;
    const bytes = Buffer.byteLength(original);
    if (
      this.entries.size >= this.limits.entries ||
      this.bytes + bytes > this.limits.bytes
    )
      throw new GatewayError('MANCODE_GATEWAY_MAPPING_CAPACITY', 429);
    const token = `${TOKEN_PREFIX}${randomBytes(16).toString('hex')}__`;
    this.entries.set(token, {
      original,
      expires: this.now() + this.limits.ttlMs,
      pins: 0,
      bytes,
    });
    this.originals.set(original, token);
    this.bytes += bytes;
    return token;
  }

  pin(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) throw new GatewayError('MANCODE_GATEWAY_UNKNOWN_TOKEN');
    entry.pins++;
  }

  original(token: string): string {
    const entry = this.entries.get(token);
    if (!entry) throw new GatewayError('MANCODE_GATEWAY_UNKNOWN_TOKEN');
    return entry.original;
  }

  finish(tokens: Set<string>, responseId?: string): void {
    if (responseId) {
      if (this.responses.has(responseId))
        throw new GatewayError('MANCODE_GATEWAY_RESPONSE_REPLAY');
      if (this.responses.size >= this.limits.lineage)
        this.responses.delete(this.responses.keys().next().value as string);
      this.responses.set(responseId, {
        tokens: new Set(tokens),
        expires: this.now() + this.limits.ttlMs,
      });
    }
  }

  release(tokens: Set<string>): void {
    for (const token of tokens) {
      const entry = this.entries.get(token);
      if (entry) {
        entry.pins--;
        entry.expires = this.now() + this.limits.ttlMs;
      }
    }
  }

  private prune(): void {
    for (const [token, entry] of this.entries)
      if (entry.pins === 0 && entry.expires <= this.now()) {
        this.entries.delete(token);
        this.originals.delete(entry.original);
        this.bytes -= entry.bytes;
      }
    for (const [id, lineage] of this.responses)
      if (
        lineage.expires <= this.now() ||
        [...lineage.tokens].some((token) => !this.entries.has(token))
      )
        this.responses.delete(id);
  }
}

export class RequestMapping {
  readonly authorized = new Set<string>();
  claudeReadAllowed = false;
  private released = false;
  constructor(private readonly store: MappingStore) {}
  authorize(token: string): void {
    if (this.authorized.has(token)) return;
    this.store.pin(token);
    this.authorized.add(token);
  }

  mask(input: string, ruleIds?: readonly string[]): string {
    let value = input;
    // Only complete existing tokens in this scope may appear in client history.
    for (const match of value.matchAll(TOKEN_PATTERN)) this.authorize(match[0]);
    if (value.replace(TOKEN_PATTERN, '').includes(TOKEN_PREFIX))
      throw new GatewayError('MANCODE_GATEWAY_MALFORMED_TOKEN');
    const scan = scanSensitiveText(value, ruleIds);
    if (scan.status !== 'complete')
      throw new GatewayError('MANCODE_GATEWAY_SCAN_FAILED');
    const ranges: { start: number; end: number }[] = [];
    for (const finding of scan.findings) {
      const last = ranges.at(-1);
      if (last && finding.start <= last.end)
        last.end = Math.max(last.end, finding.end);
      else ranges.push({ start: finding.start, end: finding.end });
    }
    for (const range of ranges.reverse()) {
      const original = value.slice(range.start, range.end);
      const token = this.store.allocate(original);
      this.authorize(token);
      value = value.slice(0, range.start) + token + value.slice(range.end);
    }
    return value;
  }
  maskLiteral(value: string): string {
    if (value === '') return value;
    if (/^__MANCODE_[a-f0-9]{32}__$/.test(value)) {
      this.authorize(value);
      return value;
    }
    if (value.includes(TOKEN_PREFIX))
      throw new GatewayError('MANCODE_GATEWAY_MALFORMED_TOKEN');
    const token = this.store.allocate(value);
    this.authorize(token);
    return token;
  }

  restore(value: string): string {
    const stripped = value.replace(TOKEN_PATTERN, '');
    if (stripped.includes(TOKEN_PREFIX))
      throw new GatewayError('MANCODE_GATEWAY_MALFORMED_TOKEN');
    return value.replace(TOKEN_PATTERN, (token) => {
      if (!this.authorized.has(token))
        throw new GatewayError('MANCODE_GATEWAY_UNAUTHORIZED_TOKEN');
      return this.store.original(token);
    });
  }

  finish(responseId?: string): void {
    this.store.finish(this.authorized, responseId);
  }
  withoutKnownEchoes(value: string): string {
    let result = value;
    const originals = [...this.authorized]
      .map((token) => this.store.original(token))
      .sort((a, b) => b.length - a.length);
    for (const original of originals) result = result.split(original).join('');
    return result;
  }
  release(): void {
    if (!this.released) {
      this.released = true;
      this.store.release(this.authorized);
    }
  }
}

export class IncrementalRestorer {
  private pending = '';
  constructor(private readonly mapping: RequestMapping) {}
  push(input: string, final = false): string {
    let value = this.pending + input;
    this.pending = '';
    if (!final) {
      const tokenStart = value.lastIndexOf(TOKEN_PREFIX);
      if (
        tokenStart >= 0 &&
        value.length - tokenStart < TOKEN_PREFIX.length + 34
      ) {
        this.pending = value.slice(tokenStart);
        value = value.slice(0, tokenStart);
      } else
        for (let length = TOKEN_PREFIX.length - 1; length > 0; length--) {
          const lastComplete = [...value.matchAll(TOKEN_PATTERN)].at(-1);
          const completeEnd = lastComplete
            ? lastComplete.index + lastComplete[0].length
            : 0;
          if (
            value.length - length >= completeEnd &&
            value.endsWith(TOKEN_PREFIX.slice(0, length))
          ) {
            this.pending = value.slice(-length);
            value = value.slice(0, -length);
            break;
          }
        }
    }
    return this.mapping.restore(value);
  }
}
