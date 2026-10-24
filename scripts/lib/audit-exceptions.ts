// Narrow, owner-approved exceptions to the production dependency audit gate.
//
// The gate is still `npm audit --omit=dev` failing on any high or critical advisory. This module
// only lets a finding through when it matches an exception exactly: the advisory id, the vulnerable
// package, the exact node_modules path, the exact installed version, and the exact set of packages
// npm reports as depending on it. Everything else fails. An exception that no longer matches a
// finding, that matches a different installed version, or that is past its expiry also fails, so an
// upgrade or removal of the affected dependency forces the exception file to be cleaned up rather
// than silently leaving an allowance behind.

export const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

export interface AuditException {
  advisory: string; // GHSA id, e.g. GHSA-mrhx-c7xc-m3w5
  package: string; // vulnerable package name as npm reports it
  path: string; // exact lockfile path of the vulnerable node
  installedVersion: string; // exact version the exception was approved for
  dependents: string[]; // exact node paths npm reports as affected through this node
  reason: string;
  approvedBy: string;
  approvedOn: string; // YYYY-MM-DD
  expiresOn: string; // YYYY-MM-DD; the exception fails after this date
}

export interface AuditExceptionFile { version: 1; exceptions: AuditException[] }

export interface AuditFinding { advisory: string; package: string; path: string; severity: string; title: string }

export interface AuditGateResult {
  ok: boolean;
  findings: AuditFinding[];
  excepted: AuditFinding[];
  failures: string[];
}

interface ViaAdvisory { name?: unknown; url?: unknown; severity?: unknown; title?: unknown; source?: unknown }
interface Vulnerability { name?: unknown; severity?: unknown; via?: unknown; nodes?: unknown }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

function advisoryId(via: ViaAdvisory): string | null {
  const url = typeof via.url === 'string' ? via.url : '';
  const match = /\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/.exec(url);
  return match ? match[1]! : null;
}

export function parseExceptionFile(raw: unknown): { file: AuditExceptionFile | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { exceptions?: unknown }).exceptions)) {
    return { file: null, errors: ['audit exception file must be {"version":1,"exceptions":[...]}'] };
  }
  const exceptions = (raw as { exceptions: unknown[] }).exceptions;
  const seen = new Set<string>();
  exceptions.forEach((entry, index) => {
    const e = entry as Record<string, unknown>;
    const label = `exception[${index}]`;
    for (const field of ['advisory', 'package', 'path', 'installedVersion', 'reason', 'approvedBy', 'approvedOn', 'expiresOn']) {
      if (typeof e?.[field] !== 'string' || (e[field] as string).trim() === '') errors.push(`${label}: ${field} is required`);
    }
    if (!Array.isArray(e?.dependents) || !(e.dependents as unknown[]).every(d => typeof d === 'string')) errors.push(`${label}: dependents must be an array of node paths`);
    if (typeof e?.advisory === 'string' && !GHSA.test(e.advisory)) errors.push(`${label}: advisory must be a GHSA id`);
    if (typeof e?.path === 'string' && !e.path.startsWith('node_modules/')) errors.push(`${label}: path must be an exact node_modules/ lockfile path`);
    if (typeof e?.path === 'string' && typeof e?.package === 'string' && !e.path.endsWith(`node_modules/${e.package}`)) errors.push(`${label}: path does not end in node_modules/${String(e.package)}`);
    for (const field of ['approvedOn', 'expiresOn']) if (typeof e?.[field] === 'string' && !DATE.test(e[field] as string)) errors.push(`${label}: ${field} must be YYYY-MM-DD`);
    if (typeof e?.approvedOn === 'string' && typeof e?.expiresOn === 'string' && e.expiresOn <= e.approvedOn) errors.push(`${label}: expiresOn must be after approvedOn`);
    const key = `${String(e?.advisory)}|${String(e?.path)}`;
    if (seen.has(key)) errors.push(`${label}: duplicate exception for ${key}`);
    seen.add(key);
  });
  return errors.length ? { file: null, errors } : { file: raw as AuditExceptionFile, errors };
}

/**
 * Evaluate an `npm audit --json` report (auditReportVersion 2) against the exception file.
 * `lockPackages` is package-lock.json's `packages` map; `today` is YYYY-MM-DD.
 */
