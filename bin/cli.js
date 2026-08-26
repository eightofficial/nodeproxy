#!/usr/bin/env node
'use strict';

const { loadConfig, saveConfig, ensureConfig, DEFAULT_CONFIG_NAME } = require('../lib/config');
const { startServer } = require('../lib/server');
const cf = require('../lib/cloudflare');
const pm2 = require('../lib/pm2');

function usage() {
  console.log(`
nodeproxy - a tiny reverse proxy / web server (like a mini nginx)

Usage:
  nodeproxy start [--config <file>]        Start the proxy (auto-creates a
                                            default config on first run)
  nodeproxy init  [--config <file>]        Just create the config file
  nodeproxy add <host> <target> [--port <n>] [--config <file>]
                                            Add/update a route, e.g.
                                            nodeproxy add example.com http://localhost:4000
                                            Targets the first listener unless
                                            --port picks a specific one.
  nodeproxy listen <port>  [--config <file>]
                                            Add a brand new listener on a new
                                            port, e.g. nodeproxy listen 9090
                                            (then "nodeproxy add ... --port 9090")

  nodeproxy tunnel setup --domain <domain> [--name <name>] [--port <n>]
                                            One-time: install cloudflared if
                                            needed, log in (opens a browser,
                                            you click Authorize once), create
                                            a tunnel, and point <domain> at
                                            your local port (default 8080).
  nodeproxy tunnel start [--name <name>]   Run just the tunnel.
  nodeproxy tunnel doctor --domain <domain>
                                            Diagnose "works locally but not
                                            on other devices" issues.

  nodeproxy app add <name> --cmd "<command>" [--cwd <dir>]
                                            Register your own project to be
                                            started/kept alive automatically
                                            (via pm2), e.g.
                                            nodeproxy app add myapp --cmd "npm start" --cwd ./my-project
  nodeproxy app list                       Show registered/running apps.
  nodeproxy app logs <name>                Tail logs for a registered app.
  nodeproxy app stop <name>                Stop a registered app.

  nodeproxy start [--config <file>] [--tunnel] [--name <name>]
                                            Starts any registered apps (via
                                            pm2), then the proxy, then the
                                            tunnel if --tunnel is given.
                                            This is the one command that
                                            brings everything up together.

  nodeproxy help                           Show this message

One-command quick start:
  npx nodeproxy start
`);
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'start';
  const configPath = getFlag(args, '--config');

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    return usage();
  }

  if (cmd === 'init') {
    const file = ensureConfig(configPath);
    console.log(`[nodeproxy] Config ready at ${file}`);
    return;
  }

  if (cmd === 'add') {
    const host = args[1];
    const target = args[2];
    const portFlag = getFlag(args, '--port');
    if (!host || !target) {
      console.error('Usage: nodeproxy add <host> <target> [--port <n>]');
      process.exit(1);
    }
    const { config, file } = loadConfig(configPath);
    const listener = portFlag
      ? config.servers.find(s => String(s.port) === String(portFlag))
      : config.servers[0];
    if (!listener) {
      console.error(`No listener on port ${portFlag}. Create one first with: nodeproxy listen ${portFlag}`);
      process.exit(1);
    }
    const existing = listener.routes.find(r => r.host === host);
    if (existing) {
      existing.targets = [target];
    } else {
      listener.routes.push({ host, targets: [target], staticDir: null });
    }
    saveConfig(config, configPath);
    console.log(`[nodeproxy] Route added: ${host} -> ${target} on port ${listener.port} (${file})`);
    return;
  }

  if (cmd === 'listen') {
    const port = Number(args[1]);
    if (!port) {
      console.error('Usage: nodeproxy listen <port>');
      process.exit(1);
    }
    const { config, file } = loadConfig(configPath);
    if (config.servers.some(s => s.port === port)) {
      console.error(`Port ${port} already has a listener.`);
      process.exit(1);
    }
    config.servers.push({
      port,
      https: { enabled: false, key: '', cert: '' },
      routes: []
    });
    saveConfig(config, configPath);
    console.log(`[nodeproxy] New listener added on port ${port} (${file}). Now add routes to it with: nodeproxy add <host> <target> --port ${port}`);
    return;
  }

  if (cmd === 'tunnel') {
    const sub = args[1];
    const domain = getFlag(args, '--domain');
    const name = getFlag(args, '--name') || (domain ? domain.replace(/\./g, '-') : 'nodeproxy-tunnel');
    const port = Number(getFlag(args, '--port')) || 8080;

    if (sub === 'setup') {
      if (!domain) {
        console.error('Usage: nodeproxy tunnel setup --domain <yourdomain.com> [--name <name>] [--port <n>]');
        console.error('(Your domain must already be added to your Cloudflare account.)');
        process.exit(1);
      }
      if (!cf.ensureInstalled()) process.exit(1);
      if (!cf.isLoggedIn()) {
        cf.login();
      } else {
        console.log('[tunnel] Already logged in to Cloudflare on this machine.');
      }
      if (!cf.tunnelExists(name)) {
        cf.createTunnel(name);
      } else {
        console.log(`[tunnel] Tunnel "${name}" already exists — reusing it.`);
      }
      const tunnelId = cf.getTunnelId(name);
      cf.writeIngressConfig(name, tunnelId, domain, port);
      cf.routeDns(name, domain);
      console.log(`\n[tunnel] Done! "${domain}" now points at your local port ${port}.`);
      console.log(`[tunnel] From now on, just run:  nodeproxy start --tunnel --name ${name}\n`);
      return;
    }

    if (sub === 'start') {
      cf.runTunnel(name);
      return;
    }

    if (sub === 'doctor') {
      if (!domain) {
        console.error('Usage: nodeproxy tunnel doctor --domain <domain>');
        process.exit(1);
      }
      cf.diagnose(domain).then(cf.printDiagnosis);
      return;
    }

    console.error('Usage: nodeproxy tunnel setup --domain <domain>   |   nodeproxy tunnel start [--name <name>]   |   nodeproxy tunnel doctor --domain <domain>');
    process.exit(1);
  }

  if (cmd === 'app') {
    const sub = args[1];

    if (sub === 'add') {
      const name = args[2];
      const appCmd = getFlag(args, '--cmd');
      const cwd = getFlag(args, '--cwd');
      if (!name || !appCmd) {
        console.error('Usage: nodeproxy app add <name> --cmd "<command>" [--cwd <dir>]');
        process.exit(1);
      }
      const { config, file } = loadConfig(configPath);
      const existing = config.apps.find(a => a.name === name);
      const entry = { name, cmd: appCmd, cwd: cwd || process.cwd() };
      if (existing) {
        Object.assign(existing, entry);
      } else {
        config.apps.push(entry);
      }
      saveConfig(config, configPath);
      console.log(`[nodeproxy] Registered app "${name}" (${appCmd}) in ${file}`);
      console.log('[nodeproxy] It will now start automatically with "nodeproxy start".');
      return;
    }

    if (sub === 'list') {
      const { config } = loadConfig(configPath);
      if (config.apps.length === 0) {
        console.log('No apps registered. Add one with: nodeproxy app add <name> --cmd "<command>"');
        return;
      }
      const running = pm2.isInstalled() ? pm2.listApps() : [];
      for (const a of config.apps) {
        const proc = running.find(p => p.name === a.name);
        const status = proc ? proc.pm2_env.status : 'not running';
        console.log(`- ${a.name}: ${a.cmd} (${a.cwd}) [${status}]`);
      }
      return;
    }

    if (sub === 'stop') {
      const name = args[2];
      if (!name) {
        console.error('Usage: nodeproxy app stop <name>');
        process.exit(1);
      }
      pm2.stopApp(name);
      return;
    }

    if (sub === 'logs') {
      const name = args[2];
      if (!name) {
        console.error('Usage: nodeproxy app logs <name>');
        process.exit(1);
      }
      pm2.logs(name);
      return;
    }

    console.error('Usage: nodeproxy app add <name> --cmd "<command>" [--cwd <dir>]   |   list   |   stop <name>   |   logs <name>');
    process.exit(1);
  }

  if (cmd === 'start') {
    const { config, file } = loadConfig(configPath);
    console.log(`[nodeproxy] Using config: ${file}`);
    if (file.endsWith(DEFAULT_CONFIG_NAME)) {
      console.log('[nodeproxy] (edit this file, or use "nodeproxy add <host> <target>", to change routing)');
    }

    if (config.apps && config.apps.length > 0) {
      if (!pm2.ensureInstalled()) {
        console.error('[nodeproxy] Could not set up pm2 — registered apps will not be started automatically.');
      } else {
        for (const app of config.apps) {
          pm2.startApp(app);
        }
        pm2.save();
      }
    }

    startServer(config);

    if (args.includes('--tunnel')) {
      const name = getFlag(args, '--name') || 'nodeproxy-tunnel';
      if (!cf.isInstalled()) {
        console.error('[tunnel] cloudflared is not installed. Run "nodeproxy tunnel setup --domain <domain>" first.');
        return;
      }
      cf.runTunnel(name);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();
