import assert from 'node:assert/strict';

export function assertNoTerminalEcho(output, value) {
  const normalizedOutput = output.replace(/\r\n?/g, '\n');
  const normalizedValue = value.replace(/\r\n?/g, '\n');
  const fragments = new Set(
    [normalizedValue, ...normalizedValue.split('\n')].filter(Boolean),
  );
  for (const fragment of fragments) {
    assert(
      !normalizedOutput.includes(fragment),
      'protected value echoed in terminal output',
    );
  }
}
