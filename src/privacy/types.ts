/** New scanner contracts are independent of persisted shared-privacy kinds. */
export type SensitiveCategory =
  | 'authorization'
  | 'cookie'
  | 'private_key'
  | 'secret'
  | 'absolute_path'
  | 'email'
  | 'vendor_key'
  | 'cloud_key'
  | 'connection_password'
  | 'jwt'
  | 'phone'
  | 'identity_card'
  | 'payment_card';

export interface SensitiveFinding {
  ruleId: string;
  category: SensitiveCategory;
  /** Offsets refer to UTF-16 code units in the original input. */
  start: number;
  end: number;
  validation: 'shape' | 'checksum';
}

export interface ScanResult {
  status: 'complete' | 'failed';
  rulesetVersion: string;
  findings: SensitiveFinding[];
  reason?:
    | 'invalid_text'
    | 'input_too_large'
    | 'unknown_rule'
    | 'too_many_findings'
    | 'scan_budget_exceeded';
}

export interface RedactionSpan {
  start: number;
  end: number;
  ruleIds: string[];
  categories: SensitiveCategory[];
}

export interface RedactedText {
  text: string;
  scan: ScanResult;
  spans: RedactionSpan[];
}
