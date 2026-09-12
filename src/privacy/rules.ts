import {
  NAMED_SECRET_ASSIGNMENT,
  NAMED_SECRET_RULE_ID,
} from './named-secret.js';
import type { SensitiveCategory } from './types.js';
import { isIdentityCard, isJwt, isPaymentCard } from './validators.js';

// Adapted rule ideas from Maskit 19ee664; see docs/privacy-rule-sources.md.
export const RULESET_VERSION = 'mancode-sensitive-text:1';
export const PRIVATE_KEY_RULE_ID = 'pem-private-key';

export interface SensitiveRule {
  id: string;
  category: SensitiveCategory;
  pattern: RegExp;
  group?: number;
  validation?: 'checksum';
  validate?: (value: string) => boolean;
}

export const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: 'authorization-header',
    category: 'authorization',
    pattern:
      /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+[^\s,;]+/dgi,
  },
  {
    id: 'cookie-header',
    category: 'cookie',
    pattern: /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/dgi,
  },
  {
    id: NAMED_SECRET_RULE_ID,
    category: 'secret',
    pattern: NAMED_SECRET_ASSIGNMENT,
  },
  {
    id: 'absolute-local-path',
    category: 'absolute_path',
    pattern:
      /(?:\b[A-Z]:\\|\/(?:Users|home|private|var\/folders|tmp|etc)\/)[^\s'"`]+/dg,
  },
  {
    id: 'email-address',
    category: 'email',
    // Bounded local/domain parts avoid repeated unbounded suffix searches.
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}(?![A-Za-z0-9_%+-])/dg,
  },
  {
    id: 'vendor-api-key',
    category: 'vendor_key',
    pattern:
      /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,255}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}|AIza[A-Za-z0-9_-]{30,64}|xox[baprs]-[A-Za-z0-9-]{10,255})(?![A-Za-z0-9_-])/dg,
  },
  {
    id: 'cloud-access-key',
    category: 'cloud_key',
    pattern:
      /(?<![A-Za-z0-9])(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,32}|AKID[A-Za-z0-9]{13,40})(?![A-Za-z0-9])/dg,
  },
  {
    id: 'connection-password',
    category: 'connection_password',
    group: 1,
    pattern:
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,255}:([^\s@/]{1,4096})@/dgi,
  },
  {
    id: 'bearer-token',
    category: 'authorization',
    group: 1,
    pattern: /\bbearer\s+([A-Za-z0-9._~+/-]+=*)/dgi,
  },
  {
    id: 'jwt-token',
    category: 'jwt',
    validate: isJwt,
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{1,2048}(?![A-Za-z0-9_-])/dg,
  },
  {
    id: 'cn-mobile-phone',
    category: 'phone',
    pattern:
      /(?<![A-Za-z0-9_])(?:(?:\+?86|0086|[（(]\+?86[）)])[ -]?)?1[3-9][0-9](?:([ -])[0-9]{4}\1[0-9]{4}|[0-9]{8})(?![A-Za-z0-9_])/dg,
  },
  {
    id: 'cn-identity-card-18',
    category: 'identity_card',
    pattern: /(?<![A-Za-z0-9_])[0-9]{17}[0-9Xx](?![A-Za-z0-9_])/dg,
    validation: 'checksum',
    validate: isIdentityCard,
  },
  {
    id: 'cn-identity-card-15',
    category: 'identity_card',
    pattern: /(?<![A-Za-z0-9_])[0-9]{15}(?![A-Za-z0-9_])/dg,
    validate: isIdentityCard,
  },
  {
    id: 'payment-card',
    category: 'payment_card',
    pattern:
      /(?<![A-Za-z0-9_])(?:[2-6][0-9]{12,18}|[2-6][0-9]{3}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,4}(?:\1[0-9]{3})?|[3-6][0-9]{3}([ -])[0-9]{6}\2[0-9]{5})(?![A-Za-z0-9_])/dg,
    validation: 'checksum',
    validate: isPaymentCard,
  },
];

export const DEFAULT_RULE_IDS: readonly string[] = [
  PRIVATE_KEY_RULE_ID,
  ...SENSITIVE_RULES.map((rule) => rule.id),
];
