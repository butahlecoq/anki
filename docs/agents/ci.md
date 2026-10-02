# Continuous integration

GitHub Actions reports two independent checks for each push and pull request:

- **Fast checks** runs typecheck, lint, unit tests, and server tests without installing browser engines. It has a 10-minute ceiling and should usually finish in about two minutes.
- **Browser tests** runs the production build through Playwright's web server, then exercises desktop Chromium and phone-sized WebKit. It installs both browser engines, runs journeys serially within each browser project with two retries in CI, and has a 30-minute ceiling.

The browser suite needs its own job because browser installation, production startup, and the full cross-browser journey suite take substantially longer than typecheck, lint, and unit/server tests. Keeping it separate reports fast failures early and makes browser failures distinct. Keep its timeout based on measured full-suite duration, rather than raising the ceiling on unrelated pull requests.

`npm run check` remains the complete local gate: typecheck, lint, unit tests, server tests, production build, and Playwright. The workflow intentionally calls the fast scripts and `npm run test:e2e` separately so the two GitHub checks stay independently visible.
