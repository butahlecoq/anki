# Why not just build the iPhone app on top of upstream Anki?

Research note answering the owner's question: *"One of them is written in Kotlin, which
could be very close to KMP! They already have a lot of integrations with AnkiWeb, Anki
account, and maybe even more. So why not base an iPhone app on them (web-based, because
I don't have a Mac to install X on)? Why is our own approach more suitable?"*

- **Question framed by:** repo owner, against `D:\work\ankitects\anki` (official desktop client)
  and `D:\work\Anki-Android` (AnkiDroid).
- **Method:** read both upstream trees at the checked-out commits and the primary vendor
  documentation. Every claim below carries a `path:line` or a URL. Negative results are
  reported as negative results.
- **Upstream commits inspected:** `ankitects/anki` `fe4f9e039a4e283b71e611fc1ffb87029b1cdc05`
  (2026-10-02), `Anki-Android` `062c0f215b4e38fed88f36d1ad54d3f22a1ccf90` (2026-10-02).
- **This document is adversarial in both directions.** Section 6 lists the risks we take by
  *not* reusing upstream, and section 4.1 concedes that "no Mac" is satisfiable without
  owning a Mac.

---

## 1. Verdict

- **AnkiDroid's Kotlin is not Kotlin Multiplatform and never was.** There is no
  `kotlin("multiplatform")` plugin, no `commonMain`/`jvmMain`/`iosMain` source set, no
  `iosArm64`, no `wasmJs` target, no `.xcframework` and no `.swift` file anywhere in the
  repository. Every Kotlin plugin in the version catalogue is `org.jetbrains.kotlin.android`,
  `.jvm`, `.parcelize`, `.serialization` or `.compose`
  (`Anki-Android/gradle/libs.versions.toml:255-259`). Searched `commonMain`, `jvmMain`,
  `androidMain`, `iosMain`, `iosArm64`, `iosSimulatorArm64`, `xcframework`, `konan`,
  `wasm-bindgen`, `multiplatform` across `*.kts`, `*.toml`, `*.gradle`, `*.properties`,
  `*.yml`, `*.md`: **no result** for any iOS, Apple, Wasm or Multiplatform term.

- **The engine we would be reusing is not AnkiDroid's code — it is `ankitects/anki`'s Rust,
  compiled for Android.** AnkiDroid consumes `io.github.david-allison:anki-android-backend`
  (`Anki-Android/gradle/libs.versions.toml:188-189`), which the backend repo builds as an
  **`.aar`** from the Anki submodule (`Anki-Android/buildSrc/src/main/kotlin/com/ichi2/anki/gradle/BackendDependencies.kt:15-18`).
  The engine requires the Android NDK, Rust, a C toolchain and (on Windows) msys2
  ([AnkiDroid-Backend README](https://github.com/ankidroid/Anki-Android-Backend/blob/main/README.md)).
  AAR + JNI is unusable from a browser and unusable from Kotlin/Native.

- **Kotlin/Native cannot produce an iPhone binary on Windows, at all.**
  "Building final binaries for Apple targets on Linux and Windows is also not possible."
  ([Kotlin/Native target support](https://kotlinlang.org/docs/native-target-support.html)).
  So the "just target Kotlin/Native instead" branch would *re-introduce* the Mac requirement
  the owner is trying to avoid.

- **Only Kotlin/Wasm runs in Safari, and it is Beta with a hard OS floor.** Kotlin/Wasm
  "is still in Beta" ([Kotlin/Wasm overview](https://kotlinlang.org/docs/wasm-overview.html));
  promotion to Stable is still an open roadmap item
  ([Kotlin roadmap](https://kotlinlang.org/docs/roadmap.html)). For WebKit: "For version
  18.2 or later: Works by default. For older versions: **Not supported**."
  ([Supported versions and configuration](https://kotlinlang.org/docs/wasm-configuration.html)).
  There is no `commonMain` in AnkiDroid for a Wasm target to consume, and the Rust backend
  it depends on cannot be compiled to Wasm either.

- **JVM bytecode cannot be reused by Kotlin/Native or Kotlin/Wasm.** This is the
  mechanism that kills the owner's premise. Kotlin/JVM emits `.class` files; Kotlin/Native
  emits platform `.klib`s; Kotlin/Wasm emits a Wasm module. All three consume the *same
  Kotlin source and common metadata*, and each backend lowers from that IR separately. A
  published AAR/JAR is a JVM artifact. KMP's promise is *source* portability through
  `expect`/`actual` and `commonMain`, never *artifact* portability. AnkiDroid has neither
  a `commonMain` nor any `expect` declaration to reuse.

- **"A lot of integrations with AnkiWeb" is three protocol families, all of which are
  already implemented in this repo.** The official client's entire AnkiWeb surface is 11
  collection methods (`rslib/src/sync/collection/protocol.rs:31-43`), 5 media methods
  (`rslib/src/sync/media/protocol.rs:28-34`) and `hostKey` login
  (`rslib/src/sync/login.rs:36-60`). Our `src/native-anki-sync.ts`, `src/native-anki-media.ts`,
  `src/native-anki-state.ts` and `src/native-anki-projection.ts` already implement auth +
  collection sync + media sync, oracle-verified against `anki==26.9.3`
  (`docs/native-anki-engine.md:89-129`). Upstream's *actual* contribution to a web app is
  its UI and its platform storage — neither of which is reachable from a browser.

- **Upstream has no WebAssembly build.** Searched `wasm32`, `wasm-bindgen`, `emscripten`
  across `*.toml`, `*.rs`, `*.py`, `*.ts`, `*.svelte` in `ankitects/anki`: **no result**.
  `git grep wasm` hits only `Cargo.lock` (transitive `wasm-bindgen` dependency of
  host-targeted crates, `Cargo.lock:721`), `cargo/licenses.json:1267` (its licence blurb)
  and `.dprint.json:33-37` (dprint formatter plugins shipped as Wasm). No target is
  declared in `.cargo/config.toml`. This negative result is load-bearing.

- **There is no supported public embedding interface for `rslib`.** `docs/api-rust.md` is
  three sentences about running `cargo doc`; it documents `anki` (`rslib/`) and `anki_io`
  and promises no stability. The bridge that does exist is Anki's *internal* Python↔Rust
  channel (`pylib/rsbridge`, `pyo3` with `extension-module`/`abi3-py39`,
  `Cargo.toml:120`), and Anki's own architecture doc says of it: "Languages used for
  AnkiDroid and AnkiMobile are out of scope of this document"
  ([docs/language_bridge.md](https://github.com/ankitects/anki/blob/main/docs/language_bridge.md)).
  `rslib` is not even publishable: `publish = false` (`rslib/Cargo.toml:6`).

- **The official iOS client cannot be forked: AnkiMobile is closed source.** Confirmed by
  the Anki developer on the project's own forum: "AnkiMobile is not open source"
  ([forums.ankiweb.net/t/ios-version-of-anki-on-github/51470](https://forums.ankiweb.net/t/ios-version-of-anki-on-github/51470)).
  And [apps.ankiweb.net](https://apps.ankiweb.net/) lists exactly two mobile clients —
  AnkiMobile (iOS) and AnkiDroid (Android). There is no official web client, which is why
  this repo exists.

- **The one thing upstream has that we lack and that genuinely matters: a self-hostable
  sync server — and it is AGPL.** `ankitects/anki` ships `anki-sync-server`
  (`rslib/sync/Cargo.toml:5-12`, `rslib/sync/main.rs:1-29`) implementing
  `anki::sync::http_server::SimpleServer` with a documented Docker deployment
  (`docs/syncserver/README.md`). AGPL-3.0 §13 forces us to offer its source to every user
  who reaches it over a network ([agpl-3.0.txt §13](https://www.gnu.org/licenses/agpl-3.0.txt)).
  See section 6.

---

## 2. What upstream actually offers — a precise inventory

### 2.1 AnkiDroid (`D:\work\Anki-Android`, commit `062c0f21`)

Gradle modules, all from [`settings.gradle.kts:31-43`](https://github.com/ankidroid/Anki-Android/blob/main/settings.gradle.kts):

| Module | Kind | Main-source files | Android import lines | What it is |
|---|---|---|---|---|
| `:AnkiDroid` | Android **app** (Groovy `build.gradle`, no `.kts`) | 2628 | — | The whole user-facing product. **This is where the UI and the account workflow live.** |
| `:anki-common` | `com.android.library` + Compose | 51 | 55 | Collection lifecycle, lease/manager, `SyncAuth` wrapper |
| `:libanki` | `com.android.library` | 49 | 34 | Thin Kotlin wrappers over the Rust backend |
| `:common` | **pure Kotlin/JVM** (`ankidroid.jvm.library` → `org.jetbrains.kotlin.jvm`) | 31 | 6 | Small utility layer |
| `:common:android` | `com.android.library` + parcelize | — | — | Android bindings for `:common` |
| `:compat` | `com.android.library` | 18 | 124 | Android compat shims (heaviest Android coupling in the repo) |
| `:api` | `com.android.library`, **LGPL-3.0**, `maven-publish` | 10 | 20 | Public ContentProvider API for *other apps to add cards* |
| `:widgets`, `:vbpd`, `:baselineprofile`, `:lint-rules` | Android libs / lint | — | — | UI widgets, vendored code, tooling |
| **`:backend`** | — | — | — | **Does not exist.** There is no `backend` module in the repository. |

Counts from `git ls-files` and `git grep -c '^import android'` over each module's `src/`.

The honest size of the reusable part:

- **The only artifact AnkiDroid publishes for third parties is `:api`** — an Android
  ContentProvider contract for adding cards from another app, published under
  **LGPL-3.0** (`api/build.gradle.kts:6`, `:46-51`, `:76-81`), built via
  `./gradlew :api:publishToMavenLocal` (`jitpack.yml:24-26`). It contains
  `FlashCardsContract`, `AddContentApi`, `BasicModel`, `Basic2Model`, `Ease`, `Flag` — no
  engine, no sync, no storage. `AnkiDroid/build.gradle.kts` has **no `publishing` block
  at all**; `AnkiDroid`, `libanki`, `anki-common`, `common`, `compat` are not published.
- **`libanki` is not portable, and it is small anyway.** 49 main-source files; 22 import
  `android.*`/`androidx.*`. 21 of those are only `androidx.annotation`
  (`VisibleForTesting`, `CheckResult`, `WorkerThread`, `IntDef`). Exactly **one file**,
  `libanki/src/main/java/com/ichi2/anki/libanki/DB.kt:22-26`, imports real
  `android.content.ContentValues`, `android.database.Cursor`, `android.database.SQLiteDatabase`
  (and `androidx.sqlite.db.SupportSQLiteDatabase`). So the *source-level* Android coupling
  is genuinely small and well isolated. **But the module is still an Android AAR**
  (`libanki/build.gradle.kts:5`) and 20 of its 49 files reference `net.ankiweb.rsdroid` —
  the Rust backend package — which is the blocker that matters.
- **Where the AnkiWeb integration lives.** Entirely in the Rust backend, reached by one
  protobuf call. `anki-common/src/main/kotlin/com/ichi2/anki/sync/SyncAuth.kt:30-43` is the
  *entire* Kotlin sync surface: four one-line extensions (`syncStatus`, `syncMedia`,
  `syncCollection`, `fullUploadOrDownload`). `AnkiDroid/src/main/java/com/ichi2/anki/Sync.kt:52-83`
  builds a `SyncAuth` from `Prefs.hkey` and a timeout. Login is
  `AnkiDroid/src/main/java/com/ichi2/anki/account/LoginViewModel.kt:107-113`:
  `withCol { SyncAuth(syncLogin(username, password, endpoint)) }`. **There is no Kotlin HTTP
  client, no cookie jar, and no AnkiWeb protocol code in AnkiDroid at all** — searched
  `ankiweb.net`, `AnkiWebClient`, `/account/`, `hostKey`, `hkey` across `*.kt`.
- **Shared decks / deck listing is Android-infrastructure-bound.** It uses
  `android.app.DownloadManager` (`SharedDecksDownloadViewModel.kt:27-29`) and reads the
  AnkiWeb session cookie out of the system cookie store
  (`SharedDecksActivity.kt:125`). Neither is available in a browser. The only sync-adjacent
  AnkiWeb surface not in `rslib` at all.
- **Licence.** Project is **GPL-3.0-or-later** (`COPYING`, the GNU GPL v3 text;
  per-file SPDX headers, e.g. `anki-common/build.gradle.kts:1`; `REUSE.toml`). The backend
  is **AGPL-3.0-or-later** (README "License" section: *"AGPL-3.0 License ... for some part
  of the back-end"*). The `:api` module is **LGPL-3.0** (`api/COPYING.LESSER`).
  `LICENSES/` holds `Apache-2.0.txt`, `GPL-3.0-or-later.txt`, `LGPL-3.0-or-later.txt` —
  these are REUSE-compliance licence texts, not a fourth licence for the project.
- **Policy on forking / third-party use / iOS.** Searched `CONTRIBUTING.md`, `README.md`,
  `AI_POLICY.md`, `CLAUDE.md`, `docs/`, `.github/` for fork / third-party / port / iOS
  / derivative policy. There is **no licence exception and no iOS-port policy**. What does
  exist is `AI_POLICY.md`, which restricts AI-assisted contributions and requires an
  `Assisted-by:` trailer — a collaboration-friction factor for upstreaming patches, not a
  legal bar.

### 2.2 `ankitects/anki` (`D:\work\ankitects\anki`, commit `fe4f9e03`)

- **Licence.** "Anki is licensed under the GNU Affero General Public License, version 3 or
  later, with portions contributed by Anki users licensed under the BSD-3 license"
  ([`LICENSE:1-3`](https://github.com/ankitects/anki/blob/main/LICENSE)). Workspace
  `license = "AGPL-3.0-or-later"` (`Cargo.toml:6`). Enumerated exceptions are all
  *vendored third-party* items — `pylib/statsbg.py` (CC BY 4.0), `qt/mpv.py` (MIT),
  `qt/MathJax` (Apache 2), jQuery (MIT), protobuf.js (BSD-3) (`LICENSE:5-17`).
- **About the "Anki Build Library with a distinct non-AGPL licence":** this hypothesis is
  **not supported by the sources I could read.** Searched `Build Library`, `AGPL`, `licen`
  across `docs/*`, `README.md`, `CLAUDE.md`, `AGENTS.md`: the only licence reference is
  `README.md:33` (`Anki's license: [LICENSE](./LICENSE)`). `rslib/README.md` in full is two
  lines: "Anki's Rust code." `git ls-files` shows **exactly one** licence file in the repo,
  `LICENSE`. What *does* exist is the third-party build of the backend, which is **GPL-3.0
  + AGPL-3.0** ("GPL-3.0 License ... AGPL-3.0 Licence (anki submodule)", AnkiDroid-Backend
  README "License"). If someone told the owner `rslib` is available under a permissive
  licence, that is wrong.
- **Embedding path.** None public. `pylib/rsbridge` + `pyo3` is Anki's internal bridge.
  No `uniffi`, no `cbindgen`, no `rslib-bridge` crate in this repo (`rslib-bridge` exists
  in AnkiDroid-Backend, JNI-only). `docs/language_bridge.md` explicitly scopes the
  documented patterns to Anki's own three layers.
- **Wasm build: none.** See section 1.
- **The sync server IS in this repo.** `rslib/sync/` is a binary crate `anki-sync-server`
  (`publish = false`, `rslib/sync/Cargo.toml:1-12`) whose `main.rs` calls
  `anki::sync::http_server::SimpleServer::run()`. The server implementation is
  `rslib/src/sync/http_server/{mod,handlers,routes,user,media_manager}.rs`, holding users in
  an in-memory `HashMap<String, User>` with per-user SQLite collection folders
  (`rslib/src/sync/http_server/mod.rs:52-56`, `rslib/src/sync/http_server/user.rs:14-22`)
  — no Postgres required for the simple server. Deployment is documented in
  `docs/syncserver/README.md`. This is the single biggest thing upstream has that we do not,
  and it is AGPL — see section 6.
- **The `ts/` frontend is a SvelteKit web UI, rendered inside Qt WebEngine.**
  `qt/aqt/qt/qt6.py:19` imports `PyQt6.QtWebEngineWidgets`; `qt/aqt/webview.py:88-137`
  installs a `QWebEngineScript` that bridges to Python via `QWebChannel`. Backend calls
  from Svelte (`import { getDeck } from "@generated/backend"`) go over HTTP to
  `/_anki` on a localhost server started by the Qt process
  (`ts/vite.config.ts:42-51`, `qt/aqt/mediasrv.py:1167`, `:1241-1248`). There is **no
  service worker, no web app manifest, no PWA**: searched `serviceWorker`,
  `service-worker`, `workbox`, `manifest.webmanifest` across `ts/*` and `qt/*` — no result.
  So "Anki already has an HTML UI" is true and also irrelevant: it is a locally-served app
  that requires a Qt + Python + Rust process on the same machine to answer `/_anki`, and it
  has no offline shell to install on an iPhone.
  *Honest nuance:* Anki's own build targets browsers down to iOS —
  `browserslist` includes `"iOS 14.5"` (`package.json` browserslist) and the Vite build
  target includes `safari14` (`ts/vite.config.ts:29-30`). The bundles are browser-legal. That
  does not make them a deliverable.
- **Protocol 10 / schema 11 is still current — this is now positively confirmed, not just
  verified by our oracle.** `rslib/src/sync/version.rs:10-11`:
  `SYNC_VERSION_MIN = SYNC_VERSION_08_SESSIONKEY (8)`,
  `SYNC_VERSION_MAX = SYNC_VERSION_11_DIRECT_POST (11)`. And
  `SyncVersion::collection_schema()` (`version.rs:66-72`) maps any multipart version
  (`< 11`) to `SchemaVersion::V11` and 11+ to `V18`. Storage declares
  `SCHEMA_MIN_VERSION = 11`, `SCHEMA_MAX_VERSION = 18`
  (`rslib/src/storage/upgrades/mod.rs:4-9`) and retains a working
  `downgrade_to_schema_11()` (`rslib/src/storage/upgrades/mod.rs:59`) used for legacy sync
  (`rslib/src/storage/sqlite.rs:822`). Our `docs/native-anki-engine.md:19-24` claim is
  corroborated by upstream source.

---

## 3. Where the reuse claim collapses

### 3.1 AnkiDroid

| Claim | Verdict | Evidence |
|---|---|---|
| "It's Kotlin, so it's close to KMP" | **False.** Zero Multiplatform surface. | No `kotlin("multiplatform")`, no `commonMain`/`iosMain`, no `iosArm64`, no `xcframework`, no `.swift`, no `konan`, no `wasm` — searched `*.kts`/`*.toml`/`*.gradle`/`*.properties`/`*.yml`/`*.md` in `D:\work\Anki-Android`: no result. Plugins are `kotlin.android`, `kotlin.jvm`, `kotlin.parcelize`, `kotlin.serialization`, `kotlin.compose` (`gradle/libs.versions.toml:255-259`). |
| "Android coupling is small, so it's portable" | **Half true, and irrelevant.** Source coupling is small; the *artifact* and the *dependency* are not. | Real `android.*` imports: one file, `libanki/.../DB.kt:22-26`. But `libanki` is a `com.android.library` AAR (`libanki/build.gradle.kts:5`) and 20 of 49 main files import `net.ankiweb.rsdroid` — the Rust AAR built by the Android NDK. |
| "It already has a lot of AnkiWeb integrations we could reuse" | **False as Kotlin code.** The integrations live in Rust; the Kotlin is four one-line wrappers. | `anki-common/.../sync/SyncAuth.kt:30-43`. Login is one backend call: `LoginViewModel.kt:107-113`. No HTTP client, no cookies, no protocol code in Kotlin (searched `ankiweb.net`, `AnkiWebClient`, `hostKey` across `*.kt`). |
| "Shared decks / AnkiWeb manifest integration" | **Not reusable in a browser.** Uses Android-only APIs. | `SharedDecksDownloadViewModel.kt:27-29` (`android.app.DownloadManager`); `SharedDecksActivity.kt:125` (system cookie store for `https://ankiweb.net`). Not present in `rslib` at all. |
| "There must be a reusable artifact" | **Only the `:api` module, and it is not an engine.** | `api/build.gradle.kts:6` (`maven-publish`), `:46-51` (singleVariant release), `:76-81` (LGPL-3.0). `jitpack.yml:24-26` builds *only* `:api`. `AnkiDroid/build.gradle.kts` has no `publishing` block. |
| "There is a `backend` module we can port" | **False — there is no `backend` module.** It is a separate repository. | `settings.gradle.kts:31-43` lists `:anki-common`, `:api`, `:AnkiDroid`, `:baselineprofile`, `:common`, `:common:android`, `:compat`, `:libanki`, `:lint-rules`, `:vbpd`, `:widgets`. No `:backend`. `BackendDependencies.kt:10-26` documents the separate `Anki-Android-Backend` repo. |
| "`libanki` is a git submodule" | **False.** No `.gitmodules` in Anki-Android. | `cat .gitmodules` → file does not exist. `libanki/` is in-tree. |
| "Kotlin is close enough to KMP that a port is mostly mechanical" | **False.** A port means re-authoring against `expect`/`actual` from scratch, plus reimplementing the Rust engine's role. | No `commonMain` exists. `rsdroid` is a JNI/protobuf AAR; `anidroid/.../Sync.kt` and `libanki/.../Sync.kt:22-34` call straight into `net.ankiweb.rsdroid.Backend` / `anki.sync.*` protobuf messages generated from the backend repo. |
| "GPL is permissive enough" | **GPL-3.0-or-later + AGPL-3.0 for the backend.** Any shipped derivative must be GPL; any network use of the backend triggers §13. | `README.md` "License"; `anki-common/build.gradle.kts:1`; `REUSE.toml`. |

### 3.2 `ankitects/anki`

| Claim | Verdict | Evidence |
|---|---|---|
| "We can embed `rslib` — it's Rust, we can compile it" | **Compiles, but cannot ship in a browser.** No Wasm target exists; adding one means porting `rusqlite` (bundled C SQLite), `tokio`, `reqwest`+TLS, `axum`, `rayon`, and the whole `axum` HTTP-server stack to `wasm32-unknown-unknown`. Nothing upstream would help. | No `wasm32` target in `.cargo/config.toml`. Searched `wasm32`/`wasm-bindgen`/`emscripten` across `*.toml`/`*.rs`/`*.py`/`*.ts`/`*.svelte`: **no result**. `Cargo.lock:721` etc. are transitive `wasm-bindgen` entries for host builds, not a target. |
| "There's a supported third-party API" | **False.** | `docs/api-rust.md` in full: 11 lines, "generated from doc comments … using `cargo doc`", lists `anki` and `anki_io`. No stability promise, no versioning, no examples. `rslib/Cargo.toml:6` `publish = false`. |
| "There's an `rslib-bridge` for us to use" | **It exists but it is Anki's internal Python bridge, and a JNI one in AnkiDroid's fork.** | `Cargo.toml:120` `pyo3 = { features = ["extension-module","abi3","abi3-py39"] }`; `pylib/rsbridge` is a workspace member (`Cargo.toml:14`). `rslib-bridge` is in AnkiDroid-Backend and is JNI. `docs/language_bridge.md`: "Languages used for AnkiDroid and AnkiMobile are out of scope of this document." |
| "The `ts/` frontend is a web app, so we can use it" | **False as a deliverable.** It is a locally-served UI that needs a Qt+Python+Rust process behind `/_anki`, and has no offline/PWA shell. | `qt/aqt/qt/qt6.py:19`; `qt/aqt/webview.py:88-137` (`QWebChannel` bridge); `ts/vite.config.ts:42-51` proxies `/_anki` to `127.0.0.1:40000`; `qt/aqt/mediasrv.py:1241-1248` forwards to `aqt.mw.col._backend` (pyo3). Searched `serviceWorker`/`workbox`/`manifest.webmanifest` in `ts/*`,`qt/*`: no result. |
| "The AnkiWeb sync server is proprietary, so we must depend on sync.ankiweb.net" | **False — a self-hostable AGPL sync server ships in this repo.** | `rslib/sync/Cargo.toml:1-12` (`anki-sync-server`), `rslib/sync/main.rs:20` (`SimpleServer::run()`), `rslib/src/sync/http_server/mod.rs:52-56` (in-memory users + SQLite folders), `docs/syncserver/README.md`. |
| "Upstream may have dropped protocol 10 / schema 11" | **False — positively contradicted.** Protocol 10 is still inside `[8, 11]`, and schema 11 is still the *minimum* openable schema with a working downgrade path. | `rslib/src/sync/version.rs:10-11`, `:66-72`; `rslib/src/storage/upgrades/mod.rs:4-9`, `:59`; `rslib/src/storage/sqlite.rs:822`. |
| "We could reuse the AGPL code under a lax licence" | **False.** AGPL-3.0-or-later, with only vendored-dependency exceptions. | `LICENSE:1-17`; `Cargo.toml:6`. No separate non-AGPL build-library licence exists in this tree (searched `Build Library` → no result; only one `LICENSE` file in the repo). |

---

## 4. The two hard constraints

### 4.1 "I have no Mac and don't want to need one"

**First, the honest concession: a native iOS app *can* be built without owning a Mac.**
Hosted macOS CI exists and is cheap or free:

- **GitHub-hosted macOS runners**: `macos-15-intel`, `macos-26-intel` (4 CPU / 14 GB), and
  `macos-latest`, `macos-14`, `macos-15`, `macos-26`, `xcode-27` on arm64 (3× M1 / 7 GB).
  "Use of the standard GitHub-hosted runners is **free and unlimited on public
  repositories**." Private repos draw from the free allowance then per-minute rates
  ([GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
- **Codemagic**: 500 free macOS M2 minutes/month on an individual account; $0.095/min M2,
  $0.114/min M4 after that; $3,990/yr fixed plan ([Codemagic pricing](https://docs.codemagic.io/billing/pricing/)).
- **CircleCI**: `macos` executor with an `xcode:` key (docs show `xcode: 27.0.0`) and
  `resource_class: m4pro.medium` ([Configuring a macOS application on CircleCI](https://circleci.com/docs/guides/execution-managed/hello-world-macos)).

So the binding constraint is **not** the Mac. It is Apple's own gate:

- **Distribution and on-device testing require paid membership.** Apple's feature matrix
  gives a check to "On-device testing using Xcode" only for Apple Developer Program /
  Enterprise members; the free-registration column is blank
  ([Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)).
  Same page: "To build more advanced app capabilities and **distribute** apps, you'll need an
  Apple Developer Program member…"
- **Free provisioning is unusable for this app.** "You can register up to 10 App IDs, which
  expire after 7 days. You can register up to 3 devices, which expire after 7 days. You can
  install up to 3 apps per device. Provisioning profiles that enable apps to be installed on
  a device will expire 7 days from issuance. You'll need to rebuild and reinstall your app to
  your device after expiration." (same page)
- **Membership is $99/year**, and Xcode Cloud's included 25 compute hours/month is part of
  that membership ([Membership Details](https://developer.apple.com/programs/whats-included/)).

Against that, our repo's current claim is: *"No Mac, Apple Developer membership, or paid
service is required."* (`README.md:10`). That claim is **true for the web route and false
for any native route** — and the honest framing is not "no Mac", it is "no $99/yr Apple
membership, no 7-day rebuild treadmill, no signing-key custody, and nothing to install at
all." Being precise here matters, because it is the strongest *honest* argument for the web
route, and it is a budget-and-hassle argument, not a Mac argument.

**Cost of the web route that we already accepted:** a HTTPS origin for the PWA
(`README.md:28`, Issue #24) and a gateway deployment
(`docs/ankiweb-account-sync.md:15-24`). Both are free-tier.

### 4.2 "It has to be a web app that runs in Safari on an iPhone"

This is the constraint that actually decides it.

**What makes the web route possible at all (and it is a real advantage):**

- Home Screen web apps get their own day-of-use counter and are exempt from the ITP
  seven-day deletion of script-writable storage: *"Web applications added to the home
  screen are not part of Safari and thus have their own counter of days of use. Their days of
  use will match actual use of the web application which resets the timer. We do not expect
  the first-party in such a web application to have its website data deleted. If your web
  application does experience website data deletion, please let us know since we would
  consider it a serious bug."* ([Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more))
  The affected forms, when not installed, are: IndexedDB, LocalStorage, Media keys,
  SessionStorage, **Service Worker registrations and cache**.
- Quotas are generous and predictable since Safari 17: origin quota up to 60% of total disk
  for a browser app, overall up to 80%; a standalone Home Screen web app "has the same origin
  quota and overall quota as when it is opened in a browser app." `navigator.storage.estimate()`
  and `navigator.storage.persist()/persisted()` are fully supported, and "WebKit currently
  grants a request based on heuristics like whether the website is opened as a Home Screen Web
  App." ([Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/))

**The risks we take by choosing it — stated plainly, because they are real:**

| Risk | Evidence | Severity for us |
|---|---|---|
| Eviction of a whole origin, least-recently-used, when over overall quota or under storage pressure | [Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/): "Eviction means automatic website data deletion… WebKit normally evicts data on an origin basis: the data of an origin will be deleted as a whole." | **High.** Our multi-year review log is a single-origin store. Mitigation: call `navigator.storage.persist()`, ship the sync gateway + AnkiWeb as the recovery path, and never rely on local data being the only copy. |
| Not installing (or being idle) puts IndexedDB on the 7-day ITP clock | [ITP 7-day cap](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more) | Medium — mitigated by "Add to Home Screen", which our `docs/offline-verification.md` already makes a release-checklist item. |
| **iOS Lockdown Mode disables Service Workers, Web Locks, Cache API and CacheStorage** | [WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/): "Disable Cache API / Disable CacheStorage API / Disable ServiceWorkers / Disable the WebLocks API" | **High and under-estimated in our docs.** Our sync engine serialises sessions with **Web Locks** (`docs/native-anki-engine.md:37`, `:77`) and the PWA shell depends on a Service Worker (`README.md:185`). Under Lockdown Mode the app must degrade to "no offline shell, no cross-tab serialisation". This is not mentioned anywhere in `docs/offline-verification.md` and should be. |
| No Apple push guarantees; background sync is best-effort | Web Push on iOS arrived in 16.4 and is tied to a Home Screen web app ([Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)); Anki's own developer notes AnkiMobile "needs to be running in the background to be able to schedule a notification" ([forum](https://forums.ankiweb.net/t/ios-version-of-anki-on-github/51470)) | Medium. Does not affect daily review (the user opens the app), does affect due-count badges. |
| **Browser cannot talk to AnkiWeb directly — CORS** | `docs/ankiweb-account-sync.md:9`: "a credential-free OPTIONS probe to `https://sync.ankiweb.net/sync/meta` with an unrelated Origin returned 405 and no Access-Control-Allow-Origin." | **Structural.** A gateway is mandatory for *any* browser-based client, ours or a fork of upstream's. It is not a reason to prefer upstream. |
| Automated offline proof is Chromium-only | `README.md:185`; `docs/offline-verification.md:16`: Playwright documents service-worker automation as supported only in Chromium, so "phone-sized WebKit results do not prove installed Safari cold reopening" | Process risk, not product risk. Already tracked as #25/#26. |

**And the native route's mirror-image risks**, for balance: a $99/yr membership, 7-day
free provisioning, an App Store/TestFlight submission surface, a signed binary whose review
log lives in app-private storage that Safari ITP cannot touch (a genuine *advantage* of
native for this app), and — decisively — no reuse of upstream at all, since
`ankitects/anki`'s engine has no mobile target and AnkiMobile is closed source
([forum](https://forums.ankiweb.net/t/ios-version-of-anki-on-github/51470)).

---

## 5. Kotlin and KMP: the technical truth

### 5.1 The three Kotlin backends

| | Produces | Runs in Safari/iOS? | Can build on Windows? |
|---|---|---|---|
| **Kotlin/JVM** | `.class` / JAR / **AAR** | No | Yes |
| **Kotlin/Native** | platform binary, `.klib` | Yes, as a native iOS app — **not in a browser** | **No for Apple targets** |
| **Kotlin/Wasm** (`wasmJs`) | `.wasm` + JS glue | Yes, in a browser — **Beta**, WebKit ≥ 18.2 | Yes |
| Kotlin/JS | `.js` | Yes | Yes |

Primary sources: [Kotlin/Wasm configuration](https://kotlinlang.org/docs/wasm-configuration.html)
("Safari/WebKit — For version 18.2 or later: Works by default. For older versions: Not
supported."), [Kotlin/Wasm overview](https://kotlinlang.org/docs/wasm-overview.html)
("Kotlin/Wasm is still in Beta"), [Kotlin roadmap](https://kotlinlang.org/docs/roadmap.html)
("Compiler: 🆕 Promote Kotlin/Wasm to Stable" listed under *In focus now*),
[Kotlin/Native target support](https://kotlinlang.org/docs/native-target-support.html)
("Building final binaries for Apple targets on Linux and Windows is also not possible";
hosts table lists only macOS for Apple targets).

### 5.2 Can AnkiDroid's JVM bytecode be reused by Kotlin/Native or Kotlin/Wasm?

**No.** The mechanism:

1. Kotlin source is compiled front-to-back into a common IR, then each backend lowers that
   IR separately: JVM → bytecode, Native → LLVM IR, Wasm → Wasm. `commonMain` sources are
   lowered *three times*.
2. A published `.jar`/`.aar` contains **only** the JVM lowering. The KMP metadata (`*.kotlin_metadata`)
   that enables cross-backend reuse ships in `.klib`s and in `-metadata` artifacts, and even
   then only for libraries built *as* KMP libraries.
3. Therefore KMP's portability guarantee is a **source-level** guarantee
   (`expect`/`actual`, `commonMain`), not an artifact-level one. It is frequently described
   loosely as "code reuse"; the precise statement is "the same `.kt` files can be compiled
   by more than one backend".
4. AnkiDroid has **zero** `expect` declarations and **zero** `commonMain` sources
   (searched `commonMain` across the whole repo: no result). So there is nothing for a
   hypothetical `wasmJs` or `iosArm64` target to consume.

Even in the best case, AnkiDroid's dependency chain defeats it: `libanki` → `net.ankiweb.rsdroid.Backend`
→ the AnkiDroid-Backend AAR → JNI + protobuf into `rslib` compiled for Android ABIs with the
Android NDK. Kotlin/Native cannot consume an AAR. Kotlin/Wasm cannot consume an AAR. Both
would need a *new* Wasm or iOS-native build of the entire Rust engine, which upstream does
not provide and which is a porting project of the same magnitude as writing our own
scheduler and sync client — with none of the browser fit.

### 5.3 Decisive framing for this project

> **Which Kotlin output can run inside Safari? Only Kotlin/Wasm. How much of AnkiDroid is
> reachable through a Kotlin/Wasm `commonMain`? None — it does not exist yet, and its
> substantive dependency is a native AAR that Wasm cannot load.**

The Kotlin/Wasm route would therefore mean: write the whole AnkiDroid *again* in
`commonMain`, replace SQLite with a Wasm SQLite, replace the entire Rust backend with a Wasm
build of `rslib` that upstream does not publish, and target a Beta compiler that
WebKit < 18.2 cannot run. That is strictly more work than what this repo has already done in
TypeScript, and it produces a strictly less capable artifact (no app store, no push, no
native notifications, no background sync).

---

## 6. Risks we take on by NOT reusing upstream

This section is deliberately hostile to our own approach.

### 6.1 We are protocol-implementation-dependent, and that is the big one

Our sync boundary is legacy AnkiWeb **protocol 10**, which carries native collection
**schema 11** (`docs/native-anki-engine.md:8-24`; enforced in code at
`src/native-anki-sync.ts:45`, which rejects any collection whose `col.ver` is not 11).
Everything in `src/native-anki-*.ts` is written against that boundary.

**How likely is upstream to drop it? Lower than we feared, and it is now evidenced both ways:**

*Evidence it will be kept:* `SYNC_VERSION_MIN = 8`, `SYNC_VERSION_MAX = 11`
(`rslib/src/sync/version.rs:10-11`) — protocol 10 is interior, not edge. `SCHEMA_MIN_VERSION = 11`
(`rslib/src/storage/upgrades/mod.rs:5`) — schema 11 is the *minimum* the current client will
open. `downgrade_to_schema_11()` is still maintained and exercised
(`rslib/src/storage/upgrades/mod.rs:59`, `rslib/src/storage/sqlite.rs:822`). Protocol 10 is
what AnkiDroid uses against modern AnkiWeb, so dropping it would break the entire Android
user base — an ecosystem that is far larger than any protocol-11-only client. That is the
single strongest reason to expect it to persist.

*Evidence it could be dropped:* upstream already writes off the *old* end. `version.rs:15-17`:
"At the end of 2022, only used by 0.045% of syncers. Half are AnkiUniversal users, as it never
added support for the V2 scheduler." Upstream is demonstrably willing to delete a sync
protocol version once usage collapses. The same reasoning applied to protocol 11 in a few
years would kill protocol 10. Also `SyncVersion::collection_schema()`
(`version.rs:66-72`) means the *newest* protocol implies schema 18; every schema bump
widens the gap between what we implement and what a modern client offers.

*What breaks if it happens:* not a crash — a clean stop. `src/native-anki-sync.ts:45`
throws a typed `NativeSyncError('upgrade', …)` and the engine retains the checkpoint
(`docs/native-anki-engine.md:133-139`: "Other SQLite versions and upstream stop/upgrade
responses fail safely with the native checkpoint retained"). The cost is **the AnkiWeb
feature**, not the app: review, scheduling, statistics, offline and package interchange all
continue to work. Recovery is non-trivial but not catastrophic: a `.colpkg`/`.apkg` round trip
through a desktop Anki remains available (`src/anki-export.ts`, `src/anki-import.ts`).

**Mitigation we should adopt (open question 3):** make the boundary explicit and
alerting — a first-class "AnkiWeb needs an update" state surfaced in the UI, not a raw error
string — and add a CI job that runs the oracle against the *latest published* `anki` wheel
rather than only the pinned 26.9.3, so we learn about a boundary move from a test failure
rather than from a user's phone.

### 6.2 The AGPL sync server is the one thing we should be genuinely tempted by

Upstream ships a self-hostable sync server (`rslib/sync`, `docs/syncserver/README.md`). If
we ran it as our gateway, we would not depend on `sync.ankiweb.net` at all, would remove the
Cloudflare-Workers dependency, and would get a durable server-side backup of the collection.

**What it costs.** AGPL-3.0 §13: *"if you modify the Program, your modified version must
prominently offer all users interacting with it remotely through a computer network (if your
version supports such interaction) an opportunity to receive the Corresponding Source of your
version…"* ([agpl-3.0.txt](https://www.gnu.org/licenses/agpl-3.0.txt)). A gateway serving our
single user's iPhone is "interacting remotely"; §13 is engaged on the plain reading, and the
project's own copy of the Sync Server manual already treats the server as a networked
service (`Sync Server - Anki Manual.html`). The honest reading is that we would have to
publish the gateway's source to anyone who reaches it. For a private, single-user tool whose
entire value proposition is privacy (`README.md:187-189`), publishing the sync path is a bad
trade — and it is *our* gateway code that would be published, not Anki's, because §13 covers
the modified combined work.

**Recommendation: do not adopt it for the shipped gateway.** Keep it as a *development-time
oracle* — which is exactly the role `scripts/verify-native-anki-sync.mjs` already plays, and
which raises no distribution question because nothing is conveyed and no one interacts with
it over a network except the test process itself (§13 is conditioned on "(if your version
supports such interaction)" and on there being *users* interacting remotely).

### 6.3 Our own bugs, our own maintenance burden

Honest accounting of what reimplementation costs us:

- **We own the scheduler divergence.** `README.md:147` pins behaviour to "Anki 26.9.3"
  with FSRS-6, 21 default weights, 36,500-day max interval, 0.9 desired retention. Upstream
  depends on `fsrs 6.6.2` (`Cargo.toml:38-41`). Every FSRS default change, every fuzz-range
  change, every interday-learning change upstream must be tracked by hand. There is no test
  suite that would tell us we drifted; only `src/anki-parity.test.ts` and manual comparison.
- **We own the search/filter language.** `README.md:163` implements `deck:`, `tag:`,
  `flag:`, `is:`, `due:`, `rated:`, `prop:`, `w:`, `re:`, `nc:`, `sc:`… Anki's reference
  implementation is [docs.ankiweb.net/searching.html](https://docs.ankiweb.net/searching.html)
  and it grows. Drift here is user-visible and silent.
- **We own the media protocol's edge cases.** `docs/native-anki-engine.md:66-80` documents
  25-file batches, 2.5 MiB targets, 63 MiB per-file ceiling, SHA-1 verification, ZIP
  boundary validation, divergent-version retention. Each of those was found by the oracle.
  A protocol-11 move changes all of them.
- **We have no installed-iPhone evidence at all.** `docs/native-anki-engine.md:141-143` and
  `docs/offline-verification.md:25-30`: physical cold-launch, airplane-mode, PC-off sync,
  audible audio, and image re-render remain outstanding. `docs/offline-verification.md:18`
  also records a live, independently reproduced **Windows WebKit offline blob decoding
  failure** (tracked as #58). A native app would not have these problems; a web app does.
- **We own our own bugs in code we wrote fast.** `docs/adr/0002-rules-own-modules.md`
  documents seven instances of duplicated rules found in review, and one that had already
  shipped a correctness bug: three eligibility re-implementations used `a || b` and one used
  `a ?? Boolean(b)`, "so under `??` those cards read as *available* and a suspended card
  became answerable again."

### 6.4 What reimplementation buys us

Not nothing. Be clear-eyed:

- **Licence cleanliness.** Our code is ours; no AGPL §13 obligation on the gateway.
- **A boundary that can be a browser.** The native engine runs in the page, in a Service
  Worker-friendly architecture, with Dexie/IndexedDB storage
  (`package.json` — `dexie`, `sql.js`, `fflate`, `fzstd`, `vite-plugin-pwa`).
- **A domain model that is not Anki's.** `GLOSSARY.md` defines *Deck Path*, *Native
  Identity*, *Synthesised Deck*, *Import Plan*, *Study Eligibility* as first-class
  concepts. Reusing Anki's UI would mean adopting Anki's model, which ADR 0001 shows does
  not round-trip cleanly (`docs/adr/0001-synthesised-deck-identity.md`).

---

## 7. What we SHOULD steal from upstream anyway

All of these are licence-clean *as facts, tests and documentation*, or are already in use.

1. **The protocol spec as executable tests.** `rslib/src/sync/collection/{meta,chunks,graves,sanity,start,finish,upload,download}.rs` and
   `rslib/src/sync/media/*.rs` are the ground truth for every wire field. We already cite
   them (`docs/native-anki-engine.md:145-157`). Turn them into **round-trip fixtures** we
   can diff against, rather than re-reading them each time a protocol question arises.
2. **Wiremock-based unit tests for the client.** `rslib/src/sync/login.rs`'s test module
   (`sync_login_returns_host_key_on_success`, `sync_login_maps_forbidden_to_auth_failed`)
   is a 20-line pattern we should copy into our own tests — cheap, hermetic, and it would
   have caught the `{"u":…,"p":…}` short-field-name subtlety that the test explicitly pins
   (`rslib/src/sync/login.rs:96-105`).
3. **The oracle harness pattern.** `scripts/verify-native-anki-sync.mjs` is our best asset
   and it is licence-clean *as a technique*: it imports the official wheel only as a test
   dependency, runs on `127.0.0.1`, and generates fake accounts
   (`scripts/verify-native-anki-sync.mjs:16-30`). Keep extending it — including against the
   **latest** wheel, not only 26.9.3 (see §6.1).
4. **The upstream sync server as a *second* oracle.** Not in production (§6.2), but as a CI
   fixture it lets us test against both "server we run" and "AnkiWeb's real server shape"
   without credentials.
5. **`rslib/src/sync/version.rs` as a tripwire.** Copy `SYNC_VERSION_MIN`/`MAX` and
   `SCHEMA_MIN_VERSION` into a doc-linked test that fails when upstream's supported window
   stops containing `{10, 11}`.
6. **The Anki manual as a specification.** [docs.ankiweb.net](https://docs.ankiweb.net/) —
   searching, FSRS defaults, scheduler states, filtered decks, deck options, template
   filters. It is prose + FTL, CC-BY-SA-licensed documentation; cite, do not copy.
7. **`fsrs` weights and constants.** `README.md:147` already pins FSRS-6 / 21 weights;
   `Cargo.toml:38-41` is where upstream gets them. Automate the comparison.
8. **Anki's own `browserslist` as a compatibility signal.** `package.json` (Anki) targets
   `"iOS 14.5"`; `ts/vite.config.ts:29-30` targets `safari14`. Useful as an upstream floor
   for what their frontend assumes about Safari.
9. **AnkiDroid's `AI_POLICY.md` shape** — not for its content, but as a precedent if we ever
   want an explicit upstream-contribution policy for kiroku. Worth writing down before the
   first time it matters.

---

## 8. Open questions the owner must decide

1. **Is "no Mac" the real constraint, or is it "$0/yr and no signing keys"?**
   *Recommendation:* treat the second as the real constraint and write it down that way
   (`README.md:10` currently says "No Mac, Apple Developer membership, or paid service is
   required", which is precise but invites the objection that a hosted macOS runner removes
   the Mac). If the owner ever accepts $99/yr, a native shell becomes an option worth
   re-examining — not for reusing upstream, but because native storage is immune to Safari
   eviction (§4.2), which is our largest product risk.
2. **Do we keep the AnkiWeb gateway on Cloudflare Workers, or do we self-host?**
   *Recommendation:* keep Workers Free, and record the decision plus the failure mode
   (limits reached → sync fails loudly, never silently; never a paid upgrade). Already
   written up at `docs/ankiweb-account-sync.md:15-17`.
3. **Should the oracle run against the latest wheel in CI, not only the pinned 26.9.3?**
   *Recommendation:* yes, as a separate non-blocking nightly job that opens an issue on
   failure. This is the cheapest available early warning for the protocol-10/schema-11 risk
   (§6.1). Currently `docs/native-anki-engine.md:91` pins 26.9.3 only.
4. **Do we want a native shell later as a thin wrapper around the PWA?**
   *Recommendation:* possible (a WKWebView shell would keep Safari's engine but move storage
   into app-private space and enable push), but it re-opens the $99/yr question and adds a
   signing pipeline. Park it; do not design for it now.
5. **Should `docs/offline-verification.md` record the Lockdown Mode risk explicitly?**
   *Recommendation:* yes. Service Workers and Web Locks are both disabled under Lockdown Mode
   (§4.2) and our engine depends on both. Add it to the release checklist alongside the
   #25/#26 physical items.
6. **Do we accept that "HTML Anki exists upstream" is true and irrelevant?**
   *Recommendation:* yes, and say so once in writing so the question is not re-asked.
   `ankitects/anki`'s `ts/` UI needs a Qt+Python+Rust process answering `/_anki` on
   localhost and has no service worker; it is a desktop app's UI, not a web product
   (`qt/aqt/webview.py:88-137`, `ts/vite.config.ts:42-51`).
7. **Naming collision: "schema 11" means two different things in this repo.**
   *Recommendation:* disambiguate in `docs/native-anki-engine.md`. `src/native-anki-sync.ts:45`
   rejects Anki native `col.ver !== 11`, while `schema-ladder.ts` and `sync-capabilities.ts`
   describe kiroku's *own* ladder (`CLIENT_COLLECTION_SCHEMA_VERSION = 16`, `SYNC_PROTOCOL_VERSION = 2`).
   A future reader will conflate them. Consider "Anki native schema 11" vs "kiroku schema 16".

---

## 9. Sources

### Our repository (`D:\work\anki`)
- `README.md:3`, `:10`, `:28`, `:49`, `:147`, `:163`, `:185`, `:187-189`
- `GLOSSARY.md` (Deck Path, Native Identity, Synthesised Deck, Import Plan, Study Eligibility)
- `docs/native-anki-engine.md:8-24`, `:37`, `:66-80`, `:89-129`, `:133-139`, `:141-143`, `:145-161`
- `docs/ankiweb-account-sync.md:9`, `:13`, `:15-17`, `:19-24`, `:30`
- `docs/offline-verification.md:16`, `:18`, `:25-30`
- `docs/adr/0001-synthesised-deck-identity.md`; `docs/adr/0002-rules-own-modules.md`
- `docs/agents/office-handoff.md` (#56 design, outstanding iPhone/PC-off evidence)
- `schema-ladder.ts:1-16`; `sync-capabilities.ts`; `src/native-anki-sync.ts:45`
- `src/native-anki-{sync,media,state,projection,account,cache,writeback}.ts`
- `scripts/verify-native-anki-sync.mjs:1-40`; `scripts/verify-anki-export.py`
- `package.json` (stack: Vite, React 19, Dexie, sql.js, vite-plugin-pwa, Playwright, Wrangler)
- `Sync Server - Anki Manual.html` (local copy of the upstream manual page)

### `D:\work\Anki-Android` @ `062c0f21`
- `settings.gradle.kts:31-43` — module list; **no `:backend`**
- `gradle/libs.versions.toml:74`, `:103`, `:117`, `:188-189`, `:255-259`
- `buildSrc/src/main/kotlin/com/ichi2/anki/gradle/BackendDependencies.kt:10-26`, `:56-68`
- `buildSrc/src/main/kotlin/ankidroid.android.library.gradle.kts`, `ankidroid.jvm.library.gradle.kts`
- `libanki/build.gradle.kts:1-48`; `libanki/src/main/java/com/ichi2/anki/libanki/DB.kt:22-26`; `libanki/.../Sync.kt:22-34`
- `anki-common/build.gradle.kts:1`; `anki-common/src/main/kotlin/com/ichi2/anki/sync/SyncAuth.kt:30-43`
- `AnkiDroid/src/main/java/com/ichi2/anki/Sync.kt:52-140`
- `AnkiDroid/src/main/java/com/ichi2/anki/account/LoginViewModel.kt:107-113`
- `AnkiDroid/src/main/java/com/ichi2/anki/shareddeck/{SharedDecksActivity.kt:125, SharedDecksDownloadViewModel.kt:27-29}`
- `api/build.gradle.kts:6`, `:46-51`, `:76-81`; `api/COPYING.LESSER`
- `jitpack.yml:24-26`; `COPYING`; `LICENSES/`; `REUSE.toml`; `README.md` (License section); `AI_POLICY.md`; `CLAUDE.md`; `CONTRIBUTING.md:115-129`
- Searches with no result: `.gitmodules`, `commonMain`, `jvmMain`, `androidMain`, `iosMain`, `iosArm64`, `iosSimulatorArm64`, `xcframework`, `*.swift`, `konan`, `wasm-bindgen`, `multiplatform`, `:backend` directory

### `D:\work\ankitects\anki` @ `fe4f9e03`
- `LICENSE:1-17`; `Cargo.toml:6`, `:38-41`, `:120`
- `rslib/Cargo.toml:1-12` (`publish = false`); `rslib/README.md`; `rslib/sync/Cargo.toml:1-12`; `rslib/sync/main.rs:1-29`
- `rslib/src/sync/version.rs:10-11`, `:15-17`, `:29-32`, `:41-72`
- `rslib/src/sync/login.rs:1-60`, `:96-105`
- `rslib/src/sync/collection/protocol.rs:31-43`; `rslib/src/sync/media/protocol.rs:28-34`; `rslib/src/sync/http_client/protocol.rs`
- `rslib/src/sync/http_server/mod.rs:52-56`; `rslib/src/sync/http_server/user.rs:14-22`
- `rslib/src/storage/mod.rs:25-35`; `rslib/src/storage/upgrades/mod.rs:4-9`, `:52-59`; `rslib/src/storage/sqlite.rs:822`
- `docs/api-rust.md`; `docs/language_bridge.md`; `docs/architecture.md`; `docs/syncserver/README.md`
- `qt/aqt/qt/qt6.py:19`; `qt/aqt/webview.py:88-137`; `qt/aqt/mediasrv.py:1167`, `:1241-1248`
- `ts/vite.config.ts:29-30`, `:42-51`; `package.json` (browserslist, yarn 4.11.0, adapter-static)
- `.cargo/config.toml`; `.gitmodules`; searches with no result: `wasm32` target, `Build Library`, service worker / PWA in `ts/`+`qt/`; `git grep wasm` hits only `Cargo.lock:721`, `cargo/licenses.json:1267`, `.dprint.json:33-37`

### External primary sources
- [Anki apps listing](https://apps.ankiweb.net/) — AnkiMobile (iOS) + AnkiDroid (Android) only
- [iOS Version of Anki on GitHub — Anki forums](https://forums.ankiweb.net/t/ios-version-of-anki-on-github/51470) — "AnkiMobile is not open source"
- [AnkiDroid-Backend README](https://github.com/ankidroid/Anki-Android-Backend/blob/main/README.md) — AAR, NDK, msys2, GPL-3.0 + AGPL-3.0
- [Apple — Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account) — on-device testing requires Program membership; Personal Team 7-day expiry, 3 devices, 3 apps
- [Apple — Membership Details](https://developer.apple.com/programs/whats-included/) — 99 USD/year; Xcode Cloud 25 h/month included
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) — macOS labels; free & unlimited on public repos
- [Codemagic pricing](https://docs.codemagic.io/billing/pricing/) — 500 free macOS M2 min/month; $0.095/$0.114 per min; $3,990/yr
- [CircleCI — Configuring a macOS application](https://circleci.com/docs/guides/execution-managed/hello-world-macos) — `macos` executor, `xcode:` key
- [WebKit — Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more) — 7-day cap on script-writable storage; Home Screen web app exemption
- [WebKit — Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) — origin/overall quota, eviction, `navigator.storage.persist()`
- [WebKit — WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) — Lockdown Mode disables ServiceWorkers, Web Locks, Cache API, CacheStorage
- [Kotlin — Native target support](https://kotlinlang.org/docs/native-target-support.html) — "Building final binaries for Apple targets on Linux and Windows is also not possible"
- [Kotlin — Wasm overview](https://kotlinlang.org/docs/wasm-overview.html) / [configuration](https://kotlinlang.org/docs/wasm-configuration.html) / [roadmap](https://kotlinlang.org/docs/roadmap.html) — Beta; WebKit ≥ 18.2; "Promote Kotlin/Wasm to Stable" in focus
- [GNU AGPLv3 text](https://www.gnu.org/licenses/agpl-3.0.txt) — §13 Remote Network Interaction
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html) — "The GPL does not require you to release your modified version…"; internal use is not distribution
- [Anki Manual — Searching](https://docs.ankiweb.net/searching.html) — reference for the search language in `README.md:163`