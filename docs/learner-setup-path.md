# Measured learner setup path

**Measured:** 2026-10-06, Windows 11 development machine, commit `cf729eafe91c`.
This is a builder's local rehearsal plus a source-based account of the private
phone path. It is not an independent learner trial, an AnkiWeb login, or an
iPhone test.

This measurement is linked to parent [#1, user story 56](https://github.com/butahlecoq/anki/issues/1):
“one-command Windows setup and start procedure.” The measured path is not one
command and requires the learner to supply the private-network setup.

## Count and assumptions

Following the written Windows/Tailscale instructions from an empty PC takes
**24 ordered actions** from obtaining source through offline study. Each
separately installed prerequisite, sign-in, shell invocation, route setup, and
phone action counts once. The current deployment instructions contain a
separate `/ankiweb` route command that the app does not use; following them
literally adds one unnecessary action.

The path assumes a Windows 10 or later PC, an iPhone, internet access for
downloads, an existing AnkiWeb account, and a learner willing to operate the PC
service. It uses Tailscale to provide private reachability and HTTPS. The
app/service remain on the learner's PC; they must be running for pairing and
AnkiWeb transfers. After the account collection is downloaded and imported,
offline study uses the phone's local collection.

## Ordered checklist

| # | Learner action | Account, cost, OS, second device | Can it be automated? |
| --- | --- | --- | --- |
| 1 | Install Git. | Account: none; cost: no software fee; OS: Windows PC; second device: no. | Can be scripted, but learner runs the installer and accepts OS prompts. |
| 2 | Install the current Node.js LTS (Node 24 currently includes npm 11; the repo needs Node 22+ and npm 11) using the [official Windows installer](https://nodejs.org/en/download/archive/v24.21.0). | Account: none; cost: no software fee; OS: Windows PC; second device: no. | Can be scripted, but learner runs the installer and accepts OS prompts. |
| 3 | Clone the public source with `git clone https://github.com/butahlecoq/anki.git` ([GitHub clone instructions](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository)). | Account: none for this public repository; cost: no fee; OS: Windows PC; second device: no. | Yes after Git install; learner selects folder and runs command. |
| 4 | Run `npm ci`. | Account: none; cost: no fee (internet access assumed); OS: Windows PC; second device: no. | Yes from a prepared shell; learner starts it and handles failures. |
| 5 | Run `npm run build`. | Account: none; cost: no fee; OS: Windows PC; second device: no. | Yes from a prepared shell; learner starts it and handles failures. |
| 6 | Install Tailscale on the PC using its [Windows instructions](https://tailscale.com/docs/install/windows). | Account: none yet; cost: no fee on Personal plan; OS: Windows PC; second device: no. | Installer can be scripted; learner runs it and resolves OS prompts. |
| 7 | Sign the PC into a Tailscale tailnet, creating a Tailscale account if needed. The [Personal plan](https://tailscale.com/pricing) is free for individual use. | Account: one additional hosted account may be needed; cost: $0 Personal plan; OS: Windows PC; second device: no. | No; identity-provider authentication is interactive. |
| 8 | Install Tailscale on the iPhone using its [iOS instructions](https://tailscale.com/download/ios). | Account: none new; cost: no fee on Personal plan; OS: iOS; second device: yes, the iPhone. | No; learner installs the iOS app. |
| 9 | Sign the iPhone into the same tailnet. Tailscale requires each connecting device to be installed and signed in to that tailnet ([device access](https://tailscale.com/docs/use-cases/personal-or-at-home-use/access-nas-media-file-servers)). | Account: existing hosted Tailscale account; cost: no fee on Personal plan; OS: iOS; second device: yes, the iPhone. | No; interactive sign-in and device authorization. |
| 10 | Enable MagicDNS in the tailnet admin page ([Tailscale instructions](https://tailscale.com/docs/features/magicdns)). | Account: hosted Tailscale account; cost: no fee; OS: any browser; second device: no. | No; learner authorizes the setting. |
| 11 | Enable HTTPS certificates and acknowledge Certificate Transparency publication ([Tailscale HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates)). | Account: hosted Tailscale account; cost: no fee or purchased domain; OS: any browser; second device: no. | No; learner must authorize and accept public listing of the machine/tailnet names. |
| 12 | Read the PC DNS name from `tailscale status --json` and choose the HTTPS app origin. | Account: existing tailnet; cost: no fee; OS: Windows PC; second device: no. | Command can print it; learner records the name without its trailing dot. |
| 13 | Start production preview on loopback: `npm run preview -- --host 127.0.0.1 --port 4173`. | Account: none; cost: no fee; OS: Windows PC; second device: no. | Command can be scripted; learner keeps the process running. |
| 14 | In another PowerShell terminal, set `$env:KIROKU_ALLOWED_ORIGIN = 'https://<pc>.<tailnet>.ts.net'` and run `npm run server:start`. | Account: none; cost: no fee; OS: Windows PC; second device: no. | Can be scripted after hostname selection; learner must enter the exact origin and keep the process running. |
| 15 | Create the one-time code with `npm run server:pair`. | Account: none; cost: no fee; OS: Windows PC; second device: no. | Command can be run, but learner handles the code as a credential and does not publish it. |
| 16 | Publish `/api` to `http://127.0.0.1:4174` using the current [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) syntax from `tailscale serve --help`. | Account: existing tailnet; cost: no fee; OS: Windows PC; second device: no. | Command can be scripted after CLI-version check. |
| 17 | Publish `/ankiweb` to the PC service as the current deployment procedure says. | Account: existing tailnet; cost: no fee; OS: Windows PC; second device: no. | Command can be scripted, but this route appears unused by the client and is unnecessary. |
| 18 | Publish `/` to `http://127.0.0.1:4173`. | Account: existing tailnet; cost: no fee; OS: Windows PC; second device: no. | Command can be scripted after CLI-version check. |
| 19 | Check `tailscale serve status`, then open the HTTPS app and `/api/health` on the PC. | Account: existing tailnet; cost: no fee; OS: Windows PC; second device: no. | Partly; a script can check HTTP, but learner inspects the browser certificate and result. |
| 20 | Open the HTTPS app on iPhone Safari and pair to the PC using its URL and one-time code. | Account: existing tailnet; cost: no fee; OS: iOS; second device: yes, iPhone paired with PC. | No; learner transfers the one-time code and confirms pairing. |
| 21 | Add Kiroku to Home Screen and open it as a web app ([Apple's steps](https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/ios)). | Account: none new; cost: no fee; OS: iOS; second device: yes, the iPhone. | No; this is a manual Safari Share → Add to Home Screen action. |
| 22 | Enter the existing AnkiWeb username and password in Connect AnkiWeb account. | Account: existing AnkiWeb account; cost: no fee; OS: iOS; second device: yes, the phone; PC must be reachable. | No; learner enters their credentials. |
| 23 | Download and verify account media, preview/import the representable collection. | Account: existing AnkiWeb account; cost: no fee; OS: iOS plus PC service; second device: yes, the phone. | No; learner chooses import scope and confirms the plan. |
| 24 | Stop the PC, put the phone offline, reopen Kiroku, and study. | Account: none during offline study; cost: no fee; OS: iOS; second device: yes, the iPhone. | No; actual installed-device behavior must be observed by the learner. |

### Counts

- **24** actions following the written procedure, or **23** if the unused `/ankiweb` route is removed.
- **10** actions require a hosted account to be available: nine Tailscale-dependent actions (steps 7, 9–11, and 16–20) and the existing AnkiWeb login (step 22). This falls to **9** if the unused route action (step 17) is removed. A fresh learner may need to create **1** additional hosted account: Tailscale. The learner's pre-existing AnkiWeb account is the account being connected.
- **0** paid plans required for an individual using Tailscale Personal.
- **0** separately purchased domains required: Tailscale supplies the `*.ts.net` hostname and certificate path.
- **1** second device is required: the iPhone.
- **Windows PC** is the documented service host; iOS Safari is the phone client.

The acceptance expectation of zero hosted-account steps is **not met**: ten
actions depend on Tailscale or AnkiWeb identities. The count is nine after
removing the unused route. The zero figure applies only to paid-plan and
separately purchased-domain requirements in the stated personal-use path.

## Builder rehearsal and limits

On this Windows machine, with Node `v22.18.0`, npm `11.16.0`, and Git
`2.51.2.windows.1`, `npm ci` completed in 5.49 seconds from the warm package
cache and `npm run build` in 8.29 seconds. These timings exclude downloading
and installing prerequisites and Tailscale, creating/signing into a tailnet,
and the learner's interaction time.

`npm start` served the production app with HTTP 200, and `npm run server:start`
reported a ready service at `http://127.0.0.1:4174/api/health`. With the
deployment document's default server configuration, the AnkiWeb relay returned
HTTP 503 (`Relay is not configured`). The implementation requires
`KIROKU_ALLOWED_ORIGIN` to be set to the exact HTTPS app origin; the Windows
deployment instructions in [issue #24](https://github.com/butahlecoq/anki/issues/24)
do not currently include that setting. This must be corrected before those
instructions can complete the account-login step.

The deployment instructions also publish `/ankiweb` separately, but the app
client calls `/api/ankiweb/...`; routing `/api` to the PC service already covers
that path. The separate `/ankiweb` mapping appears unnecessary. The exact Serve
command depends on the installed Tailscale CLI version, so the learner must
inspect `tailscale serve --help` as issue #24 instructs.

The full path was **not performed by a non-builder**. No independent learner
was available in this environment. The rehearsal deliberately stopped before
Tailscale account authorization, phone pairing, AnkiWeb credentials, and
physical-device study; using the owner's real accounts would violate this
project's evidence rules. No account request or write was made. Automated
browser viewport checks would not establish installed-iPhone or offline-device
behavior.

## Learner choices and missing maintainer decisions

The learner has to decide whether to create/use a hosted Tailscale account,
which identity provider to use, what PC name to expose in Certificate
Transparency, and whether to place the iPhone on the same private tailnet. These
are conscious manual decisions in steps 4–5; the product cannot silently make
them for the learner. The learner also has to accept that account transfer
requires the PC to be online, as recorded in ADR 0004.

Two implementation decisions are still missing from the published procedure:

1. The product owner must decide whether one additional hosted networking
   account is acceptable while the acceptance criterion expects zero hosted
   accounts. The current design requires it; this measurement does not resolve
   that product tradeoff.
2. The deployment author must specify the exact `KIROKU_ALLOWED_ORIGIN` setup
   and whether to remove the `/ankiweb` Serve mapping. The value is derivable
   from the chosen HTTPS URL, but the current steps omit it; without it, the
   relay returns HTTP 503. The extra mapping is not used by the client, which
   calls `/api/ankiweb/...`.

The remaining human evidence decision is who will perform the independent
trial. No non-builder was available here; the required independent walkthrough
and its measured duration remain unperformed.

## Recommendation

**Change the “think of none of this” expectation for the current topology.**
The documented path has 24 actions (23 after removing the unused route), an extra hosted network account,
interactive private-network and certificate decisions, PC-run services, manual
pairing, and a real phone install/offline check. Those steps follow directly
from running the private relay on the learner's PC; eliminating them requires a
different distribution/network architecture decision. If the existing
zero-hosted-account requirement is retained, the product decision must change
before this path can meet it. First make the Windows instructions operational
by documenting the required origin setting and removing the unused route, then
have a non-builder perform the checklist and record the actual duration and
friction before making a broader topology decision.

## Sources

Repository state and commands were inspected at commit `cf729eafe91c`:

- [README: requirements, Windows commands, pairing, and costs](../README.md)
- [Windows server entry point and `KIROKU_ALLOWED_ORIGIN`](../server/index.ts)
- [Paired account relay origin check](../server/ankiweb-gateway.ts)
- [Private PC relay decision](adr/0004-ankiweb-relay-runs-on-the-pc.md)
- [Windows deployment procedure and its current decisions](https://github.com/butahlecoq/anki/issues/24)

Primary external sources:

- [GitHub: cloning a public repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository)
- [Node.js: official downloads and platform installers](https://nodejs.org/en/download/); [Node 24 archive: bundled npm version and Windows installer](https://nodejs.org/en/download/archive/v24.21.0)
- [npm: `npm ci` clean-install behavior](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [Tailscale: install on Windows](https://tailscale.com/docs/install/windows)
- [Tailscale: Personal plan pricing and limits](https://tailscale.com/pricing)
- [Tailscale: enable HTTPS certificates and Certificate Transparency](https://tailscale.com/docs/how-to/set-up-https-certificates)
- [Tailscale: private Serve routing](https://tailscale.com/docs/features/tailscale-serve)
- [Apple: add a website to iPhone Home Screen](https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/ios)
