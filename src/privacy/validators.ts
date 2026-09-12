// Rule/validator provenance: see docs/privacy-rule-sources.md.
const IDENTITY_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const IDENTITY_CHECKS = '10X98765432';
const PROVINCES = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '21',
  '22',
  '23',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '50',
  '51',
  '52',
  '53',
  '54',
  '61',
  '62',
  '63',
  '64',
  '65',
  '71',
  '81',
  '82',
]);

export function isPaymentCard(value: string): boolean {
  if (
    !/^(?:[2-6][0-9]{12,18}|[2-6][0-9]{3}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,4}(?:\1[0-9]{3})?|[3-6][0-9]{3}([ -])[0-9]{6}\2[0-9]{5})$/.test(
      value,
    )
  )
    return false;
  const digits = value.replace(/[ -]/g, '');
  if (!/^[2-6][0-9]{12,18}$/.test(digits)) return false;
  if (
    digits.startsWith('2') &&
    (digits.length !== 16 ||
      Number(digits.slice(0, 6)) < 222100 ||
      Number(digits.slice(0, 6)) > 272099)
  )
    return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isIdentityCard(
  value: string,
  currentYear = new Date().getUTCFullYear(),
): boolean {
  if (!/^(?:[0-9]{15}|[0-9]{17}[0-9Xx])$/.test(value)) return false;
  if (!PROVINCES.has(value.slice(0, 2))) return false;
  const legacy = value.length === 15;
  const dateText = legacy ? `19${value.slice(6, 12)}` : value.slice(6, 14);
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1880 ||
    year > currentYear ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return false;
  if (legacy) return true;
  const sum = IDENTITY_WEIGHTS.reduce(
    (total, weight, index) => total + Number(value[index]) * weight,
    0,
  );
  return value[17]?.toUpperCase() === IDENTITY_CHECKS[sum % 11];
}

/** Shape validation only; this does not authenticate a JWT or verify a signature. */
export function isJwt(value: string): boolean {
  if (
    !/^[A-Za-z0-9_-]{2,1027}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{1,2048}$/.test(
      value,
    )
  )
    return false;
  const segments = value.split('.');
  try {
    const decode = (segment: string): unknown => {
      const bytes = Buffer.from(segment, 'base64url');
      if (bytes.toString('base64url') !== segment) return null;
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    };
    const header = decode(segments[0] ?? '');
    const payload = decode(segments[1] ?? '');
    return (
      header !== null &&
      typeof header === 'object' &&
      !Array.isArray(header) &&
      'alg' in header &&
      typeof header.alg === 'string' &&
      header.alg.length > 0 &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      return false;
    throw error;
  }
}
