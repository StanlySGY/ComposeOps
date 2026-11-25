# Browser automation with Microsoft Playwright MCP

ComposeOps uses the official Microsoft Playwright MCP server for dynamic page reading and bounded browser interaction. The old custom browser/server.py HTTP service and the bettafish-local image dependency have been removed.

## Architecture

- opsdash acts as an MCP client using the official @modelcontextprotocol/client SDK.
- playwright runs mcr.microsoft.com/playwright/mcp as a separate sidecar and exposes its Streamable HTTP endpoint only on the Compose network (http://playwright:8931/mcp).
- The image is pinned to a verified multi-architecture OCI manifest digest in docker-compose.yml; update the digest deliberately when upgrading the upstream server.
- The browser sidecar has no Docker Socket mount, no host project-directory mounts, and no published host port.
- web.open and web.interact remain ComposeOps-owned Agent tools. The model does not receive the upstream MCP tool catalog directly.

## Isolation and permissions

The server starts Chromium headless with --isolated, --block-service-workers, and --no-webmcp. Each ComposeOps operation creates and closes its own MCP client session. Browser storage is not persisted between operations.

ComposeOps keeps its existing approval, policy, permission, and audit path for web.interact. Its adapter exposes only bounded operations: navigation, accessibility snapshots, constrained clicks, ordinary text entry, select/checkbox changes, temporary tab management, waits, and a bounded screenshot. It does not expose arbitrary model-authored Playwright code, downloads, credentials, or persistent login profiles.

The adapter checks the initial navigation hostname and DNS answers against local/private/reserved address ranges. The upstream --blocked-origins setting is defense in depth only: Playwright MCP explicitly does not treat it as a security boundary, and it does not cover redirects. Do not expose the sidecar outside the private Compose network or treat these checks as a substitute for network egress controls.

## Configuration

docker-compose.yml configures:

- COMPOSEOPS_PLAYWRIGHT_MCP_URL=http://playwright:8931/mcp
- Official Microsoft image pinned by digest
- Internal-only expose: 8931 (no host ports)
- read-only root filesystem, /tmp tmpfs output and Chromium XDG config/cache, dropped capabilities, no-new-privileges, and CPU/memory/PID limits

The browser service can be started independently for a local check with:

    docker compose up -d playwright
    docker compose ps playwright
    docker compose logs --tail=80 playwright

The OpsDash service declares a startup dependency on the sidecar, but its page-reading code still has a static HTTP fallback if the MCP service is unavailable. web.interact requires the MCP sidecar.

## Search is separate

web.search continues using the configured Tavily, Brave, or SearXNG providers and the existing built-in RSS/HTML search fallbacks. It does not launch a browser or depend on Playwright MCP.
