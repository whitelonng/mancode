import { build } from 'esbuild';
import { getEncoding } from 'js-tiktoken';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders text in memory. Does not install adapters or mutate Continuity state.
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
try {
  const bundle = await build({
    entryPoints: [path.join(root, 'src/installers/v3-adapter.ts')],
    bundle: true, write: false, platform: 'node', format: 'esm',
  });
  const renderer = await import('data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const encoder = getEncoding('cl100k_base');
  const metrics = (text) => ({
    bytes: Buffer.byteLength(text),
    lines: text.trimEnd().split('\n').length,
    tokens_cl100k_base: encoder.encode(text).length,
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  const files = [
    'AGENTS.md', '.agents/skills/man/SKILL.md',
    'src/installers/v3-adapter.ts', 'src/context/design-guidance.ts',
    'src/context/accepted-state-narrative-guidance.ts',
  ];
  const installed = {};
  for (const file of files) installed[file] = metrics(await readFile(path.join(root, file), 'utf8'));
  const generated = {};
  for (const platform of ['codex', 'claude-code']) {
    generated[platform] = {
      bootstrap: metrics(renderer.renderV3Bootstrap(platform)),
      modes: Object.fromEntries(['man', 'manba', 'manteam', 'manps', 'mansolo']
        .map(mode => [mode, metrics(renderer.renderV3ModeEntry(mode, platform))])),
    };
  }
  const tokenizerPackage = JSON.parse(await readFile(path.join(root, 'node_modules/js-tiktoken/package.json'), 'utf8'));
  const result = {
    recordedAt: new Date().toISOString(),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    tokenizer: {encoding: 'cl100k_base', package: 'js-tiktoken', version: tokenizerPackage.version},
    note: 'Static text only; not actual host input tokens, billing, latency, or behavior. Installed AGENTS includes project facts; generated bootstrap is the managed block alone. Existing uncommitted source changes are not encoded by sourceHead; file hashes identify measured inputs.',
    installed, generated,
  };
  await writeFile(path.join(directory, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({sourceHead: result.sourceHead, installed, generated}, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
