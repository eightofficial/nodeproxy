'use strict';

const { execSync, spawnSync } = require('child_process');

function isInstalled() {
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureInstalled() {
  if (isInstalled()) return true;
  console.log('[pm2] pm2 not found — installing globally via npm...');
  try {
    execSync('npm install -g pm2', { stdio: 'inherit' });
    return isInstalled();
  } catch (err) {
    console.error('[pm2] Automatic install failed:', err.message);
    console.error('[pm2] Install it manually with: npm install -g pm2');
    return false;
  }
}

function listApps() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8' });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function isRunning(name) {
  return listApps().some(p => p.name === name && p.pm2_env && p.pm2_env.status === 'online');
}

// Starts (or restarts, if already registered) an app under pm2.
// { name, cmd, cwd } — cmd can be "npm start", "node server.js", etc.
function startApp({ name, cmd, cwd }) {
  const exists = listApps().some(p => p.name === name);
  if (exists) {
    console.log(`[pm2] "${name}" already registered — restarting it.`);
    const res = spawnSync('pm2', ['restart', name], { stdio: 'inherit' });
    return res.status === 0;
  }

  console.log(`[pm2] Starting "${name}" (${cmd}) in ${cwd || process.cwd()} ...`);
  // Split "npm start" style commands into interpreter + args so pm2 can
  // manage them directly rather than as a raw shell string.
  const parts = cmd.trim().split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);

  const pm2Args = ['start', bin, '--name', name];
  if (cwd) pm2Args.push('--cwd', cwd);
  if (args.length) pm2Args.push('--', ...args);

  const res = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  return res.status === 0;
}

function stopApp(name) {
  spawnSync('pm2', ['stop', name], { stdio: 'inherit' });
}

function deleteApp(name) {
  spawnSync('pm2', ['delete', name], { stdio: 'inherit' });
}

function logs(name) {
  spawnSync('pm2', ['logs', name], { stdio: 'inherit' });
}

// Persists the current pm2 process list so it comes back after a reboot,
// PROVIDED "pm2 startup" has also been run once (that step needs sudo and
// is printed to the user rather than run automatically).
function save() {
  spawnSync('pm2', ['save'], { stdio: 'inherit' });
}

function printStartupInstructions() {
  console.log('\n[pm2] To make your app(s) survive a machine reboot, run this once:');
  console.log('  pm2 startup');
  console.log('  (then copy/run the sudo command it prints)');
  console.log('  pm2 save\n');
}

module.exports = {
  isInstalled,
  ensureInstalled,
  listApps,
  isRunning,
  startApp,
  stopApp,
  deleteApp,
  logs,
  save,
  printStartupInstructions
};
