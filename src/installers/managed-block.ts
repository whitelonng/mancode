export const DEFAULT_MANCODE_START_MARKER = '<!-- mancode:start -->';
export const DEFAULT_MANCODE_END_MARKER = '<!-- mancode:end -->';

export function replaceManagedBlock(
  existing: string,
  block: string,
  startMarker = DEFAULT_MANCODE_START_MARKER,
  endMarker = DEFAULT_MANCODE_END_MARKER,
): string {
  const normalizedBlock = normalizeManagedBlock(block, startMarker, endMarker);
  const start = findMarkerLine(existing, startMarker);
  const end = findMarkerLine(existing, endMarker);

  if ((start === null) !== (end === null)) {
    throw new Error('managed block is malformed: missing start or end marker');
  }

  if (start === null && end === null) {
    const trimmedExisting = trimTrailingNewlines(existing);
    if (!trimmedExisting) return `${normalizedBlock}\n`;
    return `${trimmedExisting}\n\n${normalizedBlock}\n`;
  }

  if (!start || !end) {
    throw new Error('managed block is malformed: missing start or end marker');
  }

  if (end.start < start.start) {
    throw new Error('managed block is malformed: end marker precedes start');
  }

  return `${existing.slice(0, start.start)}${normalizedBlock}${existing.slice(
    end.end,
  )}`;
}

function normalizeManagedBlock(
  block: string,
  startMarker: string,
  endMarker: string,
): string {
  const trimmedBlock = block.trim();
  const hasStart = trimmedBlock.startsWith(startMarker);
  const hasEnd = trimmedBlock.endsWith(endMarker);

  if (hasStart && hasEnd) return trimmedBlock;
  if (hasStart || hasEnd) {
    throw new Error('managed block content includes only one marker');
  }

  return `${startMarker}\n${trimmedBlock}\n${endMarker}`;
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, '');
}

function findMarkerLine(
  content: string,
  marker: string,
): { start: number; end: number } | null {
  let offset = 0;
  let inFence: { char: '`' | '~'; length: number } | null = null;

  for (const lineWithBreak of content.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const rawLine = lineWithBreak[0];
    if (!rawLine) break;

    const line = rawLine.replace(/\n$/u, '').replace(/\r$/u, '');
    const fence = line.match(/^(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      const char = fence[0] as '`' | '~';
      if (!inFence) {
        inFence = { char, length: fence.length };
      } else if (inFence.char === char && fence.length >= inFence.length) {
        inFence = null;
      }
    } else if (!inFence && line === marker) {
      return {
        start: offset,
        end: offset + marker.length,
      };
    }

    offset += rawLine.length;
  }

  return null;
}
