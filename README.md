# nodeproxy

A tiny, zero-dependency reverse proxy for Node.js ("a mini nginx"), with:
- **pm2 integration** — nodeproxy can start and keep your own project alive, so you don't have to manually run it first
- **Cloudflare Tunnel integration** — expose your local machine on a real domain, no port forwarding, no static IP

This README is a complete walkthrough from a fresh clone to "my project is live at my domain, and it survives crashes/reboots." Follow it top to bottom the first time; after that, day-to-day usage is one command (Step 8).

---

## What you'll end up with

```
Internet --https--> Cloudflare edge --tunnel--> cloudflared (your machine) --> nodeproxy (8080) --> pm2-managed project (3000)
```

pm2 keeps your project running (and restarts it if it crashes). nodeproxy forwards traffic to it. cloudflared carries traffic to your machine with no exposed ports. One `nodeproxy start --tunnel` brings all three layers up together.

---

## Prerequisites

- **Node.js 16+** — check with `node -v`.
- **npm** — used to auto-install `pm2` if it's missing (no manual install needed).
- **(Only for a public domain) A domain on a Cloudflare account**, nameservers already pointed at Cloudflare. Free plan is fine.
- **(Linux) `curl` and `sudo`** for cloudflared auto-install. **(macOS) Homebrew.**

---



## Step 1 — Register your project so nodeproxy starts it for you

This is the part that removes the "start your project manually first" step. Point it at your project's start command:

```bash
nodeproxy app add myapp --cmd "npm start" --cwd /path/to/your/project
```

- `myapp` — any name you want, used for logs/status later
- `--cmd` — whatever normally boots your project (`npm start`, `node server.js`, `yarn dev`, etc.)
- `--cwd` — the folder that command should run from

This just registers it in `nodeproxy.config.json` — nothing starts yet. Repeat this for each project you have (see multi-project section below).

**Already running your project some other way (Docker, a different process manager, always-on already)?** Skip this step entirely — nodeproxy will just proxy to whatever's listening on the port, same as before.

## Step 2 — Point the proxy at it

By default nodeproxy forwards port 8080 → `http://localhost:3000`. If your project runs on a different port:

```bash
nodeproxy add "*" http://localhost:YOUR_PORT
```

## Step 3 — First full local start

```bash
nodeproxy start
```

Expected output — notice pm2 starting your app automatically, no manual `npm start` needed:
```
[nodeproxy] Using config: /path/to/nodeproxy.config.json
[pm2] Starting "myapp" (npm start) in /path/to/your/project ...
[PM2] Done.
[nodeproxy] HTTP listening on port 8080
```

Verify:
```bash
curl http://localhost:8080
```
You should see your project's actual response — even though you never typed `npm start` yourself.

Check on your app anytime with:
```bash
nodeproxy app list      # status of every registered app
nodeproxy app logs myapp
nodeproxy app stop myapp
```

Stop everything with `Ctrl+C` (nodeproxy) — your app keeps running under pm2 in the background even after that, exactly as pm2 is designed to. Use `nodeproxy app stop myapp` to actually stop it.

## Step 4 — One-time Cloudflare login and tunnel creation

