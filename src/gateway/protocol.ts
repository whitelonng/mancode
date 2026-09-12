import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Node } from 'jsonc-parser';
import { scanSensitiveText } from '../privacy/detect.js';
import { GatewayError } from './errors.js';
import {
  type JsonEdit,
  applyJsonEdits,
  parseStrictJson,
  property,
  replaceString,
  stringValue,
} from './json.js';
import { type RequestMapping, TOKEN_PREFIX } from './mapping.js';

export type GatewayProtocol = 'responses' | 'messages';
export interface TransformResult {
  body: string;
  opaqueBlocks: number;
}
const SENSITIVE_NUMBER_KEY =
  /(?:phone|mobile|telephone|id_?card|card_?number|account_?number|ssn)/i;
const CREDENTIAL_KEY =
  /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie)$/i;

function assertNoSensitive(value: string, rules?: readonly string[]): void {
  const scan = scanSensitiveText(value, rules);
  if (scan.status !== 'complete')
    throw new GatewayError('MANCODE_GATEWAY_SCAN_FAILED');
  if (scan.findings.length || value.includes(TOKEN_PREFIX))
    throw new GatewayError('MANCODE_GATEWAY_SENSITIVE_STRUCTURE');
}

/** Business values are not protocol metadata merely because a key is called call_id. */
function transformData(
  source: string,
  node: Node,
  edits: JsonEdit[],
  mapping: RequestMapping,
  restore: boolean,
  rules?: readonly string[],
  key = '',
): void {
  const credential =
    !restore &&
    CREDENTIAL_KEY.test(key) &&
    (!rules || rules.includes('named-secret'));
  if (credential && (node.type === 'object' || node.type === 'array'))
    throw new GatewayError('MANCODE_GATEWAY_CREDENTIAL_CONTAINER_UNSUPPORTED');
  if (node.type === 'string') {
    replaceString(
      edits,
      node,
      restore
        ? mapping.restore(node.value)
        : credential
          ? mapping.maskLiteral(node.value)
          : mapping.mask(node.value, rules),
    );
  } else if (
    (node.type === 'number' && SENSITIVE_NUMBER_KEY.test(key)) ||
    (credential &&
      node.type !== 'object' &&
      node.type !== 'array' &&
      node.type !== 'null')
  ) {
    throw new GatewayError('MANCODE_GATEWAY_SENSITIVE_NUMBER');
  } else if (node.type === 'object') {
    for (const field of node.children ?? []) {
      const name = field.children?.[0];
      const value = field.children?.[1];
      if (!name || !value)
        throw new GatewayError('MANCODE_GATEWAY_INVALID_JSON');
      assertNoSensitive(name.value, rules);
      transformData(source, value, edits, mapping, restore, rules, name.value);
    }
  } else
    for (const value of node.children ?? [])
      transformData(source, value, edits, mapping, restore, rules, key);
}

function scanStructure(
  source: string,
  node: Node,
  rules?: readonly string[],
): void {
  if (node.type === 'string') assertNoSensitive(node.value, rules);
  else
    for (const child of node.children ?? [])
      scanStructure(source, child, rules);
}

/** Descriptive schema text is model context; constraints and property names stay exact. */
function transformToolDefinitions(
  source: string,
  node: Node,
  edits: JsonEdit[],
  mapping: RequestMapping,
  rules?: readonly string[],
  fieldName = '',
): void {
  if (
    node.type === 'string' &&
    (fieldName === 'description' || fieldName === 'title')
  ) {
    replaceString(edits, node, mapping.mask(node.value, rules));
    return;
  }
  if (node.type === 'object') {
    for (const field of node.children ?? []) {
      const key = field.children?.[0];
      const value = field.children?.[1];
      if (!key || !value)
        throw new GatewayError('MANCODE_GATEWAY_INVALID_JSON');
      assertNoSensitive(key.value, rules);
      if (
        key.value === 'enum' ||
        key.value === 'const' ||
        key.value === 'pattern' ||
        key.value === 'required'
      )
        scanStructure(source, value, rules);
      else
        transformToolDefinitions(
          source,
          value,
          edits,
          mapping,
          rules,
          key.value,
        );
    }
  } else if (node.type === 'array')
    for (const child of node.children ?? [])
      transformToolDefinitions(source, child, edits, mapping, rules, fieldName);
  else scanStructure(source, node, rules);
}

