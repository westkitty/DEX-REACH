import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateAudit, parseExceptionFile, type AuditExceptionFile } from '../scripts/lib/audit-exceptions.js';

const ZOD = 'node_modules/@wonderwhy-er/desktop-commander/node_modules/zod';
const DC = 'node_modules/@wonderwhy-er/desktop-commander';
const zodAdvisory = { source: 1243066, name: 'zod', dependency: 'zod', title: 'Zod can exhaust memory while validating oversized constrained collections', url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5', severity: 'high', range: '<4.6.6' };

// Shape of the real `npm audit --omit=dev --json` report on this branch.
function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      '@wonderwhy-er/desktop-commander': { name: '@wonderwhy-er/desktop-commander', severity: 'high', isDirect: true, via: ['zod'], effects: [], range: '*', nodes: [DC], fixAvailable: false },
      zod: { name: 'zod', severity: 'high', isDirect: false, via: [{ ...zodAdvisory }], effects: ['@wonderwhy-er/desktop-commander'], range: '<4.6.6', nodes: [ZOD], fixAvailable: false },
    } as Record<string, any>,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } },
  };
}
function exceptions(overrides: Record<string, unknown> = {}): AuditExceptionFile {
  return { version: 1, exceptions: [{ advisory: 'GHSA-mrhx-c7xc-m3w5', package: 'zod', path: ZOD, installedVersion: '3.25.76', dependents: [DC], reason: 'test', approvedBy: 'owner', approvedOn: '2026-10-24', expiresOn: '2027-01-24', ...overrides }] };
}
const lock = { [ZOD]: { version: '3.25.76' }, [DC]: { version: '0.2.52' } };
const today = '2026-10-24';

test('the listed advisory at its exact path and dependent passes', () => {
  const result = evaluateAudit(report(), exceptions(), lock, today);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.excepted.length, 1);
});

test('any other high advisory still fails', () => {
  const r = report();
  r.vulnerabilities['body-parser'] = { name: 'body-parser', severity: 'high', via: [{ name: 'body-parser', url: 'https://github.com/advisories/GHSA-27r3-jxmh-p828', severity: 'high', title: 'x' }], nodes: ['node_modules/body-parser'] };
  r.metadata.vulnerabilities.high = 3;
  const result = evaluateAudit(r, exceptions(), lock, today);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('GHSA-27r3-jxmh-p828') && f.includes('not excepted')));
});

test('a critical advisory fails and moderate ones do not block, matching --audit-level=high', () => {
  const r = report();
  r.vulnerabilities.hono = { name: 'hono', severity: 'moderate', via: [{ name: 'hono', url: 'https://github.com/advisories/GHSA-5r4p-p66f-jhc7', severity: 'moderate' }], nodes: ['node_modules/hono'] };
  assert.equal(evaluateAudit(r, exceptions(), lock, today).ok, true);
  r.vulnerabilities.ws = { name: 'ws', severity: 'critical', via: [{ name: 'ws', url: 'https://github.com/advisories/GHSA-2222-3333-4444', severity: 'critical' }], nodes: ['node_modules/ws'] };
  (r.metadata.vulnerabilities as any).critical = 1;
  assert.equal(evaluateAudit(r, exceptions(), lock, today).ok, false);
});

test('the same advisory reached through any other path fails', () => {
  const r = report();
  r.vulnerabilities.zod.nodes = [ZOD, 'node_modules/zod'];
  assert.ok(evaluateAudit(r, exceptions(), lock, today).failures.some(f => f.includes('at node_modules/zod ') && f.includes('not excepted')));
});

test('a new package depending on the excepted node fails', () => {
  const r = report();
  r.vulnerabilities.other = { name: 'other', severity: 'high', via: ['zod'], nodes: ['node_modules/other'] };
  r.metadata.vulnerabilities.high = 3;
  assert.ok(evaluateAudit(r, exceptions(), lock, today).failures.some(f => f.includes('node_modules/other') && f.includes('not an approved dependent')));
});

test('a stale entry fails once the advisory is gone (dependency upgraded or removed)', () => {
  const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } };
  const result = evaluateAudit(clean, exceptions(), {}, today);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('matches no current finding')));
  assert.ok(result.failures.some(f => f.includes('lockfile has no such node')));
});

test('a changed installed version makes the entry stale', () => {
  assert.ok(evaluateAudit(report(), exceptions(), { ...lock, [ZOD]: { version: '3.25.77' } }, today).failures.some(f => f.includes('approved for 3.25.76')));
});

test('a dependent that npm no longer reports makes the entry stale', () => {
  const r = report();
  delete r.vulnerabilities['@wonderwhy-er/desktop-commander'];
  r.metadata.vulnerabilities.high = 1;
  assert.ok(evaluateAudit(r, exceptions(), lock, today).failures.some(f => f.includes('no longer reports')));
});

test('an expired entry fails', () => {
  assert.ok(evaluateAudit(report(), exceptions(), lock, '2027-01-25').failures.some(f => f.includes('expired on 2027-01-24')));
  assert.equal(evaluateAudit(report(), exceptions(), lock, '2027-01-24').ok, true);
});

test('an unusable or inconsistent report fails closed', () => {
  for (const bad of [null, {}, { error: { code: 'ENOAUDIT' } }, { auditReportVersion: 1, vulnerabilities: {} }]) assert.equal(evaluateAudit(bad, exceptions(), lock, today).ok, false);
  const r = report();
  r.metadata.vulnerabilities.high = 1;
  assert.ok(evaluateAudit(r, exceptions(), lock, today).failures.some(f => f.includes('inconsistent')));
});

test('malformed exception entries are rejected', () => {
  const base = exceptions().exceptions[0]!;
  for (const bad of [
    { ...base, advisory: '*' },
    { ...base, path: 'zod' },
    { ...base, package: 'other' },
    { ...base, expiresOn: '2026-10-01' },
    { ...base, approvedOn: 'today' },
    { ...base, reason: '' },
    { ...base, dependents: 'x' },
  ]) assert.equal(parseExceptionFile({ version: 1, exceptions: [bad] }).file, null);
  assert.equal(parseExceptionFile({ version: 1, exceptions: [base, base] }).file, null);
  assert.equal(parseExceptionFile({ exceptions: [] }).file, null);
});

test('the committed exception file is valid and covers only the approved advisory', () => {
  const parsed = parseExceptionFile(JSON.parse(fs.readFileSync(new URL('../security/audit-exceptions.json', import.meta.url), 'utf8')));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.file!.exceptions.map(e => [e.advisory, e.package, e.path, e.installedVersion, e.dependents]), [['GHSA-mrhx-c7xc-m3w5', 'zod', ZOD, '3.25.76', [DC]]]);
});
