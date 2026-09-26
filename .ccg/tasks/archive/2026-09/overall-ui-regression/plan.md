# Overall UI Regression Plan

## Scope

- Validate the current workspace after the settings-tab fix.
- Cover frontend/backend static checks and automated tests.
- Exercise authenticated routing with desktop and mobile viewports.
- Check page transitions, query-tab state, keep-alive restoration, overlays, and common actions.
- Capture desktop and mobile screenshots for visual inspection.

## Execution

1. Run frontend lint/build/tests and backend lint/tests in parallel where independent.
2. Start an isolated authenticated backend/frontend instance using a temporary database.
3. Use Playwright to visit every declared route, exercise settings/monitor/events/CMDB tabs, mobile More navigation, command palette, drawers, and modal Esc/close behavior.
4. Capture screenshots and inspect console errors, failed requests, blank content, overflow, and visible overlap.
5. Fix only confirmed regressions, rerun affected and full checks, restart the local instance, and push if changes are required.

## Acceptance

- No test or lint errors.
- Every route renders without a blank page or uncaught console error.
- Navigation and query tabs do not retain stale state across route changes or refresh.
- Mobile bottom navigation and More drawer remain usable without horizontal overflow.
- Screenshots show content, stable layout, and no obvious overlap or clipped primary controls.
