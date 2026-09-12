import { type Node, type ParseError, parseTree } from 'jsonc-parser';
import { GatewayError } from './errors.js';

export type JsonPath = (string | number)[];
export interface JsonEdit {
  offset: number;
  length: number;
  text: string;
}

/** Strict JSON validation with source offsets; never reserialize numeric values. */
export function parseStrictJson(source: string): Node {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new GatewayError('MANCODE_GATEWAY_JSON_LIMIT');
  // Bound allocation and recursion before the recursive parser sees the input.
  let depth = 0;
  let structures = 0;
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      if (++depth > 48 || ++structures > 8000)
        throw new GatewayError('MANCODE_GATEWAY_JSON_LIMIT');
    } else if (character === '}' || character === ']') depth--;
    else if ((character === ',' || character === ':') && ++structures > 8000)
      throw new GatewayError('MANCODE_GATEWAY_JSON_LIMIT');
  }
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!tree || errors.length)
    throw new GatewayError('MANCODE_GATEWAY_INVALID_JSON');
  let count = 0;
  const visit = (node: Node, depth: number): void => {
    if (depth > 48 || ++count > 40_000)
      throw new GatewayError('MANCODE_GATEWAY_JSON_LIMIT');
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (keys.has(key))
          throw new GatewayError('MANCODE_GATEWAY_DUPLICATE_KEY');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree, 0);
  return tree;
}

export function property(node: Node, name: string): Node | undefined {
  return node.type === 'object'
    ? node.children?.find((child) => child.children?.[0]?.value === name)
        ?.children?.[1]
    : undefined;
}

export function stringValue(node: Node | undefined): string | undefined {
  return node?.type === 'string' ? (node.value as string) : undefined;
}

export function applyJsonEdits(input: string, edits: JsonEdit[]): string {
  let source = input;
  let last = source.length;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    if (edit.offset + edit.length > last)
      throw new GatewayError('MANCODE_GATEWAY_OVERLAPPING_EDIT');
    source =
      source.slice(0, edit.offset) +
      edit.text +
      source.slice(edit.offset + edit.length);
    last = edit.offset;
  }
  return source;
}

export function replaceString(
  edits: JsonEdit[],
  node: Node,
  value: string,
): void {
  if (value !== node.value)
    edits.push({
      offset: node.offset,
      length: node.length,
      text: JSON.stringify(value),
    });
}
