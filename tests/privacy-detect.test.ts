import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { scanSharedText } from '../src/context/privacy.js';
import { MAX_SCAN_BYTES, scanSensitiveText } from '../src/privacy/detect.js';
import {
  mergeSensitiveSpans,
  redactSensitiveText,
} from '../src/privacy/redact.js';
import {
  isIdentityCard,
  isJwt,
  isPaymentCard,
} from '../src/privacy/validators.js';

describe('sensitive text rules', () => {
  it.each([
    ['authorization', 'aUtHoRiZaTiOn: bEaReR synthetic-secret'],
    ['cookie', 'Cookie: session=synthetic'],
    [
      'private_key',
      '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----',
    ],
    ['secret', 'password="fixture-value"'],
    ['absolute_path', '/Users/fixture/project'],
    ['email', 'alice@example.com'],
    ['email', 'mailto:alice@example.com'],
    ['email', 'email:alice@example.com'],
    ['secret', 'password\n=\nfixture-value'],
    ['authorization', 'Authorization:\nBearer fixture-value'],
    ['vendor_key', `ghp_${'a'.repeat(36)}`],
    ['cloud_key', `AKIA${'A'.repeat(16)}`],
    ['connection_password', 'postgres://user:fixture-password@db.example/test'],
    ['phone', '+86 138-1234-5678'],
    ['identity_card', '11010519491231002X'],
    ['identity_card', '110105491231002'],
    ['payment_card', '4111 1111 1111 1111'],
    ['payment_card', '3782-822463-10005'],
    ['payment_card', '2223003122003222'],
    ['payment_card', '2223 0031 2200 3222'],
  ])('detects %s without including input in metadata', (category, value) => {
    const result = scanSensitiveText(value);
    expect(result.status).toBe('complete');
    expect(
      result.findings.some((finding) => finding.category === category),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(value);
    const preview = redactSensitiveText(value);
    expect(preview.text).not.toContain(value);
    expect(scanSensitiveText(preview.text).findings).toEqual([]);
  });

  it('replaces only the connection password capture', () => {
    const result = redactSensitiveText(
      'postgres://user:fixture-password@db.example/test',
    );
    expect(result.text).toBe(
      'postgres://user:[REDACTED:connection_password]@db.example/test',
    );
  });

  it.each([
    '.',
    '...',
    '…',
    '。',
    ',',
    '，',
    '!',
    '！',
    '?',
    '？',
    ';',
    '；',
    ':',
    '：',
    ')',
    '）',
    ']',
    '}',
    '】',
  ])(
    'redacts a sentence-final email while preserving punctuation %s',
    (punctuation) => {
      const address = 'gateway.canary@sub.example.com';
      expect(
        redactSensitiveText(`Contact (${address}${punctuation}`).text,
      ).toBe(`Contact ([REDACTED:email]${punctuation}`);
    },
  );

  it('validates dates, checksums and JWT structure without claiming authenticity', () => {
    expect(isIdentityCard('11010519491231002X', 2026)).toBe(true);
    expect(isIdentityCard('11010519490231002X', 2026)).toBe(false);
    expect(isIdentityCard('110105194912310021', 2026)).toBe(false);
    expect(isIdentityCard('990105491231002', 2026)).toBe(false);
    expect(isPaymentCard('4111111111111112')).toBe(false);
    expect(isPaymentCard('313524224 2023')).toBe(false);
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"fixture"}').toString('base64url')}.signature`;
    expect(isJwt(jwt)).toBe(true);
    expect(scanSensitiveText(jwt).findings[0]?.category).toBe('jwt');
    expect(isJwt('not.a.jwt')).toBe(false);
    expect(
      isJwt(`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.e30.*`),
    ).toBe(false);
  });

  it.each([
    'commit 8613812345678abcdef',
    'version 10.2.3.4',
    '313524224 2023',
    'card 4111111111111112',
    'card 2223003122003223',
    'outside Mastercard 2-series range 2200000000000004',
    'id 11010519490231002X',
    'updates README.md',
    'phone 138-1234 5678',
    'build_13812345678',
    'not.a.jwt',
  ])('does not redact the negative fixture %s', (value) => {
    expect(scanSensitiveText(value).findings).toEqual([]);
  });

  it('uses original UTF-16 offsets and does not leak a partially overlapping tail', () => {
    const value = '😀 alice@example.com';
    const finding = scanSensitiveText(value).findings[0];
    expect(finding?.start).toBe(3);
    expect(value.slice(finding?.start, finding?.end)).toBe('alice@example.com');
    expect(
      mergeSensitiveSpans([
        {
          ruleId: 'a',
          category: 'secret',
          start: 0,
          end: 6,
          validation: 'shape',
        },
        {
          ruleId: 'b',
          category: 'email',
          start: 4,
          end: 10,
          validation: 'shape',
        },
      ]),
    ).toEqual([
      {
        start: 0,
        end: 10,
        ruleIds: ['a', 'b'],
        categories: ['email', 'secret'],
      },
    ]);
  });

  it('covers unclosed private keys and keeps existing persisted scanner semantics', () => {
    expect(
      redactSensitiveText('-----BEGIN PRIVATE KEY-----\nfixture').text,
    ).toBe('[REDACTED:private_key]');
    expect(scanSharedText('13812345678')).toEqual([]);
    expect(scanSensitiveText('13812345678').findings).toHaveLength(1);
  });

  it('keeps overlapping redaction markers stable without skipping marker suffixes', () => {
    const preview = redactSensitiveText('password=alice@example.com');
    expect(preview.text).toBe('password=[REDACTED:email,secret]');
    expect(scanSensitiveText(preview.text).findings).toEqual([]);
    expect(redactSensitiveText(preview.text).text).toBe(preview.text);
    expect(
      scanSensitiveText('password=[REDACTED]still-sensitive').findings,
    ).not.toEqual([]);
    expect(
      scanSensitiveText('password=[REDACTED:arbitraryvalue]').findings,
    ).not.toEqual([]);
  });

  it('keeps PEM matching case insensitive without Unicode offset drift', () => {
    const value =
      'ß😀 -----begin rsa private key-----\nfixture\n-----end RSA private key----- tail';
    expect(redactSensitiveText(value).text).toBe(
      'ß😀 [REDACTED:private_key] tail',
    );
  });

  it('bounds long near-matches in a subprocess with an independent hard deadline', () => {
    const built = buildSync({
      entryPoints: [
        fileURLToPath(new URL('../src/privacy/detect.ts', import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
    }).outputFiles[0]?.text;
    expect(built).toBeDefined();
    const script = `${built}
      const size = 1024 * 1024;
      const seeds = ['password' + ' '.repeat(size - 8), 'password     "     nope; ', 'x@' + 'a'.repeat(252) + ' ', '-----BEGIN PRIVATE KEY---- ', 'eyJ' + 'a'.repeat(1024) + '.' + 'a'.repeat(8192) + '.! '];
      for (const seed of seeds) {
        const result = module.exports.scanSensitiveText(seed.repeat(Math.ceil(size / seed.length)).slice(0, size));
        if (result.status !== 'complete') process.exit(1);
      }
      const inner = 'DB_PASSWORD=synthetic-value ';
      const quoted = 'password="' + inner.repeat(Math.ceil(size / inner.length));
      const unquoted = 'client_password=' + 'x'.repeat(size);
      for (const text of [quoted.slice(0, size), unquoted.slice(0, size)]) {
        const result = module.exports.scanSensitiveText(text);
        if (result.status !== 'complete' || result.findings.length !== 1 || result.findings[0].end !== size) process.exit(2);
      }
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      timeout: 3000,
      encoding: 'utf8',
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
  });

  it('fails closed on incomplete scans and unknown rule IDs', () => {
    expect(scanSensitiveText('a'.repeat(MAX_SCAN_BYTES + 1)).reason).toBe(
      'input_too_large',
    );
    expect(scanSensitiveText('hello\0world').reason).toBe('invalid_text');
    expect(scanSensitiveText('bad\uD800text').reason).toBe('invalid_text');
    expect(scanSensitiveText('text', ['invented-rule']).reason).toBe(
      'unknown_rule',
    );
    expect(redactSensitiveText('13812345678 '.repeat(5000)).text).toBe('');
    expect(scanSensitiveText('13812345678 '.repeat(5000)).reason).toBe(
      'too_many_findings',
    );
    expect(scanSensitiveText('13812345678', []).findings).toEqual([]);
  });
});
