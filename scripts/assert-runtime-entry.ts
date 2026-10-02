import { verifyRuntimeRelease } from './lib/runtime-release.js';

try {
  await verifyRuntimeRelease(process.cwd());
  console.log('Required gateway/node/runtime entries exist.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
