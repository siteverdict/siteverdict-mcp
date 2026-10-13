// Makes dist/cli.js executable (npm sets the mode on install too; this helps local runs).
import { chmodSync } from 'node:fs';
try { chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755); } catch { /* windows */ }
