import { describe, expect, it } from 'vitest';
import { scanSensitiveText } from '../src/privacy/detect.js';
import { redactSensitiveText } from '../src/privacy/redact.js';

describe('named secret assignments', () => {
  it.each([
    'client_password',
    'DB_PASSWORD',
    'service-api-key',
    'aws_secret_access_key',
  ])('protects the complete %s value with exact offsets', (name) => {
    const secret = 'correct horse battery staple';
    const source = `😀 ${name} = "${secret}"; token_count=12`;
    const scan = scanSensitiveText(source);
    expect(scan.status).toBe('complete');
    expect(scan.findings).toEqual([
      {
        ruleId: 'named-secret',
        category: 'secret',
        start: source.indexOf(secret),
        end: source.indexOf(secret) + secret.length,
        validation: 'shape',
      },
    ]);
    expect(redactSensitiveText(source).text).toBe(
      `😀 ${name} = "[REDACTED:secret]"; token_count=12`,
    );
  });

  it('leaves metric names and empty quoted values alone', () => {
    expect(
      scanSensitiveText(
        'token_count=12; password_length=24; client_password=""; secret=\'\'',
      ).findings,
    ).toEqual([]);
  });

  it('scans raw JSON fields and bounded command-style names', () => {
    expect(
      redactSensitiveText(
        '{"client_password":"synthetic phrase words","DB_PASSWORD":"other phrase words"}',
      ).text,
    ).toBe(
      '{"client_password":"[REDACTED:secret]","DB_PASSWORD":"[REDACTED:secret]"}',
    );
    expect(
      redactSensitiveText('--client-password=synthetic-value --token-count=2')
        .text,
    ).toBe('--client-password=[REDACTED:secret] --token-count=2');
    const name = `${'a'.repeat(119)}_password`;
    expect(name.length).toBe(128);
    expect(redactSensitiveText(`${name}=synthetic-value`).text).toBe(
      `${name}=[REDACTED:secret]`,
    );
    expect(scanSensitiveText(`a${name}=synthetic-value`).findings).toEqual([]);
  });

  it('continues after empty quotes and keeps newlines inside a quoted value', () => {
    expect(
      redactSensitiveText(
        'password=""; DB_PASSWORD="first line\nsecond line"; token_count=2',
      ).text,
    ).toBe('password=""; DB_PASSWORD="[REDACTED:secret]"; token_count=2');
  });

  it.each(['', '-', '--'])(
    'preserves credential detection with the "%s" command prefix',
    (prefix) => {
      expect(
        redactSensitiveText(
          `${prefix}password=synthetic-first ${prefix}token=synthetic-second ${prefix}token_count=12 ${prefix}password_length=24`,
        ).text,
      ).toBe(
        `${prefix}password=[REDACTED:secret] ${prefix}token=[REDACTED:secret] ${prefix}token_count=12 ${prefix}password_length=24`,
      );
    },
  );

  it('does not expand command prefixes beyond two hyphens', () => {
    expect(
      scanSensitiveText('---password=synthetic-value ---token=synthetic-value')
        .findings,
    ).toEqual([]);
  });

  it('keeps multiple quoted assignments separate and respects escaped quotes', () => {
    const source = String.raw`client_password="first \"quoted\" value\\tail"; DB_PASSWORD='second \'quoted\' value'; token_count=2`;
    expect(redactSensitiveText(source).text).toBe(
      'client_password="[REDACTED:secret]"; DB_PASSWORD=\'[REDACTED:secret]\'; token_count=2',
    );
  });

  it('protects all remaining text after an unfinished quote', () => {
    expect(redactSensitiveText('password="first second\nlast word').text).toBe(
      'password="[REDACTED:secret]',
    );
    expect(redactSensitiveText('password="first second\\').text).toBe(
      'password="[REDACTED:secret]',
    );
  });

  it('preserves exact redaction markers but removes their secret suffix', () => {
    expect(
      scanSensitiveText('password="[REDACTED:email,secret]"').findings,
    ).toEqual([]);
    expect(
      redactSensitiveText('password=[REDACTED:email,secret]suffix').text,
    ).toBe('password=[REDACTED:secret]');
    expect(
      redactSensitiveText('password="[REDACTED:secret] ordinary suffix"').text,
    ).toBe('password="[REDACTED:secret]"');
    expect(redactSensitiveText('password="[REDACTED:unknown]"').text).toBe(
      'password="[REDACTED:secret]"',
    );
  });
});
