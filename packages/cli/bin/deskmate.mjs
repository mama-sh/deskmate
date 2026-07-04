#!/usr/bin/env node
// Committed bin stub. It exists at install time (unlike the gitignored/built
// `dist/cli.js`), so pnpm/npm can always create the `deskmate` bin symlink when
// the package is linked — then this loads the compiled CLI. Node strips the
// shebang from `dist/cli.js` when it is imported (only the entry file keeps one).
import "../dist/cli.js";