Only needed if you want a real public domain (skip to Step 9 if you're only using this locally).

```bash
nodeproxy tunnel setup --domain app.yourdomain.com --port 8080
```

What happens, in order:
1. **cloudflared install check** — auto-installed if missing (Homebrew on macOS, direct binary on Linux; manual instructions printed if your platform needs it).
2. **Browser login** — opens once so you can click **Authorize** in your Cloudflare account. This is the *only* manual step in the whole setup; it's how Cloudflare's OAuth login works and cannot be scripted by any tool, including Cloudflare's own CLI.
3. **Tunnel creation** — a named tunnel is created for you.
4. **Ingress config** — written to `~/.cloudflared/<name>.yml`, mapping your domain to `http://localhost:8080`.
5. **DNS routing** — the CNAME record is added to Cloudflare DNS automatically.

Expected output:
```
[tunnel] Done! "app.yourdomain.com" now points at your local port 8080.
[tunnel] From now on, just run:  nodeproxy start --tunnel --name app-yourdomain-com
```

## Step 5 — Check DNS propagated

```bash
dig app.yourdomain.com
```
Should resolve to Cloudflare IPs within a minute or so.

## Step 6 — **Go live: the one command you'll use from now on**

```bash
nodeproxy start --tunnel
```

This starts, in order: your registered app(s) via pm2 → the local proxy → the Cloudflare tunnel. Visit `https://app.yourdomain.com` — it should serve your project. TLS is handled by Cloudflare's edge automatically.

## Step 7 — Verify from more than one place

This matters — testing only from the machine running nodeproxy can hide DNS problems:

```bash
# From the same machine — hits the local proxy directly, bypassing Cloudflare entirely
curl -H "Host: app.yourdomain.com" http://localhost:8080

# From the same machine — the real public path, through Cloudflare
curl https://app.yourdomain.com

# From a phone on cellular data, or ask a friend to open it
```

If the first two work but a different device still can't reach it, jump straight to the "works on my machine, not on other devices" section below.

---

## "It works on my machine but not on another device/network"

This is almost always **one specific cause**, not a bug in the proxy: the DNS record Cloudflare created for your tunnel is set to **"DNS only" (grey cloud)** instead of **"Proxied" (orange cloud)**. Tunnel hostnames (`*.cfargotunnel.com`) only resolve *publicly* when proxied — when they're not, they can fail to resolve for everyone except a device that happens to have cached/local name resolution, which is exactly what makes it look like "works for me, not for anyone else."

Diagnose it directly instead of guessing:
```bash
nodeproxy tunnel doctor --domain app.yourdomain.com
```

This checks whether your domain actually resolves to a public IP address (not just whether a DNS record exists) and tells you exactly what's wrong. Example output when it's broken:
```
✗ Does NOT resolve to an IP address publicly — ENOTFOUND. This is almost always
  because the DNS record is set to "DNS only" (grey cloud) in the Cloudflare
  dashboard instead of "Proxied" (orange cloud). Fix: Cloudflare dashboard →
  DNS → click the cloud icon next to this record so it turns orange, then
  wait ~1 minute and retry.
```

**The fix:** log into the Cloudflare dashboard → your domain → DNS → find the record for your subdomain → click the cloud icon next to it so it turns **orange** (Proxied) → wait about a minute → retest.

Other, less common causes if the doctor says DNS is fine but it still doesn't work elsewhere:
- `nodeproxy start --tunnel` isn't actually running at that moment — the tunnel only carries traffic while that process is alive.
- You're testing from a network that blocks outbound HTTPS or has its own DNS overrides (rare, mostly corporate networks).
- You created more than one tunnel for the same domain by accident — run `cloudflared tunnel list` and delete stale ones.

---

## Running more than one project

Each project needs: its own pm2 app registration, its own proxy port, and (if public) its own tunnel.

```bash
# Project A — port 8080
nodeproxy app add appA --cmd "npm start" --cwd /path/to/project-a
nodeproxy add "*" http://localhost:3000        # project A's actual listen port
nodeproxy tunnel setup --domain appA.yourdomain.com --port 8080 --name appA

# Project B — new port 9090
nodeproxy app add appB --cmd "npm start" --cwd /path/to/project-b
nodeproxy listen 9090
nodeproxy add "*" http://localhost:4000 --port 9090   # project B's actual listen port
nodeproxy tunnel setup --domain appB.yourdomain.com --port 9090 --name appB
```

Run each tunnel in its own terminal (or background service — see below):
```bash
nodeproxy start --tunnel --name appA
nodeproxy start --tunnel --name appB
```

---

## Making it survive a reboot / terminal close

`nodeproxy start --tunnel` runs in the foreground. Your pm2-managed app itself will actually survive that terminal closing (pm2 daemonizes it), but the proxy and tunnel won't unless you run one of these:

**pm2 boot persistence** (for your app surviving a full machine reboot):
```bash
pm2 startup     # prints a sudo command — copy/run it, once
pm2 save        # nodeproxy already runs this for you after "start"
```

**systemd (Linux)** for the proxy+tunnel — create `/etc/systemd/system/nodeproxy.service`:
```ini
[Unit]
Description=nodeproxy with Cloudflare Tunnel
After=network.target

[Service]
WorkingDirectory=/path/to/nodeproxy
ExecStart=/usr/bin/env nodeproxy start --tunnel
Restart=always
User=YOUR_USERNAME

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now nodeproxy
```

macOS: use `launchd`, or just keep `nodeproxy start --tunnel` itself under pm2 too (`pm2 start "nodeproxy start --tunnel" --name gateway`).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `502 Bad Gateway` locally | Your app isn't running, wrong port, or pm2 failed to start it | `nodeproxy app list` to check status; `nodeproxy app logs myapp` for errors |
| `404 Not Found (no matching route...)` | No `*` catch-all or matching host on that listener | `nodeproxy add "*" http://localhost:PORT --port PROXY_PORT` |
| pm2 app shows `errored` in `app list` | The `--cmd`/`--cwd` you registered doesn't actually start the app | Test the exact command manually in that folder first, then re-run `nodeproxy app add` |
| Works locally, not on another device | DNS record not proxied (grey cloud) | `nodeproxy tunnel doctor --domain yourdomain.com` — see dedicated section above |
| `tunnel setup` fails at install | Platform isn't auto-installable, or missing sudo/Homebrew | Run the manual command it prints, then retry |
| Browser doesn't open during login | Headless/SSH session | `cloudflared tunnel login` also prints a URL — open it on any device |
| Config changes don't take effect | Config is only read at startup | Restart `nodeproxy start` |

---

## Command reference

```
nodeproxy start [--config <file>] [--tunnel] [--name <name>]
                                          Starts registered apps (pm2), then
                                          the proxy, then the tunnel if
                                          --tunnel is given. The one command.
nodeproxy init  [--config <file>]        Just create the config file.
nodeproxy add <host> <target> [--port <n>] [--config <file>]
                                          Add/update a proxy route.
nodeproxy listen <port> [--config <file>]
                                          Open a new independent listener.

nodeproxy app add <name> --cmd "<cmd>" [--cwd <dir>]
                                          Register a project to be started
                                          and kept alive via pm2.
nodeproxy app list                       Show registered apps + live status.
nodeproxy app logs <name>                Tail an app's logs.
nodeproxy app stop <name>                Stop an app.

nodeproxy tunnel setup --domain <domain> [--name <name>] [--port <n>]
                                          One-time: install, log in, create
                                          tunnel, route DNS.
nodeproxy tunnel start [--name <name>]   Run just the tunnel.
nodeproxy tunnel doctor --domain <domain>
                                          Diagnose public-access DNS issues.

nodeproxy help                           Show all commands.
```

## Config file reference (`nodeproxy.config.json`)

```json
{
  "logging": true,
  "apps": [
    { "name": "myapp", "cmd": "npm start", "cwd": "/path/to/project" }
  ],
  "servers": [
    {
      "port": 8080,
      "https": { "enabled": false, "key": "", "cert": "" },
      "routes": [
        { "host": "*", "targets": ["http://localhost:3000"], "staticDir": null }
      ]
    }
  ]
}
```

- `apps` — projects nodeproxy starts/keeps alive via pm2. Optional.
- `servers` — one entry per proxy port; each fully independent.
- `routes[].host` — real hostname or `"*"` catch-all.
- `routes[].targets` — 2+ enables round-robin load balancing.
- `routes[].staticDir` — serve static files instead of proxying.
- `https` — only for self-managed TLS; not needed with Cloudflare Tunnel.

## Project layout
```
bin/cli.js         CLI entrypoint
lib/server.js      Core proxy engine
lib/config.js      Config loading/creation
lib/cloudflare.js  Cloudflare Tunnel install/login/create/route/run/diagnose
lib/pm2.js         pm2 install/start/stop/list helpers
```

## Known limitations
- No automatic Let's Encrypt renewal for self-managed HTTPS (not needed with Cloudflare Tunnel)
- Round-robin load balancing only
- The Cloudflare browser-login click is inherently manual and one-time per machine — Cloudflare's security design, not a gap here
- `tunnel doctor` diagnoses the most common public-access failure (unproxied DNS); it isn't an exhaustive network debugger
  