<div align="center">

# ComposeOps

**Lightweight Docker Compose Operations Dashboard for Personal Servers**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED.svg?logo=docker)](https://docs.docker.com/compose/)
[![CI](https://github.com/StanlySGY/ComposeOps/actions/workflows/ci.yml/badge.svg)](https://github.com/StanlySGY/ComposeOps/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/StanlySGY/ComposeOps?include_prereleases)](https://github.com/StanlySGY/ComposeOps/releases)

Auto-discover Compose projects, manage services, edit configs, stream logs, diagnose with AI, and monitor resources — all in a single web interface

[Features](#-features) • [Quick Start](#-quick-start) • [Security Model](#-security-model) • [Contributing](CONTRIBUTING.md) • [中文文档](README.md)

<img src="docs/screenshots/dashboard.png" alt="ComposeOps dashboard — AI ops decision center" width="900">
<br>
<img src="docs/screenshots/services.png" alt="Services overview — auto-discovery and onboarding" width="49.4%">
<img src="docs/screenshots/monitor.png" alt="Realtime monitoring — container resources & alert thresholds" width="49.4%">
<br>
<img src="docs/screenshots/agent.png" alt="AI Ops Agent — tool loop + confirmation gate" width="98.8%">
</div>

> **What it is**: a single-user ops dashboard for your own server. Docker socket access equals root; UI is currently Chinese-only (English UI is planned).
> **What it is not**: no multi-tenant or team support (use Portainer for that); not a PaaS — it does not take over your build/release pipeline (see Coolify or Komodo).
> **Where it stands**: among compose-panel tools, ComposeOps' differentiator is the **AI Ops Agent** — it doesn't just show state, it can investigate and act on your approval.

---

[Interactive preview](https://stanlysgy.github.io/ComposeOps/) · [Backup and restore](docs/public/BACKUP_RESTORE.md)

The offline preview runs the actual application UI with fictional data and never connects to Docker or AI. See [preview scope](docs/public/PREVIEW.md). The installation manifest pins version 1.5.0; AI is optional.

## 🚀 Why ComposeOps

### AI-driven, not just another dashboard

Traditional Docker panels stop at **seeing the problem**.

ComposeOps closes the loop:

**Detect → Analyze → Ask for confirmation → Act → Verify**

### Two things you won't find elsewhere

- 🛡 **Guardian Mode**: every container alert automatically triggers an AI diagnosis — it reads container state and recent logs, returns a root-cause hypothesis with risk-tagged remediation steps, and drops the result into the Event Center. The panel keeps watch; the decision stays yours.
- 🔮 **Deploy Oracle**: before running `up`, it simulates the deployment against the host's real state — which containers will be created/recreated/kept untouched, which images need pulling, whether host ports are already taken, whether volume & bind paths exist, plus a three-sentence AI risk summary.

<img src="docs/screenshots/guardian-demo.gif" alt="Guardian Mode in action: a container-exit alert automatically triggers an AI diagnosis — root cause and remediation one click away" width="960">

<img src="docs/screenshots/review.png" alt="Change review & deploy preview: config risk score plus containers to create/recreate/remove and affected volumes/ports" width="960">

### Understand the value in 30 seconds

| What you want to do | ComposeOps |
|---------------------|------------|
| Check service status | ✅ |
| Read logs | ✅ |
| Edit Compose files | ✅ |
| AI analyzes failures | ✅ |
| AI performs the fix | ✅ |
| Alerts auto-diagnosed by AI (Guardian Mode) | ✅ |
| Deploy simulated against host state | ✅ |
| Backup restore drills (self-verifying) | ✅ |
| Call ops tools from Claude/Cursor (MCP) | ✅ |
| Approval gate for risky actions | ✅ |
| Long-term memory of your ops preferences | ✅ |
| Ops workflow orchestration | ✅ |

### Choosing a tool

ComposeOps focuses on personal Compose operations with reviewed AI tool execution and connected logs/configuration. For team permissions, multi-tenancy or application build platforms, evaluate the current versions of [Portainer](https://www.portainer.io/), [Dockge](https://github.com/louislam/dockge), [Komodo](https://komo.do/) and [Coolify](https://coolify.io/). This project does not claim those products lack particular capabilities.

### 🔌 MCP access: let any agent call the panel's tools

Built-in MCP server (dedicated token, read-only whitelist by default, critical tools never exposed), with three transports covering all mainstream clients:

| Transport | Endpoint | Clients |
|-----------|----------|---------|
| Streamable HTTP (current standard) | `POST /mcp` | Codex CLI, Gemini CLI, modern harnesses, Claude Code |
| SSE (classic) | `GET /mcp/sse` | Claude Desktop, Cursor, Cline |
| stdio bridge | `node mcp/stdio-bridge.mjs` | stdio-only clients (DeepSeek-style harnesses) |

Enable via **Settings → MCP → Enable → copy client config**, then paste into any client's `mcpServers`. In read-only mode 32 ops tools (state/logs/metrics/inspection/GitOps drift/alerts) become callable from your AI coding assistant; switching to "include high-risk tools" opens 48, while critical-level tools (cleanup, deploy) never pass through this channel in any mode.

Protocol-wise it serves both eras of clients:

- **modern** (2026-07-28 spec): no `initialize` handshake — versions are declared per-request via `_meta`, `server/discover` returns supported versions and serverInfo in one shot, tools carry `readOnlyHint` / `destructiveHint` annotations so clients can decide on their own whether to confirm;
- **legacy** (`initialize` handshake): protocol versions 2024-11-05 → 2025-11-25 all supported; older gateways that rewrite dotted tool names to underscores (`compose_up` → `compose.up`) work too.

**Confirmation gate on MCP**: risky panel actions rely on a confirmation dialog, which MCP callers don't have — so high-risk tools (recreating containers, editing Compose, rollback…) require an explicit `confirm: true` from the caller, otherwise they only return a retryable explanation; tool results are value-level redacted then truncated (24K, head+tail kept) so container logs never flood the caller's context.

<img src="docs/screenshots/mcp-settings.png" alt="MCP server settings: three transports and the read-only tool whitelist" width="960">

### 📱 Manage from your phone

Open the panel in a mobile browser and you get the full console: responsive layout, bottom tab navigation, touch-friendly controls. It is also a **PWA** — "Add to Home Screen" and it runs full-screen like a native app (with home-screen shortcuts: Services / AI Assistant / Event Center / Logs).

> ⚠️ Security reminder: the panel equals root on the host. Reach it remotely via Tailscale/WireGuard or your own HTTPS reverse proxy — never expose `0.0.0.0` to the public internet; paired with push notifications (Bark/Telegram/DingTalk/Feishu), the mobile loop of "alert → diagnosis → one-tap action" is ready.

---

## ✨ Features

### 🚀 Core Workflow (day-to-day operations)

<table>
<tr>
<td width="50%">

**🎯 Project Management**
- 🔍 Auto-discover Compose projects (via container labels)
- 📁 Group by `myops.owner`, support favorites and notes
- 🎯 Explicit management: read-only by default, manual authorization for control
- 🔐 Two-tier permissions: Managed (container control) + Compose (config editing)

</td>
<td width="50%">

**✏️ Configuration Editing**
- ✏️ Multi-file YAML editor (Monaco Editor)
- ✅ Real-time syntax validation (depends_on / port conflicts / missing images)
- 💾 Auto-backup last 20 versions, diff and restore support
- 🔍 Pre-change container preview: Compose save, env apply and image upgrade all show added/recreated/restarted/removed containers before executing

</td>
</tr>
<tr>
<td width="50%">

**📊 Real-time Monitoring**
- 📈 System metrics: CPU, memory, disk, network
- 🐳 Docker metrics: image/container/volume count, storage usage
- 💰 Cost estimate: vCPU + RAM allocation cost simulation
- ⚡ Health scores: service availability scoring

</td>
<td width="50%">

**📜 Logs & Terminal**
- 🔄 Live log streaming (SSE), auto-scroll, level filtering
- 🔍 Full-text search, highlight ERROR/WARN, export to file
- 💻 Web shell (xterm.js), restricted to managed containers
- 📦 Batch operations: multi-project parallel execution

</td>
</tr>
</table>

### 🤖 AI Ops Agent

Single chat entry (the standalone AI diagnosis page has been merged in), powered by a native tool-loop engine:

- 🛠️ **50+ tools**: project discovery / lifecycle / config read-write & rollback / networks & volumes / security audit / diagnostic probes / maintenance / cron / long-term memory
- ⚠️ **Risk levels + step-by-step confirmation**: high-risk actions require explicit approval, fully audited; three approval modes (confirm every risky call / auto-allow non-critical writes / confirm critical only)
- 🛡 **Command guard**: LLM-generated commands are statically screened before entering containers (rm -rf /, mkfs, fork bombs, curl|sh …)
- 📎 **Log mounting**: pick container log lines as evidence attached to your message (untrusted-fence guarded)
- 🌐 **Web search**: optional toggle with cited sources; Tavily / Brave / self-hosted SearXNG backends with built-in fallback
- 🧠 **Long-term memory**: remembers your ops preferences on request
- 🗜 **Session compaction**: long sessions auto-collapse into a handoff summary to keep the model context lean
- 🖼️ **Rich rendering**: markdown tables / embedded HTML / SVG diagrams, with in-page zoom
- 💬 **Tool traces**: request/execute/result status and duration for every tool call
- 📄 Global page-agent drawer with automatic page context; streaming output, session history, quick prompts

Live demo: list managed projects → request a restart → **confirmation gate pops** → approve → execute and report the exit code:

<img src="docs/screenshots/agent-ops-demo.gif" alt="Agent in action: listing managed projects, requesting a restart, confirmation gate, executing on approval" width="960">

Execution history & token usage (30-day aggregates, per-model breakdown, per-round tool traces):

<img src="docs/screenshots/agent-history.png" alt="Agent execution history: token usage stats and tool traces" width="960">

### 🔔 Alerts & Notifications

- **Multi-channel push**: Bark, Telegram, WeChat Work, DingTalk, Feishu, SMTP, Generic Webhook
- **Trigger types**: Container exit, memory threshold, disk space, custom rules
- **Smart management**: Priority levels, read/mute status, WebSocket real-time push
- **Event persistence**: Alert history with full-text search

<img src="docs/screenshots/events.png" alt="Event center: alerts, inspections, deployments, Agent and GitOps in one event stream" width="960">

### 🛠️ Operations Tools

- **Resource management**: Images (prune unused), volumes (cleanup), networks (list/remove)
- **Batch operations**: Multi-project parallel execution with SSE streaming progress
- **Health checks**: Service availability monitoring with scoring
- **Backup & restore**: Config versioning with diff comparison
- **Volume backup**: tar.gz snapshots of named volumes via helper containers, with restore/download and cron scheduling
- **Backup self-verification (restore drill)**: don't trust a backup blindly — tar integrity check plus an extraction into a throwaway volume to count files; passing drills get a "✓ N files" badge, and the original volume is never touched

Backup → restore drill → verified badge:

<img src="docs/screenshots/backup-verify-demo.gif" alt="Volume backup and restore drill: one click after backup, verified badge on pass" width="960">

<img src="docs/screenshots/volume-backup-verified.png" alt="Volume backup records: ✓ N files badge after a passing drill" width="960">
- **GitOps**: keep compose files in sync from a Git repo (polling + webhook trigger), with rollback history
- **Marketplace**: built-in blueprints + custom templates + AI-assisted app discovery
- **Scheduled jobs**: DB dumps, safe/deep Docker cleanup, image update checks, scheduled pulls, volume backups

### 🧩 Advanced Modules (optional, safe to ignore)

These modules target power users who want to codify their ops experience. The core workflow above works without them:

- 🛡️ **AI Inspection**: scheduled health checks across managed projects with diagnostic reports
- 📝 **Change Review / Auto-Rollback**: review Compose changes before they take effect; automatic rollback on anomalies
- 🚢 **Fleet View**: node-group aggregate overview, parallel probing across all nodes, batch inspection and image update checks
- 🗃️ **Asset Center (CMDB)**: unified host/project/container/volume/network asset model with dependency relations
- 🕸️ **Knowledge Graph / Topology**: realtime or CMDB-backed visualization of project dependencies
- 🔁 **Workflow Engine**: trigger / condition / agent / approval / action / verify node orchestration; the Agent can act as a workflow node
- 🎯 **Event Center**: alerts, inspections, deployments, rollbacks, Agent and GitOps unified into one event stream
- 💰 **Cost Analysis**: resource-based estimation (informative for personal servers)

<img src="docs/screenshots/node-groups.png" alt="Fleet view: multi-host node group overview with batch actions" width="960">

### 💻 Interaction Experience

- ⌨️ Global shortcuts: Cmd/Ctrl+K command palette, `?` cheatsheet, Vim-style j/k navigation on the services page
- 🌙 Single dark industrial theme: unified design tokens (surface scale + emerald/rose/amber/sky status semantics), skeleton/empty/error tiers, focus trap and layered Esc handling
- 📱 Mobile: bottom nav + drawer sessions, horizontally scrollable tables, touch target minimums and safe-area support
- ⚡ Performance: idle route prefetch, keep-alive whitelist, virtualized log scrolling, WebSocket fallback polling
- 🔄 Resource pages show a "last updated" timestamp and refresh when you return to them

---

## 🚀 Quick Start

### Prerequisites

- Docker 20.10+ & Docker Compose v2
- Linux/macOS/Windows (WSL2)
- 1GB RAM minimum

### Installation

**Option A: Pull the image (recommended)**

```bash
mkdir composeops && cd composeops
curl -fsSL https://raw.githubusercontent.com/StanlySGY/ComposeOps/v1.5.0/deploy/compose.yml -o docker-compose.yml
docker compose pull && docker compose up -d
```

> Images are published on Docker Hub as `stanly1997/opsdash` (tags: `latest`, major, full version). Behind a proxy or prefer building yourself? Use Option B — the Dockerfile ships with mirror defaults so `docker compose up -d --build` works out of the box.

**Option B: Build from source**

```bash
git clone https://github.com/StanlySGY/ComposeOps.git
cd ComposeOps
docker compose up -d --build
```

Open **http://<host-ip>:28765** in your browser (default mapping `0.0.0.0:28765 -> 3001`; change to `127.0.0.1:28765:3001` for localhost-only). First-time setup will prompt for an admin password (min 10 characters).

### Remote Access

ComposeOps manages Docker Engine via `/var/run/docker.sock` — **exposing port 3001 to the internet = granting root access to your server**. Use one of these secure access methods:

**Option 1: Tailscale** (Recommended - Zero-config VPN)
```bash
tailscale serve --bg http://127.0.0.1:28765
# Access via https://your-machine.your-tailnet.ts.net
```

**Option 2: Reverse Proxy** (Caddy/Nginx with HTTPS + authentication)
```yaml
# docker-compose.yml - add to environment:
TRUST_PROXY=1
```

⚠️ **Security Warning**: Never expose port 3001 directly to the public internet without authentication and HTTPS.

---

## 🔒 Security Model

### 🔐 Authentication & Authorization

- ✅ Scrypt password hashing (Node.js native crypto)
- ✅ Session-based authentication (30-day HttpOnly, SameSite=Strict cookies)
- ✅ API key management for programmatic access
- ✅ CSRF protection via Origin header validation

### 📂 File & Operation Isolation

- ✅ Workspace containers: on-demand mounting of project directories
- ✅ Auto-cleanup after operations (30s timeout)
- ✅ Read-only discovery mode by default
- ✅ Explicit management authorization required for write operations

### 🔑 API Key Protection

- ✅ AI provider keys stored in local SQLite (file permission 0600), never in browser
- ✅ Server-side proxy for all AI API calls; masked in UI responses
- ⚠️ The database file itself is not encrypted — keep host access under control

### ⚠️ Threat Model

**What we assume you trust:**
- Your Docker host and its file system
- Network between browser and ComposeOps (use Tailscale/HTTPS)
- The admin account holder

**What we protect against:**
- ✅ Accidental destructive operations (confirmation dialogs)
- ✅ Container escape via shell (restricted to managed containers)
- ✅ Unauthorized project access (explicit management required)
- ✅ Session hijacking (HttpOnly + SameSite cookies)

**Design boundaries (out of scope):**
- ❌ Multi-user RBAC (single admin by design)
- ❌ Protection against compromised Docker daemon
- ❌ Network segmentation between containers

---

## 📦 Project Management

### Permission Levels

| Permission Level | Description | Allowed Operations |
|-----------------|-------------|-------------------|
| **Managed** | Container control | Start/stop/restart, logs, terminal, AI diagnostics |
| **Compose** | Config editing & pulling | Edit YAML, create missing services, pull images |

### Workspace Container Mechanism

ComposeOps uses temporary workspace containers to access project directories safely:

```yaml
# Auto-created when editing configs for project "myapp"
services:
  composeops-workspace-myapp:
    image: alpine:latest
    volumes:
      - /path/to/myapp:/workspace:rw
    command: sleep 30
```

After operations complete, the workspace container is automatically removed. This ensures:
- ✅ Scoped access: only the target project directory is mounted
- ✅ Time-limited: auto-cleanup after 30 seconds
- ✅ Traceable: labeled with `myops.workspace=true`

---

## 📊 Metrics Guide

### Cost Estimation

The dashboard displays estimated monthly costs based on:
- **vCPU allocation**: $0.04 per vCPU per month
- **RAM allocation**: $0.005 per MB per month

**Note**: These are approximate values for cost awareness, not actual billing. Adjust rates in Settings if needed.

### Health Scores

Service health is scored 0-100 based on:
- **Running state** (50 points): Container is running
- **Health checks** (30 points): Docker health check passing
- **Recent restarts** (20 points): No restarts in last 24 hours

---

## 🛠️ Development & Testing

### Prerequisites

- Node.js 22+
- Docker 20.10+
- npm 10+

### Setup

```bash
# Install dependencies
npm run install:all

# Run tests
npm test                  # All tests
npm run test:backend      # Backend only
npm run test:frontend     # Frontend only

# Development mode
npm run dev:backend       # Backend on :3001
npm run dev:frontend      # Frontend on :5173 (proxies API to :3001)

# Production build
npm run build             # Outputs to frontend/dist
```

### Testing Commands

```bash
# Backend tests (Node.js test runner)
cd backend && npm test

# Frontend tests (Vitest)
cd frontend && npm test

# Type checking & linting
cd frontend && npm run build  # Vite build includes type checking
```

**Note**: No dedicated lint script — linting runs automatically during the build process via ESLint 9.

---

## 💾 Data Storage

All persistent data lives in a single SQLite database with file permission 0600:

```
backend/data/
├── opsdash.db            # Main database (auth, sessions, AI config & history, audit, backups)
└── volume-backups/       # Volume backup archives (overridable via backup.volume_dir)
```

Compose config backups (last 20 per project) are stored in the database and restorable from the UI.

**Backup recommendation**: regularly back up `backend/data/` (or the `opsdash-data` Docker volume in production) to prevent data loss.

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

**You are free to**:
- ✅ Use commercially
- ✅ Modify and distribute
- ✅ Use privately

**You must**:
- ✅ Include the original license and copyright notice

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting PRs.

**Quick links**:
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Architecture Documentation](docs/architecture/README.md)
- [Development Guide](CONTRIBUTING.md#development-guide)

---

## 🔗 Friendly Links

- [LINUX DO](https://linux.do/) — A community of sincere sharing and friendly discussion. Project announcements and feedback are also posted there.

---

## 🔗 Related Links

- [English Documentation](README.en.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Issue Templates](.github/ISSUE_TEMPLATE/)

---

<div align="center">

**Built with ❤️ · Designed for personal servers**

If this project helps you, please consider giving it a ⭐ Star

</div>
