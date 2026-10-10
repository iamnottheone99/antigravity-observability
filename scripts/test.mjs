import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN = join(ROOT, 'plugin');

console.log('🧪 Running Antigravity Observability Project Tests...\n');

let failed = false;

function checkJson(relPath) {
  const full = join(PLUGIN, relPath);
  try {
    JSON.parse(readFileSync(full, 'utf8'));
    console.log(`  ✓ JSON Valid: ${relPath}`);
  } catch (err) {
    console.error(`  ✗ JSON Invalid: ${relPath} - ${err.message}`);
    failed = true;
  }
}

function checkJs(fullPath, label) {
  try {
    execFileSync('node', ['-c', fullPath]);
    console.log(`  ✓ JS Syntax OK: ${label}`);
  } catch (err) {
    console.error(`  ✗ JS Syntax Error: ${label} - ${err.message}`);
    failed = true;
  }
}

// 1. Manifests
checkJson('plugin.json');
checkJson('sidecars/panel/package.json');
checkJson('sidecars/panel/sidecar.json');

// 2. JavaScript files
checkJs(join(PLUGIN, 'sidecars/panel/main.mjs'), 'plugin/sidecars/panel/main.mjs');
checkJs(join(PLUGIN, 'sidecars/panel/app.js'), 'plugin/sidecars/panel/app.js');
checkJs(join(ROOT, 'scripts/install.mjs'), 'scripts/install.mjs');

// 3. UI Assets
try {
  const html = readFileSync(join(PLUGIN, 'sidecars/panel/index.html'), 'utf8');
  if (html.includes('id="pane-overview"') && html.includes('id="pane-traces"')) {
    console.log('  ✓ HTML Layout: Tab panels verified');
  } else {
    console.error('  ✗ HTML Layout: Missing tab panels');
    failed = true;
  }
} catch (err) {
  console.error(`  ✗ HTML Error: ${err.message}`);
  failed = true;
}

if (failed) {
  console.error('\n❌ Tests failed.');
  process.exit(1);
} else {
  console.log('\n🎉 All checks passed successfully!');
}