function transformText(
  value: string,
  mapping: RequestMapping,
  restore: boolean,
  rules?: readonly string[],
): string {
  if (!restore && /^[\s]*[\[{]/.test(value)) {
    try {
      const tree = parseStrictJson(value);
      const edits: JsonEdit[] = [];
      transformData(value, tree, edits, mapping, false, rules);
      return applyJsonEdits(value, edits);
    } catch (error) {
      if (
        !(error instanceof GatewayError) ||
        error.code !== 'MANCODE_GATEWAY_INVALID_JSON'
      )
        throw error;
    }
  }
  return restore ? mapping.restore(value) : mapping.mask(value, rules);
}

const CLAUDE_READ_SCHEMA_SHA256 =
  '384be111a755f235f20b1c632d0ed1a665e9f16d191f02108e80232c7fc4b488';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Only the captured Claude Code 2.1.142 Read schema has an audited data sink. */
export function restoreToolArguments(
  source: string,
  mapping?: RequestMapping,
  name?: string,
): string {
  const tree = parseStrictJson(source);
  let needsRestore = false;
  const inspect = (node: Node): void => {
    if (node.type === 'string' && node.value.includes(TOKEN_PREFIX))
      needsRestore = true;
    for (const child of node.children ?? []) inspect(child);
  };
  inspect(tree);
  if (!needsRestore) return source;
  if (!mapping?.claudeReadAllowed || name !== 'Read' || tree.type !== 'object')
    throw new GatewayError('MANCODE_GATEWAY_TOOL_SINK_UNSUPPORTED');
  for (const field of tree.children ?? []) {
    const key = field.children?.[0]?.value;
    const value = field.children?.[1];
    if (key === 'file_path') continue;
    if (
      (key === 'offset' || key === 'limit') &&
      value?.type === 'number' &&
      Number.isSafeInteger(value.value) &&
      value.value >= (key === 'offset' ? 0 : 1)
    )
      continue;
    if (
      key === 'pages' &&
      value?.type === 'string' &&
      /^\d+(?:-\d+)?$/.test(value.value)
    )
      continue;
    throw new GatewayError('MANCODE_GATEWAY_TOOL_SINK_UNSUPPORTED');
  }
  const filePath = property(tree, 'file_path');
  if (
    filePath?.type !== 'string' ||
    !/^__MANCODE_[a-f0-9]{32}__$/.test(filePath.value)
  )
    throw new GatewayError('MANCODE_GATEWAY_TOOL_PATH_COMPOSITION');
  const restored = mapping.restore(filePath.value);
  if (
    (!path.isAbsolute(restored) && !path.win32.isAbsolute(restored)) ||
    /[\0\r\n]/.test(restored) ||
    restored.startsWith('//') ||
    restored.startsWith('\\\\')
  )
    throw new GatewayError('MANCODE_GATEWAY_TOOL_PATH_INVALID');
  const edits: JsonEdit[] = [];
  replaceString(edits, filePath, restored);
  return applyJsonEdits(source, edits);
}

function content(
  source: string,
  node: Node,
  edits: JsonEdit[],
  mapping: RequestMapping,
  restore: boolean,
  coverage: { opaque: number },
  rules?: readonly string[],
): void {
  if (node.type === 'string') {
    replaceString(
      edits,
      node,
      transformText(node.value, mapping, restore, rules),
    );
    return;
  }
  if (node.type === 'array') {
    for (const child of node.children ?? [])
      content(source, child, edits, mapping, restore, coverage, rules);
    return;
  }
  if (node.type !== 'object')
    throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
  const type = stringValue(property(node, 'type'));
  const allowed: Record<string, string[]> = {
    message: ['type', 'role', 'content', 'id', 'status', 'phase'],
    input_text: ['type', 'text', 'cache_control'],
    output_text: ['type', 'text', 'annotations', 'logprobs'],
    text: ['type', 'text', 'cache_control', 'citations'],
    refusal: ['type', 'refusal'],
    function_call: ['type', 'id', 'call_id', 'name', 'arguments', 'status'],
    tool_use: ['type', 'id', 'name', 'input', 'cache_control'],
    function_call_output: ['type', 'id', 'call_id', 'output', 'status'],
    tool_result: [
      'type',
      'tool_use_id',
      'content',
      'is_error',
      'cache_control',
    ],
    thinking: ['type', 'thinking', 'signature', 'cache_control'],
    redacted_thinking: ['type', 'data', 'cache_control'],
    reasoning: ['type', 'id', 'summary', 'encrypted_content', 'status'],
  };
  const keys = allowed[type ?? (property(node, 'role') ? 'message' : '')];
  if (
    !keys ||
    node.children?.some((field) => !keys.includes(field.children?.[0]?.value))
  )
    throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
  for (const name of [
    'id',
    'call_id',
    'tool_use_id',
    'name',
    'role',
    'status',
    'phase',
    'type',
  ]) {
    const value = property(node, name);
    if (value && (value.type !== 'string' || value.value.length > 256))
      throw new GatewayError('MANCODE_GATEWAY_INVALID_PROTOCOL_ID');
  }
  const cacheControl = property(node, 'cache_control');
  if (cacheControl) scanStructure(source, cacheControl, rules);
  if (
    type === 'thinking' ||
    type === 'redacted_thinking' ||
    type === 'reasoning'
  ) {
    coverage.opaque++;
    return;
  }
  if (
    type === 'input_text' ||
    type === 'output_text' ||
    type === 'text' ||
    type === 'refusal'
  ) {
    const field = property(node, type === 'refusal' ? 'refusal' : 'text');
    if (!field || field.type !== 'string')
      throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
    replaceString(
      edits,
      field,
      transformText(field.value, mapping, restore, rules),
    );
    for (const child of node.children ?? []) {
      const name = child.children?.[0]?.value;
      const value = child.children?.[1];
      if (value && name !== 'text' && name !== 'refusal' && name !== 'type')
        scanStructure(source, value, rules);
    }
    return;
  }
  if (type === 'function_call' || type === 'tool_use') {
    const args = property(
      node,
      type === 'function_call' ? 'arguments' : 'input',
    );
    if (!args) throw new GatewayError('MANCODE_GATEWAY_TOOL_ARGUMENTS_MISSING');
    if (args.type === 'string') {
      const inner = args.value as string;
      if (restore)
        replaceString(
          edits,
          args,
          restoreToolArguments(
            inner,
            mapping,
            stringValue(property(node, 'name')),
          ),
        );
      else {
        const innerEdits: JsonEdit[] = [];
        transformData(
          inner,
          parseStrictJson(inner),
          innerEdits,
          mapping,
          false,
          rules,
        );
        replaceString(edits, args, applyJsonEdits(inner, innerEdits));
      }
    } else if (type === 'tool_use' && args.type === 'object') {
      if (restore) {
        const restored = restoreToolArguments(
          source.slice(args.offset, args.offset + args.length),
          mapping,
          stringValue(property(node, 'name')),
        );
        edits.push({
          offset: args.offset,
          length: args.length,
          text: restored,
        });
      } else transformData(source, args, edits, mapping, false, rules);
    } else throw new GatewayError('MANCODE_GATEWAY_INVALID_TOOL_ARGUMENTS');
    return;
  }
  if (type === 'function_call_output' || type === 'tool_result') {
    const field = property(
      node,
      type === 'function_call_output' ? 'output' : 'content',
    );
    if (!field) throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
    content(source, field, edits, mapping, restore, coverage, rules);
    return;
  }
  if (type === 'message' || (!type && property(node, 'role'))) {
    const field = property(node, 'content');
    if (!field) throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
    content(source, field, edits, mapping, restore, coverage, rules);
    return;
  }
  throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_CONTENT');
}

const REQUEST_FIELDS = {
  responses: new Set([
    'model',
    'input',
    'instructions',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'store',
    'stream',
    'temperature',
    'top_p',
    'max_output_tokens',
    'text',
    'reasoning',
    'metadata',
    'previous_response_id',
    'include',
    'service_tier',
    'prompt_cache_key',
    'prompt_cache_retention',
    'truncation',
    'user',
    'safety_identifier',
    'client_metadata',
  ]),
  messages: new Set([
    'model',
    'messages',
    'system',
    'tools',
    'tool_choice',
    'stream',
    'temperature',
    'top_p',
    'top_k',
    'max_tokens',
    'stop_sequences',
    'metadata',
    'thinking',
    'service_tier',
    'context_management',
    'output_config',
  ]),
};

export function transformRequest(
  source: string,
  protocol: GatewayProtocol,
  mapping: RequestMapping,
  rules?: readonly string[],
  verifiedHost?: string,
): TransformResult {
  const tree = parseStrictJson(source);
  const edits: JsonEdit[] = [];
  const coverage = { opaque: 0 };
  if (tree.type !== 'object')
    throw new GatewayError('MANCODE_GATEWAY_INVALID_REQUEST');
  const bodyField = protocol === 'responses' ? 'input' : 'messages';
  if (!property(tree, bodyField))
    throw new GatewayError('MANCODE_GATEWAY_INVALID_REQUEST');
  for (const child of tree.children ?? []) {
    const name = child.children?.[0]?.value as string;
    const value = child.children?.[1];
    if (!value || !REQUEST_FIELDS[protocol].has(name))
      throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_FIELD');
    if (name === bodyField || name === 'system' || name === 'instructions')
      content(source, value, edits, mapping, false, coverage, rules);
    else if (name === 'metadata' || name === 'client_metadata')
      transformData(source, value, edits, mapping, false, rules);
    else if (name === 'context_management') {
      const control = JSON.parse(
        source.slice(value.offset, value.offset + value.length),
      );
      if (
        JSON.stringify(canonical(control)) !==
        JSON.stringify(
          canonical({
            edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
          }),
        )
      )
        throw new GatewayError('MANCODE_GATEWAY_CONTEXT_CONTROL_UNSUPPORTED');
    } else if (name === 'output_config') {
      const effort = stringValue(property(value, 'effort'));
      if (
        value.type !== 'object' ||
        value.children?.length !== 1 ||
        !effort ||
        !['low', 'medium', 'high', 'max'].includes(effort)
      )
        throw new GatewayError('MANCODE_GATEWAY_OUTPUT_CONFIG_UNSUPPORTED');
    } else if (name === 'previous_response_id') {
      if (value.type !== 'string')
        throw new GatewayError('MANCODE_GATEWAY_INVALID_HISTORY');
    } else {
      if (
        name === 'tools' &&
        protocol === 'messages' &&
        verifiedHost === 'claude-code/2.1.142'
      ) {
        for (const tool of value.children ?? []) {
          const schema = property(tool, 'input_schema');
          if (stringValue(property(tool, 'name')) === 'Read' && schema) {
            const schemaValue = JSON.parse(
              source.slice(schema.offset, schema.offset + schema.length),
            );
            const digest = createHash('sha256')
              .update(JSON.stringify(canonical(schemaValue)))
              .digest('hex');
            mapping.claudeReadAllowed = digest === CLAUDE_READ_SCHEMA_SHA256;
          }
        }
      }
      if (name === 'tools')
        transformToolDefinitions(source, value, edits, mapping, rules);
      else scanStructure(source, value, rules);
    }
  }
  return { body: applyJsonEdits(source, edits), opaqueBlocks: coverage.opaque };
}

export function transformResponse(
  source: string,
  protocol: GatewayProtocol,
  mapping: RequestMapping,
): TransformResult {
  const tree = parseStrictJson(source);
  const edits: JsonEdit[] = [];
  const coverage = { opaque: 0 };
  const output = property(
    tree,
    protocol === 'responses' ? 'output' : 'content',
  );
  if (!output) throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_RESPONSE');
  content(source, output, edits, mapping, true, coverage);
  return { body: applyJsonEdits(source, edits), opaqueBlocks: coverage.opaque };
}

export function transformContentItem(
  source: string,
  mapping: RequestMapping,
): TransformResult {
  const tree = parseStrictJson(source);
  const edits: JsonEdit[] = [];
  const coverage = { opaque: 0 };
  content(source, tree, edits, mapping, true, coverage);
  return { body: applyJsonEdits(source, edits), opaqueBlocks: coverage.opaque };
}
