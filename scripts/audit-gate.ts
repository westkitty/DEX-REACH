// Production dependency audit gate: `npm audit --omit=dev`, failing on any high or critical
// advisory except one that matches an owner-approved entry in security/audit-exceptions.json
// exactly. See docs/security/AUDIT_EXCEPTIONS.md. Exit 1 on a policy failure, 2 when npm audit
// itself could not produce a report (registry or transport trouble), 0 when the gate passes.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit, parseExceptionFile } from './lib/audit-exceptions.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runAudit(): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    execFile('npm', ['audit', '--omit=dev', '--json'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolve({ stdout: String(stdout), code });
    });
  });
}

const exceptionPath = path.join(repoRoot, 'security', 'audit-exceptions.json');
const parsed = parseExceptionFile(JSON.parse(await fs.readFile(exceptionPath, 'utf8')));
if (!parsed.file) {
  for (const e of parsed.errors) console.error(`audit exceptions: ${e}`);
  process.exit(1);
}
const lock = JSON.parse(await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> };
const { stdout, code } = await runAudit();
let report: unknown;
try { report = JSON.parse(stdout); } catch {
  console.error(`npm audit exited ${code} without a JSON report; treating as an audit transport failure`);
  process.exit(2);
}
if ((report as { error?: unknown })?.error !== undefined) {
  console.error(`npm audit reported an error: ${JSON.stringify((report as { error: unknown }).error)}`);
  process.exit(2);
}
const today = new Date().toISOString().slice(0, 10);
const result = evaluateAudit(report, parsed.file, lock.packages ?? {}, today);
const meta = (report as { metadata?: { vulnerabilities?: unknown } }).metadata?.vulnerabilities;
console.log(`npm audit --omit=dev: ${JSON.stringify(meta ?? {})}`);
for (const f of result.excepted) console.log(`EXCEPTED (owner-approved, not fixed): ${f.severity} ${f.advisory} in ${f.package} at ${f.path}`);
for (const f of result.failures) console.error(`FAIL: ${f}`);
console.log(result.ok ? 'Production dependency audit PASS (no unexcepted high/critical advisory; every exception current)' : 'Production dependency audit FAIL');
process.exit(result.ok ? 0 : 1);
