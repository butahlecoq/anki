# Kiroku

Kiroku is a private, offline-first Japanese flashcard workspace with local collection editing, FSRS review scheduling, and PC-to-phone collection sync.

## Requirements

- Node.js 22 or newer
- npm 11 or newer

No Mac, Apple Developer membership, or paid service is required.

## Run locally

```powershell
npm install
npm run dev
```

Open the URL Vite prints. Development mode listens on the local network so another device can connect when the host firewall and secure-context requirements are satisfied.

## Run the production build

```powershell
npm install
npm start
```

`npm start` type-checks and builds the application before serving it at `http://localhost:4173`. Localhost is suitable for desktop verification. Installing the PWA on an iPhone will require trusted HTTPS; that production deployment is tracked by [Issue #24](https://github.com/butahlecoq/anki/issues/24).

## Run the sync service

For local desktop verification, start the durable SQLite-backed service and print a one-time pairing code in a second terminal:

```powershell
npm run server:start
npm run server:pair
```

The default service listens only on `127.0.0.1:4174`. To pair a phone across the network, provide a trusted TLS key and certificate, an HTTPS app origin, and a network host:

```powershell
$env:KIROKU_HOST = '0.0.0.0'
$env:KIROKU_TLS_KEY_PATH = 'C:\certs\kiroku-key.pem'
$env:KIROKU_TLS_CERT_PATH = 'C:\certs\kiroku-cert.pem'
$env:KIROKU_ALLOWED_ORIGIN = 'https://study.example.net'
npm run server:start
```

Enter the service’s `https://` address and the one-time code in **Connect a PC**. Credentials remain in that browser’s local collection settings and are never included in the web build.

## Offline media

Basic notes accept PNG, JPEG, and WebP images up to 10 MB, plus MP3, Ogg, and WAV audio up to 20 MB. Choose whether an attachment belongs on the front or back; audio can play automatically or through its built-in controls. Kiroku verifies a SHA-256 digest before storing an attachment, stores identical bytes once per collection, and transfers the blob separately from card changes. A successful sync leaves verified media in the browser database, so reviewed cards keep displaying and playing after an offline restart.

## Verify

Install the Playwright browser engines once:

```powershell
npx playwright install chromium webkit
```

Run every current check:

```powershell
npm run check
```

The browser suite builds the production app, starts it locally, then verifies desktop Chromium and phone-sized WebKit. It includes a service-worker-backed offline cold reload rather than testing only a warm page.

## Privacy

Imported packages, Anki databases, media, runtime data, backups, environment secrets, and generated certificates are ignored by Git. Do not commit a real collection or identity-bearing fixture.

## Agent collaboration

Read `CONTRIBUTING.md` before claiming a ticket. Each agent must claim one unblocked GitHub issue and use its own branch and worktree; agents must not edit the same working directory.
