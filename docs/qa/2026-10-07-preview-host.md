# Production preview hostname — #232

The existing fix reads `KIROKU_PREVIEW_ALLOWED_HOST` at preview startup and adds
that hostname to Vite's allowlist. The README shows the PowerShell environment
setting, localhost preview command, and corresponding sync-service HTTPS origin.
It links the deployment procedure for Tailscale's `/` and `/api` routes.

## HTTP checkpoint

`npm run build` passed on the #232 worktree. An isolated production preview was
started on loopback port 4194 with the owner's exact configured tailnet hostname.
Node HTTP requests supplied each Host explicitly and asserted both status and
response content:

| Host | Status | Content |
| --- | --- | --- |
| Configured owner tailnet hostname | 200 | Kiroku app root |
| localhost | 200 | Kiroku app root |
| Another device under the same tailnet suffix | 403 | Host not allowed |
| attacker.invalid | 403 | Host not allowed |

Separate HTTPS reads of the existing Tailscale `/` and `/api/health` routes
returned 200. Those reads verify the current Serve routes; they do not imply
that the new preview build has been deployed there. The temporary port-4194
preview was stopped after verification. Existing app/service processes and the
owner's collection were untouched.

The browser regression is named `production preview accepts its
configured Tailscale hostname only` in `tests/e2e/shell.spec.ts`. Its Playwright
configuration gives the preview a dedicated test hostname. Full `npm run check`
and independent review remain required before completion.
