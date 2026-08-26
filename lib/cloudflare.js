'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CF_DIR = path.join(os.homedir(), '.cloudflared');

function isInstalled() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installInstructions() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return 'brew install cloudflared';
  }
  if (platform === 'linux') {
    return [
      '# Debian/Ubuntu (x86_64):',
      'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb && sudo dpkg -i cloudflared.deb',
      '',
      '# Or as a plain binary (any distro, x86_64):',
      'sudo curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && sudo chmod +x /usr/local/bin/cloudflared'
    ].join('\n');
  }
  if (platform === 'win32') {
    return 'winget install --id Cloudflare.cloudflared\n# or: choco install cloudflared';
  }
  return 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

// Best-effort automatic install. Returns true on success.
function tryAutoInstall() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      console.log('[tunnel] Installing cloudflared via Homebrew...');
      execSync('brew install cloudflared', { stdio: 'inherit' });
      return isInstalled();
    }
    if (platform === 'linux') {
      console.log('[tunnel] Installing cloudflared binary to /usr/local/bin ...');
      execSync(
        'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared && ' +
        'chmod +x /tmp/cloudflared && ' +
        '(sudo mv /tmp/cloudflared /usr/local/bin/cloudflared || mv /tmp/cloudflared /usr/local/bin/cloudflared)',
        { stdio: 'inherit' }
      );
      return isInstalled();
    }
  } catch (err) {
    console.warn('[tunnel] Automatic install failed:', err.message);
  }
  return false;
}

function ensureInstalled() {
  if (isInstalled()) return true;
  console.log('[tunnel] cloudflared not found — attempting automatic install...');
  if (tryAutoInstall()) {
    console.log('[tunnel] cloudflared installed successfully.');
    return true;
  }
  console.error('\n[tunnel] Could not auto-install cloudflared. Install it manually with:\n');
  console.error(installInstructions());
  console.error('\nThen re-run this command.\n');
  return false;
}

function isLoggedIn() {
  return fs.existsSync(path.join(CF_DIR, 'cert.pem'));
}

// Opens a browser for the one-time Cloudflare account authorization.
// This step is inherently interactive (OAuth) and cannot be scripted away.
function login() {
  console.log('\n[tunnel] Opening your browser to authorize this machine with your Cloudflare account.');
  console.log('[tunnel] (One-time step. After this, everything is fully automatic.)\n');
  execSync('cloudflared tunnel login', { stdio: 'inherit' });
}

function tunnelExists(name) {
  try {
    const out = execSync('cloudflared tunnel list -o json', { encoding: 'utf8' });
    const list = JSON.parse(out);
    return list.some(t => t.name === name);
  } catch {
    return false;
  }
}

function createTunnel(name) {
  console.log(`[tunnel] Creating tunnel "${name}"...`);
  execSync(`cloudflared tunnel create ${name}`, { stdio: 'inherit' });
}

function getTunnelId(name) {
  const out = execSync('cloudflared tunnel list -o json', { encoding: 'utf8' });
  const list = JSON.parse(out);
  const match = list.find(t => t.name === name);
  return match ? match.id : null;
}

function routeDns(name, domain) {
  console.log(`[tunnel] Pointing ${domain} at tunnel "${name}"...`);
  execSync(`cloudflared tunnel route dns ${name} ${domain}`, { stdio: 'inherit' });
}

// Writes the cloudflared ingress config that maps the public domain
// to the local nodeproxy port.
function writeIngressConfig(name, tunnelId, domain, localPort) {
  const credFile = path.join(CF_DIR, `${tunnelId}.json`);
  const configYml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credFile}`,
    'ingress:',
    `  - hostname: ${domain}`,
    `    service: http://localhost:${localPort}`,
    '  - service: http_status:404',
    ''
  ].join('\n');
  const configPath = path.join(CF_DIR, `${name}.yml`);
  fs.writeFileSync(configPath, configYml);
  return configPath;
}

// Runs the tunnel as a background child process. Returns the child so
// the caller can manage its lifecycle alongside the local proxy.
function runTunnel(name) {
  const configPath = path.join(CF_DIR, `${name}.yml`);
  console.log(`[tunnel] Starting cloudflared tunnel "${name}"...`);
  const child = spawn('cloudflared', ['tunnel', '--config', configPath, 'run', name], {
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    console.log(`[tunnel] cloudflared exited with code ${code}`);
  });
  return child;
}

const dns = require('dns').promises;

// Diagnoses the single most common cause of "works on my machine but not
// on other devices/networks": the DNS record Cloudflare created for the
// tunnel is set to "DNS only" (grey cloud) instead of "Proxied" (orange
// cloud). Tunnel hostnames only resolve publicly when proxied — an
// unproxied record either fails to resolve for everyone else, or resolves
// to an address only reachable from networks that already have a route to
// it (which can look like "it works for me" if you're testing from
// somewhere with cached/local resolution).
async function diagnose(domain) {
  const results = { domain, checks: [] };

  let cname = null;
  try {
    const records = await dns.resolveCname(domain);
    cname = records[0];
    results.checks.push({ ok: true, label: 'CNAME record found', detail: cname });
  } catch (err) {
    results.checks.push({ ok: false, label: 'No CNAME record found', detail: err.code });
  }

  if (cname && !cname.includes('cfargotunnel.com')) {
    results.checks.push({
      ok: false,
      label: 'CNAME does not point at a Cloudflare Tunnel',
      detail: `Points at "${cname}" instead of a *.cfargotunnel.com address. Re-run "nodeproxy tunnel setup" to fix routing.`
    });
  }

  try {
    const addrs = await dns.resolve4(domain);
    results.checks.push({ ok: true, label: 'Resolves to an IP address publicly', detail: addrs.join(', ') });
    results.publiclyResolvable = true;
  } catch (err) {
    results.publiclyResolvable = false;
    results.checks.push({
      ok: false,
      label: 'Does NOT resolve to an IP address publicly',
      detail: `${err.code}. This is almost always because the DNS record is set to "DNS only" (grey cloud) in the Cloudflare dashboard instead of "Proxied" (orange cloud). Fix: Cloudflare dashboard → DNS → click the cloud icon next to this record so it turns orange, then wait ~1 minute and retry.`
    });
  }

  return results;
}

function printDiagnosis(results) {
  console.log(`\n[tunnel doctor] Checking ${results.domain} ...\n`);
  for (const c of results.checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (results.publiclyResolvable) {
    console.log('\n[tunnel doctor] DNS looks correctly configured for public access.');
    console.log('If it still only works on your own machine, check: is "nodeproxy start --tunnel" actually running right now? The tunnel only carries traffic while that process is alive.\n');
  } else {
    console.log('\n[tunnel doctor] This is why other devices can\'t reach it — see the fix above.\n');
  }
}

module.exports = {
  isInstalled,
  ensureInstalled,
  installInstructions,
  isLoggedIn,
  login,
  tunnelExists,
  createTunnel,
  getTunnelId,
  routeDns,
  writeIngressConfig,
  runTunnel,
  diagnose,
  printDiagnosis,
  CF_DIR
};
