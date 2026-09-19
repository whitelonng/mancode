import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertNoTerminalEcho } from '../scripts/secrets-terminal-evidence.mjs';

const canary = 'synthetic-秘密\nsynthetic-multiline-tail';
// The pure JS assertions always run; only the real PTY probe needs Python.
const hasPty =
  process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty,termios'], {
    stdio: 'ignore',
    timeout: 5000,
  }).status === 0;

describe('Secrets terminal echo evidence', () => {
  it('accepts terminal prompts without the protected value', () => {
    expect(() =>
      assertNoTerminalEcho(
        'Secret (hidden; Ctrl+D finishes, Ctrl+C cancels): \r\nEncrypted record saved.\r\n',
        canary,
      ),
    ).not.toThrow();
  });

  it.each([
    ['LF', canary],
    ['CRLF', canary.replaceAll('\n', '\r\n')],
    ['CR', canary.replaceAll('\n', '\r')],
    ['first line only', canary.split('\n')[0]],
    ['last line only', canary.split('\n')[1]],
    ['interrupted lines', canary.replace('\n', '\r\nstatus message\r\n')],
  ])('rejects deliberate echo with %s', (_label, output) => {
    expect(() => assertNoTerminalEcho(output, canary)).toThrow(
      'protected value echoed in terminal output',
    );
  });

  it('normalizes protected values with CRLF and ignores empty lines', () => {
    expect(() =>
      assertNoTerminalEcho(
        'safe\r\noutput',
        '\r\nfirst-canary\r\n\r\nlast-canary\r\n',
      ),
    ).not.toThrow();
    expect(() =>
      assertNoTerminalEcho(
        'first-canary\nlast-canary',
        'first-canary\r\nlast-canary',
      ),
    ).toThrow('protected value echoed in terminal output');
  });

  it('does not include the protected value or transcript in diagnostics', () => {
    let message: string | undefined;
    try {
      assertNoTerminalEcho(`prefix ${canary} suffix`, canary);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('protected value echoed in terminal output');
  });

  it.skipIf(!hasPty)(
    'rejects actual PTY echo after the terminal converts LF to CRLF',
    () => {
      const result = spawnSync(
        'python3',
        [
          '-c',
          String.raw`
import errno,os,pty,subprocess,sys,termios
master,slave=pty.openpty()
settings=termios.tcgetattr(slave)
settings[1] |= termios.OPOST | termios.ONLCR
termios.tcsetattr(slave,termios.TCSANOW,settings)
child=subprocess.Popen([sys.executable,'-c','import sys;sys.stdout.write(sys.argv[1]);sys.stdout.flush()',sys.argv[1]],stdin=subprocess.DEVNULL,stdout=slave,stderr=slave)
os.close(slave)
try:
    while True:
        try: data=os.read(master,4096)
        except OSError as error:
            if error.errno==errno.EIO: break
            raise
        if not data: break
        sys.stdout.buffer.write(data)
    assert child.wait(timeout=5)==0
finally:
    os.close(master)
    if child.poll() is None: child.kill();child.wait()
`,
          canary,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(canary.replaceAll('\n', '\r\n'));
      expect(result.stdout).not.toContain(canary); // The former check misses this echo.
      expect(() => assertNoTerminalEcho(result.stdout, canary)).toThrow(
        'protected value echoed in terminal output',
      );
    },
  );
});
