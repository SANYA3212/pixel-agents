/**
 * Test isolation on Windows: suites sandbox the user's home by pointing
 * `process.env.HOME` at a temp dir, but on Windows `os.homedir()` reads
 * USERPROFILE and ignores HOME — so those suites read and WROTE the real
 * ~/.pixel-agents/config.json. Make os.homedir() follow HOME on win32 (the
 * POSIX behaviour every suite assumes). No-op on Linux/macOS.
 */

import { syncBuiltinESMExports } from 'node:module';

if (process.platform === 'win32') {
  // The mutable CommonJS module object (an ESM namespace is read-only).
  const os = process.getBuiltinModule('node:os');
  const realHomedir = os.homedir.bind(os);
  os.homedir = () => {
    const home = process.env.HOME;
    return home && /^[A-Za-z]:[\\/]/.test(home) ? home : realHomedir();
  };
  // Propagate to `import * as os from 'os'` namespaces in the code under test.
  syncBuiltinESMExports();
}
