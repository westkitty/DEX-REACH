import { readOAuthRuntimeHealth } from '../src/shared/oauth-diagnostics.js';
import { stateDir } from '../src/shared/local-env.js';

const health = await readOAuthRuntimeHealth(stateDir());
if (!health) {
  console.error('OAuth health is unavailable; the gateway has not written runtime token evidence.');
  process.exitCode = 2;
} else if (health.token5xx > 0) {
  console.error(JSON.stringify({
    ok: false,
    token5xx: health.token5xx,
    token4xx: health.token4xx,
    token2xx: health.token2xx,
    lastFailureAt: health.lastFailureAt,
    lastFailureCode: health.lastFailureCode
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    token5xx: 0,
    token4xx: health.token4xx,
    token2xx: health.token2xx,
    lastSuccessAt: health.lastSuccessAt
  }));
}
