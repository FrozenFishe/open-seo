---
title: "Docker Self-Hosting"
description: "Run OpenSEO locally with Docker Compose using the published GHCR image."
---

Run OpenSEO locally with Docker.

In Docker mode, OpenSEO uses `AUTH_MODE=local_noauth` (no auth checks, local admin user `admin@localhost`). Only expose it behind your own auth-protected reverse proxy, tunnel, or private network. For internet-facing self-hosting, use [Cloudflare](/docs/self-hosting/cloudflare) instead.

The default `compose.yaml` uses the published GHCR image:

- `ghcr.io/every-app/open-seo:latest`

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Docker Compose)
- A [DataForSEO API key](/docs/self-hosting#dataforseo-api-key-setup)

## Quickstart

Clone the repo, then:

```bash
git clone https://github.com/every-app/open-seo.git
cd open-seo
cp .env.example .env
```

Set `DATAFORSEO_API_KEY` in `.env` using the [DataForSEO setup guide](/docs/self-hosting#dataforseo-api-key-setup), then start OpenSEO:

```bash
docker compose up -d
```

Open `http://localhost:<PORT>` (default `3001`). The first start builds the app and may take 1-2 minutes; later restarts reuse that build. Follow progress with `docker compose logs -f`.

Optional env values:

- `PORT` (defaults to `3001`)
- `HOST_IP` (host interface the port binds to; defaults to `127.0.0.1`. Set it to the machine's LAN or Tailscale IP to reach the app from the network — the app has no auth in this mode, so keep it on a private network)
- `ALLOWED_HOST` (reverse-proxy or DNS hostnames to allow, comma-separated; localhost and raw IP addresses always work)
- `AUTH_MODE=local_noauth` (already set in compose)
- `OPEN_SEO_IMAGE` (defaults to `ghcr.io/every-app/open-seo:latest`)
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL` (AI features; see [Use a self-hosted LLM for SAM](#use-a-self-hosted-llm-for-sam))

AI Visibility uses your `DATAFORSEO_API_KEY` and sends tracked questions to DataForSEO. Set `OPENROUTER_API_KEY` for setup research, Prompt Research, and generated prompt suggestions. You pay providers directly; the app shows the collection cost before a check or schedule starts. Keep the container running for background answers and daily, weekly, or monthly tracking. The built-in scheduler checks for due work every five minutes; no host cron setup is required. See the [AI Visibility guide](/docs/ai-visibility).

To open it from other devices, a tailnet, or behind a reverse proxy, see [Reach it from other devices](#reach-it-from-other-devices).

## Use a self-hosted LLM for SAM

SAM, the in-app SEO agent, can run on any OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, and similar) instead of OpenRouter. Set these in `.env`, then run `docker compose up -d --force-recreate open-seo`:

```bash
OPENROUTER_BASE_URL=http://host.docker.internal:8000/v1
OPENROUTER_MODEL=your-served-model-name
```

- Use the `/v1` base URL as the container sees it. `localhost` inside the container is the container itself; `host.docker.internal` reaches the Docker host (`compose.yaml` maps it on Linux too), or use the server's LAN or Tailscale address.
- Set `OPENROUTER_MODEL` to a model name the endpoint serves. The default is an OpenRouter model slug that a local server will not recognize.
- SAM calls tools, so the model and server must support OpenAI-style tool calling (for vLLM, start it with `--enable-auto-tool-choice` and a `--tool-call-parser` for your model).
- No OpenRouter key is needed for SAM in this mode. AI setup research, Prompt Research, and AI Visibility prompt suggestions still use OpenRouter and stay off unless `OPENROUTER_API_KEY` is also set.

## Reach it from other devices

By default the port binds to `127.0.0.1`, so only the machine running Docker can open the app. The app has no auth in Docker mode, so widen access only on a network you trust:

- **LAN or tailnet:** set `HOST_IP` in `.env` to the machine's LAN or Tailscale IP (for example `HOST_IP=100.101.102.103`), then `docker compose up -d`. Opening `http://<that IP>:3001` works as is. To use a hostname such as a Tailscale MagicDNS name, also add it to `ALLOWED_HOST`.
- **Reverse proxy:** keep the default `127.0.0.1` bind, put the proxy on the same machine, and set `ALLOWED_HOST` to the public hostname. Several hostnames can be comma-separated (`ALLOWED_HOST=seo.example.com,openseo.tailnet-name.ts.net`). Put authentication in the proxy (for example Caddy `basic_auth`, oauth2-proxy, or an identity-aware tunnel). A minimal Caddy example:

```text
seo.example.com {
	basic_auth {
		admin <hash from `caddy hash-password`>
	}
	reverse_proxy 127.0.0.1:3001
}
```

Without the right `ALLOWED_HOST`, requests by hostname show Vite's "Blocked request" page.

## Data and backups

All app data (the SQLite database and stored files) lives in the `open_seo_data` Docker volume, mounted at `/app/.wrangler`. It survives restarts, image updates, and `docker compose down`. `docker compose down -v` deletes it.

To back it up, find the volume's full name (Compose prefixes it with the project name, by default the directory name, e.g. `open-seo_open_seo_data`), stop the app so the database is not mid-write, and archive the volume:

```bash
docker volume ls --filter name=open_seo_data
docker compose stop open-seo
docker run --rm -v open-seo_open_seo_data:/data -v "$PWD":/backup alpine tar czf /backup/open-seo-data.tgz -C /data .
docker compose start open-seo
```

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. Telemetry also includes failed setup check names and statuses, never values or error messages. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

Heartbeats are triggered by requests to the app or MCP server. Requests to `/api/health`, including Docker's automatic health checks, do not trigger telemetry.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` (or `DO_NOT_TRACK=1`) in `.env`, then run `docker compose up -d --force-recreate open-seo`.

## Pin to a specific image tag

Set `OPEN_SEO_IMAGE` in `.env` and restart:

```bash
OPEN_SEO_IMAGE=ghcr.io/every-app/open-seo:v1.2.3
docker compose up -d
```

## Build your own image locally

If you are testing local code changes, build and run a local tag:

```bash
docker build -f deploy/docker/Dockerfile -t open-seo:local .
OPEN_SEO_IMAGE=open-seo:local docker compose up -d
```

## Common commands

Restart service after env changes:

```bash
docker compose up -d open-seo
```

Pull latest published image and restart:

```bash
docker compose pull && docker compose up -d
```

Stop:

```bash
docker compose down
```

## Health and troubleshooting

Startup checks appear in `docker compose logs` before the build. Once running, `/api/health` reports configuration and database status, and `docker compose ps` reports container health.

## Kubernetes

The same image runs on Kubernetes. Run exactly one replica: the database is SQLite on a single volume, so use the `Recreate` strategy and a `ReadWriteOnce` volume. Each new container builds the app before serving (a few minutes, and up to ~4 GiB of memory), so give it a generous startup probe. A minimal example, with the DataForSEO key in a Secret named `open-seo`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: open-seo
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: open-seo }
  template:
    metadata:
      labels: { app: open-seo }
    spec:
      containers:
        - name: open-seo
          image: ghcr.io/every-app/open-seo:latest # pin a version tag in production
          ports:
            - containerPort: 3001
          env:
            - { name: CLOUDFLARE_INCLUDE_PROCESS_ENV, value: "true" }
            - { name: AUTH_MODE, value: local_noauth }
            - { name: PORT, value: "3001" }
            - { name: VITE_SHOW_DEVTOOLS, value: "false" }
            - { name: ALLOWED_HOST, value: seo.example.com } # your ingress hostname
          envFrom:
            - secretRef: { name: open-seo } # DATAFORSEO_API_KEY, optional OPENROUTER_*, ...
          resources:
            requests: { memory: 2Gi }
            limits: { memory: 6Gi }
          startupProbe:
            httpGet: { path: /api/health, port: 3001 }
            periodSeconds: 10
            failureThreshold: 60
          readinessProbe:
            httpGet: { path: /api/health, port: 3001 }
            periodSeconds: 30
          volumeMounts:
            - { name: data, mountPath: /app/.wrangler }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: open-seo-data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: open-seo-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: { storage: 5Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: open-seo
spec:
  selector: { app: open-seo }
  ports:
    - { port: 3001, targetPort: 3001 }
```

Create the Secret with `kubectl create secret generic open-seo --from-env-file=.env` (only the keys you need). Expose the Service only through an ingress or tailnet proxy that adds authentication, as with Docker.

## Troubleshooting environment variables

To confirm Docker Compose is using the expected environment variables:

```bash
docker compose config
```

Check that `AUTH_MODE=local_noauth`, and that `DATAFORSEO_API_KEY` is the base64 encoded value of your DataForSEO email and API password in this format: `email:password`.

If you changed `.env`, recreate the container so Compose reapplies it:

```bash
docker compose up -d --force-recreate open-seo
```
