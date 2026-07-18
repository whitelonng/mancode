import { describe, expect, it } from 'vitest';
import { assertManteamPlanContent } from '../src/context/manteam-plan.js';
import { CONFIRMED_MANTEAM_PLAN } from './helpers/manteam-plan.js';

describe('manteam plan content gate', () => {
  it('accepts a headed plan with substantive coverage of every coordination obligation', () => {
    expect(() =>
      assertManteamPlanContent(CONFIRMED_MANTEAM_PLAN),
    ).not.toThrow();
  });

  it('rejects keyword-only prose without headed, actionable sections', () => {
    expect(() =>
      assertManteamPlanContent(
        'Ownership scope claims dependencies compatibility verification handoff capabilities acquisition transport.',
      ),
    ).toThrow('MANCODE_MANTEAM_PLAN_SECTIONS_REQUIRED');
  });

  it('rejects a single keyword-stuffed heading reused for every obligation', () => {
    expect(() =>
      assertManteamPlanContent(
        '# Ownership scope claim dependencies integration compatibility verification handoff capabilities acquisition transport\n\nThis generic paragraph is deliberately long enough to pass a superficial body check.',
      ),
    ).toThrow('MANCODE_MANTEAM_PLAN_SECTIONS_REQUIRED');
  });

  it('requires meaningful capability acquisition and transport coverage', () => {
    const missingTransport = CONFIRMED_MANTEAM_PLAN.replace(
      'Current claim acquisition, write guard, and transport capabilities are checked before work.',
      'Current claim acquisition and write guard capabilities are checked before work.',
    );
    expect(() => assertManteamPlanContent(missingTransport)).toThrow(
      'capability_transport',
    );

    const emptyHandoff = CONFIRMED_MANTEAM_PLAN.replace(
      'Handoff requires a checkpoint, a named recipient, and an explicit acceptance.',
      '',
    );
    expect(() => assertManteamPlanContent(emptyHandoff)).toThrow('handoff');
  });
});