export function evaluateAudit(report: unknown, exceptionFile: AuditExceptionFile, lockPackages: Record<string, { version?: string }>, today: string): AuditGateResult {
  const failures: string[] = [];
  const findings: AuditFinding[] = [];
  const excepted: AuditFinding[] = [];
  const r = report as { auditReportVersion?: unknown; vulnerabilities?: unknown; metadata?: { vulnerabilities?: Record<string, unknown> }; error?: unknown };
  if (!r || typeof r !== 'object' || r.error !== undefined || r.auditReportVersion !== 2 || !r.vulnerabilities || typeof r.vulnerabilities !== 'object') {
    return { ok: false, findings, excepted, failures: ['npm audit did not return a usable report (auditReportVersion 2 with vulnerabilities); refusing to pass'] };
  }
  const vulns = r.vulnerabilities as Record<string, Vulnerability>;

  // Every blocking advisory, at every node path npm reports for it.
  const propagated: { name: string; nodes: string[] }[] = [];
  let blockingEntries = 0;
  for (const [name, vuln] of Object.entries(vulns)) {
    const nodes = Array.isArray(vuln.nodes) ? vuln.nodes.filter((n): n is string => typeof n === 'string') : [];
    const via = Array.isArray(vuln.via) ? vuln.via : [];
    if (typeof vuln.severity === 'string' && BLOCKING_SEVERITIES.has(vuln.severity)) blockingEntries++;
    let direct = false;
    for (const v of via) {
      if (typeof v === 'string') continue;
      const adv = v as ViaAdvisory;
      if (typeof adv.severity !== 'string' || !BLOCKING_SEVERITIES.has(adv.severity)) continue;
      direct = true;
      const id = advisoryId(adv);
      if (!id) { failures.push(`${name}: blocking advisory without a GHSA url (${String(adv.url ?? adv.source)}); cannot be excepted`); continue; }
      if (nodes.length === 0) failures.push(`${name}: blocking advisory ${id} reported without node paths`);
      for (const path of nodes) findings.push({ advisory: id, package: typeof adv.name === 'string' ? adv.name : name, path, severity: adv.severity, title: typeof adv.title === 'string' ? adv.title : '' });
    }
    if (!direct && typeof vuln.severity === 'string' && BLOCKING_SEVERITIES.has(vuln.severity)) propagated.push({ name, nodes });
  }

  const declared = r.metadata?.vulnerabilities;
  if (declared && typeof declared === 'object') {
    const counted = Number(declared.high ?? 0) + Number(declared.critical ?? 0);
    if (counted !== blockingEntries) failures.push(`npm audit metadata reports ${counted} high/critical entries but the report lists ${blockingEntries}; refusing to pass an inconsistent report`);
  }

  const used = new Set<AuditException>();
  for (const finding of findings) {
    const match = exceptionFile.exceptions.find(e => e.advisory === finding.advisory && e.package === finding.package && e.path === finding.path);
    if (!match) { failures.push(`${finding.severity} ${finding.advisory} in ${finding.package} at ${finding.path} (${finding.title}) is not excepted`); continue; }
    used.add(match);
    excepted.push(finding);
  }

  // A package that is only affected through a vulnerable dependency is acceptable only when it is an
  // approved dependent of an excepted node; anything else means a new path reaches the advisory.
  const approvedDependents = new Set([...used].flatMap(e => e.dependents));
  for (const entry of propagated) {
    for (const node of entry.nodes) if (!approvedDependents.has(node)) failures.push(`${entry.name} at ${node} is affected through a vulnerable dependency and is not an approved dependent of any exception`);
    if (entry.nodes.length === 0) failures.push(`${entry.name}: affected entry reported without node paths`);
  }

  for (const exception of exceptionFile.exceptions) {
    const label = `${exception.advisory} at ${exception.path}`;
    if (today > exception.expiresOn) failures.push(`exception ${label} expired on ${exception.expiresOn}; re-review with the owner or remove it`);
    const installed = lockPackages[exception.path]?.version;
    if (installed !== exception.installedVersion) failures.push(`exception ${label} was approved for ${exception.installedVersion} but the lockfile has ${installed ?? 'no such node'}; the exception is stale, remove or re-approve it`);
    if (!used.has(exception)) { failures.push(`exception ${label} matches no current finding; it is stale, remove it`); continue; }
    const actualDependents = propagated.filter(p => p.nodes.some(n => exception.dependents.includes(n))).flatMap(p => p.nodes);
    for (const dependent of exception.dependents) if (!actualDependents.includes(dependent)) failures.push(`exception ${label} lists dependent ${dependent}, which npm no longer reports; the exception is stale, update it`);
  }

  return { ok: failures.length === 0, findings, excepted, failures };
}
