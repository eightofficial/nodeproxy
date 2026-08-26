'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_NAME = 'nodeproxy.config.json';

function defaultConfig() {
  return {
    // Request logging to stdout (applies to all listeners)
    logging: true,

    // Backend project(s) that nodeproxy will start and keep alive for you
    // via pm2, so you don't have to manually run "npm start" yourself
    // before the proxy has anything to forward to. Optional — leave this
    // empty if you're already running your project some other way.
    apps: [
      // { "name": "myapp", "cmd": "npm start", "cwd": "/path/to/project" }
    ],

    // One entry per port you want the proxy to listen on.
    // Each listener has its own independent set of host-based routes,
    // so project A can live on 8080 and project B on 9090, fully
    // separate from each other.
    servers: [
      {
        port: 8080,
        https: {
          enabled: false,
          key: '',   // path to privkey.pem
          cert: ''   // path to fullchain.pem
        },
        // Virtual hosts / routes for THIS listener.
        // "host" supports "*" as a catch-all for local testing.
        // "targets" is a list -> automatic round-robin load balancing.
        routes: [
          {
            host: '*',
            targets: ['http://localhost:3000'],
            // If set, static files are served from this directory when
            // no upstream target responds (or as the sole behavior if
            // targets is empty).
            staticDir: null
          }
        ]
      }
    ]
  };
}

// Accepts either the current multi-listener format ({ servers: [...] })
// or the old single-listener format ({ port, https, routes }) and always
// returns the multi-listener shape, so old config files keep working.
function normalizeConfig(config) {
  if (Array.isArray(config.servers)) {
    if (!Array.isArray(config.apps)) config.apps = [];
    return config;
  }

  return {
    logging: config.logging !== false,
    apps: Array.isArray(config.apps) ? config.apps : [],
    servers: [
      {
        port: config.port || 8080,
        https: config.https || { enabled: false, key: '', cert: '' },
        routes: config.routes || []
      }
    ]
  };
}

function configPath(customPath) {
  return customPath
    ? path.resolve(process.cwd(), customPath)
    : path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
}

function ensureConfig(customPath) {
  const file = configPath(customPath);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2) + '\n');
  }
  return file;
}

function loadConfig(customPath) {
  const file = ensureConfig(customPath);
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return { config: normalizeConfig(JSON.parse(raw)), file };
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }
}

function saveConfig(config, customPath) {
  const file = configPath(customPath);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

module.exports = { defaultConfig, normalizeConfig, configPath, ensureConfig, loadConfig, saveConfig, DEFAULT_CONFIG_NAME };
