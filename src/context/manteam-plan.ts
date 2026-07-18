/**
 * A manteam plan remains human-authored Markdown, but confirmation must prove
 * that each coordination obligation is actually addressed.  Merely repeating
 * a few keywords in prose is not a usable handoff or execution plan.
 */
const REQUIRED_SECTIONS: ReadonlyArray<{
  key: string;
  headingMarkers: readonly string[];
}> = [
  {
    key: 'ownership',
    headingMarkers: ['ownership', 'owner', 'lane', '所有权', '责任', '分工'],
  },
  {
    key: 'scope',
    headingMarkers: ['scope', '范围', '路径', '模块', 'api', 'schema'],
  },
  { key: 'claims', headingMarkers: ['claim', '认领'] },
  {
    key: 'dependencies',
    headingMarkers: ['dependenc', 'integration', '依赖', '集成'],
  },
  { key: 'compatibility', headingMarkers: ['compatib', '兼容'] },
  {
    key: 'verification',
    headingMarkers: ['verif', 'validation', '测试', '验证'],
  },
  { key: 'handoff', headingMarkers: ['handoff', '交接'] },
  {
    key: 'capabilities',
    headingMarkers: ['capabilit', 'ability', '能力', '权限'],
  },
];

const ACQUISITION_MARKERS = [
  'acquisition',
  'acquire',
  'claim',
  '认领',
  '获取',
] as const;
const TRANSPORT_MARKERS = [
  'transport',
  'sync',
  'remote',
  '传输',
  '同步',
  '远程',
] as const;

interface MarkdownPlanSection {
  heading: string;
  body: string;
}

/** Rejects a confirmed manteam plan that omits or leaves a coordination obligation empty. */
export function assertManteamPlanContent(plan: string): void {
  if (typeof plan !== 'string' || !plan.trim()) {
    throw new Error('MANCODE_PLAN_CONTENT_REQUIRED');
  }
  const sections = parseMarkdownSections(plan);
  const missing = REQUIRED_SECTIONS.filter(
    (required) =>
      !sections.some(
        (section) =>
          hasAnyMarker(section.heading, required.headingMarkers) &&
          hasMeaningfulBody(section.body),
      ),
  ).map(({ key }) => key);
  if (!hasMeaningfulSectionFor(sections, ACQUISITION_MARKERS)) {
    missing.push('capability_acquisition');
  }
  if (!hasMeaningfulSectionFor(sections, TRANSPORT_MARKERS)) {
    missing.push('capability_transport');
  }
  if (missing.length > 0) {
    throw new Error(
      `MANCODE_MANTEAM_PLAN_SECTIONS_REQUIRED:${[...new Set(missing)].join(',')}`,
    );
  }
}

function parseMarkdownSections(plan: string): MarkdownPlanSection[] {
  const sections: MarkdownPlanSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of plan.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^(?: {0,3})(?:#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) {
      if (heading !== null) body.push(line);
      continue;
    }
    if (heading !== null) {
      sections.push({ heading, body: body.join('\n') });
    }
    heading = match[1] ?? '';
    body = [];
  }
  if (heading !== null) {
    sections.push({ heading, body: body.join('\n') });
  }
  return sections;
}

function hasMeaningfulSectionFor(
  sections: readonly MarkdownPlanSection[],
  markers: readonly string[],
): boolean {
  return sections.some(
    (section) =>
      hasMeaningfulBody(section.body) &&
      (hasAnyMarker(section.heading, markers) ||
        hasAnyMarker(section.body, markers)),
  );
}

function hasAnyMarker(value: string, markers: readonly string[]): boolean {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  return markers.some((marker) => normalized.includes(marker));
}

function hasMeaningfulBody(value: string): boolean {
  const visible = value
    .replace(/[`*_>#\-\[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return visible.length >= 12;
}
