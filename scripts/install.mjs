import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'plugin');
const TARGET_BASE = join(homedir(), '.gemini', 'config', 'plugins');
const TARGET = join(TARGET_BASE, 'agent-observability');

console.log('📦 Installing Antigravity Observability Extension...');
console.log(`Source: ${SOURCE}`);
console.log(`Target: ${TARGET}`);

try {
  if (!existsSync(TARGET_BASE)) {
    mkdirSync(TARGET_BASE, { recursive: true });
  }

  cpSync(SOURCE, TARGET, { recursive: true });

  console.log('\n✅ Successfully installed agent-observability plugin!');
  console.log('\nNext steps:');
  console.log('1. In Google Antigravity, click "Customizations" in the left sidebar.');
  console.log('2. Under the "Installed" tab, toggle "agent-observability" ON (or OFF and ON to reload).');
  console.log('3. Open any conversation, click ⋮ (three-dot menu) -> Extensions -> Observability.');
} catch (err) {
  console.error(`\n❌ Installation failed: ${err.message}`);
  process.exit(1);
}
