// Ensure better-sqlite3's native binary matches the *running* Node ABI.
//
// better-sqlite3 ships a prebuilt .node compiled for a specific Node ABI
// (NODE_MODULE_VERSION). If the active Node differs from the one the binary was
// fetched/built for — common with version managers like fnm/nvm that auto-switch
// per directory — `require('better-sqlite3')` throws at load time. At server
// import that crashes the boot, and under `npm run dev` (tsx watch) the inner
// server never binds :8787, so Vite surfaces it as endless
// "ECONNREFUSED — ws proxy error" noise with no obvious cause.
//
// This guard loads the module in a throwaway process: succeeds instantly on the
// happy path (no cost to normal startups), and only on an ABI mismatch does it
// rebuild for the current Node. Real failures (missing dependency, etc.) are
// re-thrown untouched so we never paper over a genuine break.

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  require('better-sqlite3');
} catch (err) {
  const msg = String(err && err.message);
  const abiMismatch =
    /NODE_MODULE_VERSION|compiled against a different Node|was compiled against|invalid ELF header|dlopen|not a valid Win32 application/i.test(
      msg,
    );
  if (!abiMismatch) throw err; // a real problem — surface it, don't mask it
  console.log(
    '[ensure-native] better-sqlite3 was built for a different Node — rebuilding for this one…',
  );
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
  console.log('[ensure-native] done.');
}
