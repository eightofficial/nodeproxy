# nodeproxy

A tiny, zero-dependency reverse proxy for Node.js ("a mini nginx") with built-in Cloudflare Tunnel support — so a project running on your own machine can be reached at a real domain, with no port forwarding and no static IP.

This README is a complete walkthrough from a fresh clone to a live public domain. Follow it top to bottom the first time; after that, day-to-day usage is a single command (Step 7).

---

## What you'll end up with

```
Internet  --https-->  Cloudflare edge  --tunnel-->  cloudflared (your machine)  -->  nodeproxy (port 8080)  -->  your project (e.g. port 3000)
```

Cloudflare terminates TLS and routes traffic through an outbound-only tunnel to `cloudflared` on your machine. `cloudflared` hands it to `nodeproxy`, which routes it to whichever local project you've configured. Nothing needs to be exposed on your router or firewall.

---

## Prerequisites

Before you start, make sure you have:

- **Node.js 16 or newer** — check with `node -v`. Get it from https://nodejs.org if missing.
- **A project already running locally** that you want to expose — e.g. something listening on `http://localhost:3000`. It can be anything (Express, Next.js, a static site server, etc.) — nodeproxy just forwards to it.
- **(Only if using a real domain) A domain added to a Cloudflare account**, with its nameservers pointed at Cloudflare. The free plan is enough. If you just want to test locally without a public domain, skip Steps 5–7.
- **(Linux only, for auto-install) `curl` and `sudo`** available in your shell.
- **(macOS only, for auto-install) Homebrew** installed (https://brew.sh).

---

## Step 1 — Get the files

Unzip the package and move into it:

```bash
unzip nodeproxy.zip
cd nodeproxy
```

## Step 2 — Make the `nodeproxy` command available

```bash
npm link
```

This registers `nodeproxy` as a global command pointing at this folder. Verify it worked:

```bash
nodeproxy help
```

You should see the full command list. (If you'd rather not touch global npm links, you can run everything below as `node bin/cli.js ...` instead of `nodeproxy ...` — they're equivalent.)

## Step 3 — Start the proxy for the first time

```bash
nodeproxy start
```

Expected output:
```
[nodeproxy] Using config: /path/to/nodeproxy.config.json
[nodeproxy] (edit this file, or use "nodeproxy add <host> <target>", to change routing)
[nodeproxy] HTTP listening on port 8080
```

On this first run, nodeproxy auto-creates `nodeproxy.config.json` next to the CLI, defaulting to: listen on port 8080, forward everything to `http://localhost:3000`.

Leave this running and, in a second terminal, check it works:

```bash
curl http://localhost:8080
```

If your project is already running on port 3000, you'll see its response. If not, you'll get a `502 Bad Gateway` — that's expected until your project is up; it just means the proxy itself is working correctly.

Stop it for now with `Ctrl+C` — you'll restart it with the tunnel in Step 7.

## Step 4 — Point it at your actual project(s)

If your project runs on a port other than 3000, edit `nodeproxy.config.json` directly, or:

```bash
nodeproxy add "*" http://localhost:YOUR_PORT
```

**Running more than one project?** Give each its own listener/port on the proxy side:

```bash
nodeproxy listen 9090
nodeproxy add "*" http://localhost:4000 --port 9090
```

Now port 8080 and port 9090 on the proxy are two completely independent routes. You can also route by domain name instead of `*` if a single port should serve multiple domains — see `nodeproxy.config.json` for the `routes` array format (each entry is `{ host, targets, staticDir }`).

Skip to Step 8 if you only want local routing and don't need a public domain yet.

## Step 5 — One-time Cloudflare login and tunnel creation

```bash
nodeproxy tunnel setup --domain app.yourdomain.com --port 8080
```

Replace `app.yourdomain.com` with the actual subdomain you want live, and `8080` with whichever proxy port you want it to reach (from Step 4).

What happens, in order:

1. **cloudflared install check.** If missing, nodeproxy tries to install it automatically (Homebrew on macOS, direct binary download on Linux). If auto-install fails on your platform, it prints the exact manual install command and stops — just run that command and re-run `tunnel setup`.
2. **Browser login.** If this machine hasn't authorized with Cloudflare before, your browser opens to a Cloudflare page. Log in and click **Authorize**. This is the one manual step in the entire setup — it's how Cloudflare's OAuth flow works and can't be scripted by any tool. It only happens once per machine.
3. **Tunnel creation.** Creates a named tunnel (defaults to your domain with dots replaced by dashes, e.g. `app-yourdomain-com`).
4. **Ingress config.** Writes `~/.cloudflared/<name>.yml` mapping your domain to `http://localhost:8080` (or whichever port you passed).
5. **DNS routing.** Automatically adds the CNAME record in your Cloudflare DNS pointing your domain at the tunnel.

Expected final output:
```
[tunnel] Done! "app.yourdomain.com" now points at your local port 8080.
[tunnel] From now on, just run:  nodeproxy start --tunnel --name app-yourdomain-com
```

## Step 6 — DNS propagation

Cloudflare DNS usually updates within seconds to a couple of minutes. You can check with:

```bash
dig app.yourdomain.com
```

You should see it resolving to Cloudflare's IPs (not your own). This confirms DNS is correctly routed — the tunnel itself only carries traffic once it's actually running (next step).

## Step 7 — Go live (the one command you'll use from now on)

```bash
nodeproxy start --tunnel
```

This single command starts both the local proxy and the Cloudflare tunnel together. Expected output:
```
[nodeproxy] Using config: /path/to/nodeproxy.config.json
[nodeproxy] HTTP listening on port 8080
[tunnel] Starting cloudflared tunnel "app-yourdomain-com"...
```

Visit `https://app.yourdomain.com` in a browser — it should now serve your local project. TLS is handled entirely by Cloudflare's edge, so `https://` works immediately with no certificates on your end.

If you created the tunnel with a custom `--name` in Step 5, pass it here too:
```bash
nodeproxy start --tunnel --name app2
```

## Step 8 — Verify everything end to end

```bash
# 1. Confirm the local proxy responds
curl -H "Host: app.yourdomain.com" http://localhost:8080

# 2. Confirm the public domain responds the same way
curl https://app.yourdomain.com
```

Both should return the same content from your backend project. If step 1 works but step 2 doesn't, the issue is in the tunnel/DNS layer (see Troubleshooting). If step 1 itself fails, the issue is your local project or the `add`/`listen` routing config, not Cloudflare.

---

## Running multiple domains/projects through tunnels

Repeat Steps 4–7 per project, giving each a distinct proxy port and tunnel name:

```bash
# Project A
nodeproxy listen 8080   # if not already there by default
nodeproxy add "*" http://localhost:3000 --port 8080
nodeproxy tunnel setup --domain appA.yourdomain.com --port 8080 --name appA

# Project B
nodeproxy listen 9090
nodeproxy add "*" http://localhost:4000 --port 9090
nodeproxy tunnel setup --domain appB.yourdomain.com --port 9090 --name appB
```

Each tunnel needs its own `nodeproxy start --tunnel --name <name>` process, so run them in separate terminals (or as separate background services — see below).

---

## Keeping it running permanently (survive terminal close / reboot)

`nodeproxy start --tunnel` runs in the foreground and stops if you close the terminal. For a server you want always-on, run it as a background service.

**Linux (systemd)** — create `/etc/systemd/system/nodeproxy.service`:
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
Then:
```bash
sudo systemctl enable --now nodeproxy
sudo systemctl status nodeproxy
```

**macOS (launchd)** or a process manager like `pm2`/`forever` work equally well if you prefer those — the command to keep alive is just `nodeproxy start --tunnel`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `502 Bad Gateway` from `curl localhost:8080` | Your local project isn't running, or is on a different port than configured | Start your project, or run `nodeproxy add "*" http://localhost:CORRECT_PORT` |
| `404 Not Found (no matching route...)` | The `Host` header doesn't match any route and there's no `*` catch-all on that listener | Add a catch-all: `nodeproxy add "*" http://localhost:PORT --port PROXY_PORT` |
| `tunnel setup` fails at install | Your platform isn't macOS/Linux auto-install, or missing `sudo`/Homebrew | Run the manual install command it printed, then re-run `tunnel setup` |
| Browser doesn't open during login | Headless/remote machine (e.g. SSH session) | `cloudflared tunnel login` prints a URL to the terminal too — open it manually on any device and authorize |
| `curl localhost:8080` works but the public domain doesn't | Tunnel isn't running, or DNS hasn't propagated yet | Confirm `nodeproxy start --tunnel` is actually running and check `dig yourdomain.com`; wait a minute and retry |
| "Port X already has a listener" | You tried `nodeproxy listen` on a port that's already configured | Use `nodeproxy add ... --port X` directly instead of `listen` |
| Changes to `nodeproxy.config.json` don't take effect | The proxy only reads the config at startup | Restart `nodeproxy start` (Ctrl+C, then run it again) |

---

## Command reference

```
nodeproxy start [--config <file>] [--tunnel] [--name <name>]
                                          Start the proxy. --tunnel also starts
                                          the Cloudflare tunnel alongside it.
nodeproxy init  [--config <file>]        Just create the config file.
nodeproxy add <host> <target> [--port <n>] [--config <file>]
                                          Add/update a route on a listener.
                                          <host> can be a real domain or "*".
nodeproxy listen <port> [--config <file>]
                                          Open a new, independent listener on
                                          a new port.
nodeproxy tunnel setup --domain <domain> [--name <name>] [--port <n>]
                                          One-time: install cloudflared, log
                                          in, create tunnel, route DNS.
nodeproxy tunnel start [--name <name>]   Run just the tunnel (no local proxy).
nodeproxy help                           Show all commands.
```

## Config file reference (`nodeproxy.config.json`)

```json
{
  "logging": true,
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

- `servers` — one entry per port the proxy listens on; each is fully independent.
- `routes[].host` — a real hostname, or `"*"` as a catch-all for that listener.
- `routes[].targets` — one or more backend URLs; 2+ enables automatic round-robin load balancing.
- `routes[].staticDir` — set this and leave `targets` empty to serve static files from a folder instead of proxying.
- `https` — only needed if you're terminating TLS yourself instead of using Cloudflare Tunnel (uncommon once you're using a tunnel, since Cloudflare's edge already handles TLS).

## Project layout
```
bin/cli.js         CLI entrypoint
lib/server.js      Core proxy engine (multi-listener routing, load balancing, static serving)
lib/config.js      Config file loading/creation
lib/cloudflare.js  Cloudflare Tunnel install/login/create/route/run helpers
```

## Known limitations
- No automatic Let's Encrypt renewal for self-managed HTTPS (not needed with Cloudflare Tunnel)
- One cert per listener if self-managing HTTPS (no per-domain SNI certs)
- No rate limiting, caching, or WAF
- Round-robin load balancing only
- The Cloudflare browser-login click is inherently manual and one-time per machine — this is Cloudflare's security design, not a gap in this tool
