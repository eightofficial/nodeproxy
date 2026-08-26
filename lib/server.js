'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// --- round-robin state, one counter per route ---
const counters = new WeakMap();

function pickTarget(route) {
  if (!route.targets || route.targets.length === 0) return null;
  let i = counters.get(route) || 0;
  const target = route.targets[i % route.targets.length];
  counters.set(route, i + 1);
  return target;
}

function matchRoute(routes, hostHeader) {
  const host = (hostHeader || '').split(':')[0].toLowerCase();
  let exact = null;
  let wildcard = null;
  for (const r of routes) {
    if (r.host === host) exact = r;
    if (r.host === '*') wildcard = r;
  }
  return exact || wildcard || null;
}

function log(config, ...args) {
  if (config.logging) {
    console.log(new Date().toISOString(), ...args);
  }
}

function serveStatic(dir, reqUrl, res) {
  const safePath = path.normalize(path.join(dir, decodeURIComponent(reqUrl.split('?')[0])));
  if (!safePath.startsWith(path.resolve(dir))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let filePath = safePath;
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

function proxyRequest(target, req, res, config) {
  const targetUrl = new URL(target);
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, {
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http',
      host: targetUrl.host
    })
  };

  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = client.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    log(config, 'upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('502 Bad Gateway');
  });

  req.pipe(proxyReq, { end: true });
}

// "listener" is one entry from config.servers[] — it carries its own
// routes, so each port is fully independent of the others.
function makeRequestHandler(listener, globalConfig) {
  return function requestHandler(req, res) {
    const route = matchRoute(listener.routes, req.headers.host);

    log(globalConfig, `[:${listener.port}]`, req.method, req.headers.host || '-', req.url, '->', route ? route.host : 'no-match');

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found (no matching route for this host on this port)');
    }

    const target = pickTarget(route);

    if (target) {
      return proxyRequest(target, req, res, globalConfig);
    }

    if (route.staticDir) {
      return serveStatic(route.staticDir, req.url, res);
    }

    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('502 Bad Gateway (no target configured for this host)');
  };
}

// Starts one listener (HTTP, and HTTPS too if enabled+configured for it).
function startListener(listener, globalConfig) {
  const handler = makeRequestHandler(listener, globalConfig);
  const started = [];

  if (listener.https && listener.https.enabled) {
    if (!listener.https.key || !listener.https.cert) {
      console.warn(`[nodeproxy] port ${listener.port}: https.enabled is true but key/cert paths are missing — starting as plain HTTP instead.`);
    } else {
      const httpsOptions = {
        key: fs.readFileSync(listener.https.key),
        cert: fs.readFileSync(listener.https.cert)
      };
      const httpsServer = https.createServer(httpsOptions, handler);
      httpsServer.listen(listener.port, () => {
        console.log(`[nodeproxy] HTTPS listening on port ${listener.port}`);
      });
      started.push(httpsServer);
      return started;
    }
  }

  const httpServer = http.createServer(handler);
  httpServer.listen(listener.port, () => {
    console.log(`[nodeproxy] HTTP listening on port ${listener.port}`);
  });
  started.push(httpServer);
  return started;
}

// Starts every listener defined in config.servers[]. Each one is fully
// independent — different port, different routes, different projects.
function startServer(config) {
  let servers = [];
  for (const listener of config.servers) {
    servers = servers.concat(startListener(listener, config));
  }
  return servers;
}

module.exports = { startServer, matchRoute, pickTarget };
