import { rename } from 'node:fs/promises';

const RETRIABLE_WINDOWS_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export interface AtomicReplaceOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Replaces a sibling file that has already been fully written. Windows may
 * transiently reject the rename while another process holds the destination.
 */
export async function replaceFileAtomically(
  temporary: string,
  target: string,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 12;
  const retryDelayMs = options.retryDelayMs ?? 25;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('MANCODE_ATOMIC_REPLACE_ATTEMPTS_INVALID');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('MANCODE_ATOMIC_REPLACE_DELAY_INVALID');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !isRetriableWindowsRenameError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      await delay(retryDelayMs * attempt);
    }
  }
}

function isRetriableWindowsRenameError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string' &&
    RETRIABLE_WINDOWS_RENAME_CODES.has(
      (error as NodeJS.ErrnoException).code ?? '',
    )
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
