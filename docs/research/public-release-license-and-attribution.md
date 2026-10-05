# Public release: licence and attribution research

Checked 2026-10-05 against the current repository, its production build, and
first-party publisher/project sources. This records published statements and
observations; it does not decide whether Kiroku may be released.

## Release status

**Unresolved: the Ankipack MIT declaration conflicts with Anki AGPL headers in
generated code that is included in the production bundle.** Ankipack 0.3.1's
package metadata declares MIT, its root `LICENSE` is MIT, and its source
repository's `proto/LICENSE` says the generated code and package are MIT. The
same generated Anki protobuf files carry headers saying “GNU AGPL, version 3 or
later.” The app imports Ankipack and `npm run build` emits its generated Anki
protocol descriptors in `dist/assets/dist-CZDCTIto.js`; the minified output
does not retain those source headers. This report does not resolve the conflict
or state a legal conclusion. A release decision about this component needs
clarification from the relevant maintainers or another documented basis.

There is a second release question: the currently published AnkiWeb terms say
that access from third-party clients is not currently allowed, while the terms
only name Anki, AnkiMobile, AnkiDroid, and AnkiUniversal as approved clients.
Kiroku is not named. The published terms page says it was last updated
2018-10-17, so current permission/status should be confirmed before enabling a
public account-sync release. No account was accessed for this research.

## What the current build contains

The package lock resolves the following production dependencies. The license
labels below are those published in the exact installed package metadata or
license files; they are not a conclusion about the combined app.

| Component | Resolved version | Published licence / attribution |
| --- | ---: | --- |
| Ankipack | 0.3.1 | [npm version metadata](https://www.npmjs.com/package/ankipack/v/0.3.1) says MIT; its [root LICENSE](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/LICENSE) is MIT; see unresolved generated-code conflict above |
| `@bufbuild/protobuf` | 2.16.0 | [npm version metadata](https://www.npmjs.com/package/@bufbuild/protobuf/v/2.16.0) says `(Apache-2.0 AND BSD-3-Clause)` |
| `fflate` | 0.8.3 | [npm version metadata](https://www.npmjs.com/package/fflate/v/0.8.3) says MIT |
| `fzstd` | 0.1.1 | [npm version metadata](https://www.npmjs.com/package/fzstd/v/0.1.1) says MIT |
| Dexie | 4.4.6 | [npm version metadata](https://www.npmjs.com/package/dexie/v/4.4.6) says Apache-2.0 |
| `dexie-react-hooks` | 4.4.0 | [npm version metadata](https://www.npmjs.com/package/dexie-react-hooks/v/4.4.0) says Apache-2.0 |
| React | 19.3.0 | [npm version metadata](https://www.npmjs.com/package/react/v/19.3.0) says MIT |
| React DOM | 19.3.0 | [npm version metadata](https://www.npmjs.com/package/react-dom/v/19.3.0) says MIT; depends on [`scheduler` 0.28.0](https://www.npmjs.com/package/scheduler/v/0.28.0), also MIT |
| `ts-fsrs` | 5.4.2 | [npm version metadata](https://www.npmjs.com/package/ts-fsrs/v/5.4.2) says MIT; [LICENSE](https://github.com/open-spaced-repetition/ts-fsrs/blob/v5.4.2/LICENSE) |
| `sql.js` | 1.12.0 | [npm version metadata](https://www.npmjs.com/package/sql.js/v/1.12.0) says MIT; its [v1.12.0 README](https://github.com/sql-js/sql.js/blob/v1.12.0/README.md) identifies SQLite as public domain and sql.js as MIT |
| JetBrains Mono variable font | 5.3.0 | [npm version metadata](https://www.npmjs.com/package/@fontsource-variable/jetbrains-mono/v/5.3.0) says OFL-1.1; the exact package's `LICENSE` identifies JetBrains Mono Project Authors |
| Workbox generated service worker/runtime | 7.4.1 | [workbox-build](https://www.npmjs.com/package/workbox-build/v/7.4.1), [workbox-core](https://www.npmjs.com/package/workbox-core/v/7.4.1), [workbox-precaching](https://www.npmjs.com/package/workbox-precaching/v/7.4.1), and [workbox-window](https://www.npmjs.com/package/workbox-window/v/7.4.1) package metadata say MIT; Google LLC copyright notice appears in the distributed Workbox bundle |

Build inspection found SQL.js WASM, JetBrains Mono WOFF2 files, a Workbox
runtime chunk and service-worker script, plus Ankipack-derived protocol
descriptors in the production `dist` output. Therefore this is not merely a
private source dependency inventory: those assets are emitted for distribution
by the build. Relevant license texts specify inclusion of copyright/license
notices when copies or substantial portions are distributed. For example,
[MIT text](https://opensource.org/license/mit) requires the copyright and
permission notice in copies or substantial portions;
[Apache-2.0 §4](https://www.apache.org/licenses/LICENSE-2.0) specifies its
redistribution conditions; and the
[SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-text/)
specifies its notice and font-redistribution terms. SQLite describes its code
as public domain in its [official licensing page](https://www.sqlite.org/copyright.html).

The application repository has no root `LICENSE` and no third-party notices
file at the checked head. The [project package metadata](https://github.com/butahlecoq/anki/blob/f3b425a5b2cdf6ae5bcfd599dbae827cc993d9be/package.json)
marks the package `private`, which is
an npm publication setting and does not itself state a project-wide licence.
The available source does not establish an app-wide licence or a project-wide
copyright grant. Do not infer either from the package setting or README.

## Ankipack and Anki source record

The relevant primary sources disagree:

* [Ankipack v0.3.1 package metadata](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/package.json)
  declares `MIT`; the distributed [root LICENSE](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/LICENSE)
  contains MIT text.
* [Ankipack v0.3.1 proto/LICENSE](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/proto/LICENSE)
  says the `.proto` files came from Anki and are AGPL-3.0-or-later, but says
  the generated code and package are distributed under MIT.
* Exact generated source files, including
  [`collection_pb.ts`](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/src/generated/anki/collection_pb.ts)
  and [`sync_pb.ts`](https://github.com/ImGajeed76/ankipack/blob/v0.3.1/src/generated/anki/sync_pb.ts),
  instead include headers identifying Ankitects Pty Ltd and contributors and
  GNU AGPL v3 or later. The exact installed files under `node_modules/ankipack/dist/generated/anki/`
  carry these headers as well.
* The current production bundle includes descriptors generated from
  `cards`, `collection`, `deck_config`, `decks`, `generic`, `import_export`,
  `notes`, `notetypes`, and `sync` protobuf files. The generated source headers
  are not present in the minified bundle.

The app's own [Ankipack import](https://github.com/butahlecoq/anki/blob/f3b425a5b2cdf6ae5bcfd599dbae827cc993d9be/src/anki-import.ts)
and build output establish that this code is bundled. The official Anki
protocol source at [tag 26.09.3](https://github.com/ankitects/anki/tree/26.09.3/proto)
is useful provenance, but does not settle the conflicting Ankipack statements.
The existing app has no notice that resolves or reproduces this particular
attribution/license conflict. Whether either published notice is sufficient
for a public release remains unknown.

The sync engine itself is implemented in this repository's TypeScript
([`src/native-anki-sync.ts`](https://github.com/butahlecoq/anki/blob/f3b425a5b2cdf6ae5bcfd599dbae827cc993d9be/src/native-anki-sync.ts));
the repository history records its implementation beginning at
[76fa434](https://github.com/butahlecoq/anki/commit/76fa434), followed by
[6cb50e4](https://github.com/butahlecoq/anki/commit/6cb50e4) and
[f116ad6](https://github.com/butahlecoq/anki/commit/f116ad6). It is not the upstream
Rust sync engine. Protocol/schema compatibility work references official
Anki source, including tagged
[collection metadata](https://github.com/ankitects/anki/blob/26.09.3/rslib/src/sync/collection/meta.rs),
[media protocol](https://github.com/ankitects/anki/blob/26.09.3/rslib/src/sync/media/protocol.rs),
and [protocol schemas](https://github.com/ankitects/anki/tree/26.09.3/proto).
This distinction does not answer the status of the separately bundled
Ankipack-generated descriptors above.

## AnkiWeb, stored data, and relaying

The first-party [AnkiWeb terms](https://ankiweb.net/account/terms) describe
AnkiWeb access through its browser interface or sync in named approved clients,
and state that access from browser extensions or other third-party clients is
not currently allowed. The page itself reports last updated 2018-10-17. The
terms also say that uploading a shared deck grants Anki a worldwide,
royalty-free, non-exclusive licence under the Shared Deck Licence, while
downloaded shared decks are for personal study and may not be redistributed
without the copyright holder's express permission. See the terms before using
shared-deck content in a public fixture or demonstration.

The [AnkiWeb privacy notice](https://ankiweb.net/account/privacy) says synced
card data, media, and review history are stored on AnkiWeb; it describes these
as private by default and also describes support access and server request
logs. The official [sync manual](https://docs.ankiweb.net/syncing.html)
likewise says AnkiWeb stores collection/media data. This concerns AnkiWeb; it
does not establish the retention policy for this project's hosting environment.

The app's [gateway handler](https://github.com/butahlecoq/anki/blob/main/server/ankiweb-gateway.ts)
forwards a limited set of sync requests to AnkiWeb and does not intentionally
persist request or response contents in that handler. The handler code does not
establish behavior of hosting-platform logs, reverse proxies, operating systems,
or network intermediaries; those configurations were not inspected. The relay
does not change the AnkiWeb storage described by Anki's privacy notice.

The sources establish no blanket release permission for this third-party
client. They also do not clearly answer whether a personally operated/private
build is treated differently under the current terms. That distinction remains
unresolved; do not describe private use or public release as approved based on
these sources.

## Recommendation and open points

Use synthetic, locally generated packages for committed compatibility fixtures,
with no copied user/shared-deck content, personal data, account credentials,
or upstream binary package fixtures. Keep generation deterministic and record
the generator and source provenance. This avoids introducing user-authored or
shared-deck material whose redistribution rights are unknown. It does not
resolve the licensing status of Ankipack-generated descriptors used by the
generator or app; keep that question explicit. Generate any larger compatibility
packages on demand until the package content, generator provenance, and
redistribution basis have been reviewed. No package fixtures were acquired or
committed for this research.

Before public release, the following remain open:

1. Resolve the conflicting Ankipack MIT declaration and AGPL headers for the
   generated protocol code included in the bundle, with a documented upstream
   clarification or a different implementation/dependency choice.
2. Confirm current authorization/status for a third-party client to use
   AnkiWeb sync; the published terms are dated 2018.
3. Establish the intended Kiroku project licence and copyright notice.
4. Prepare and verify distribution notices for the exact shipped dependency
   assets and their required notices once the release contents are fixed.
5. Document production hosting/log retention and any applicable handling of
   synced user data; the local gateway code cannot answer that question.

These are research findings and deferrals, not legal advice or legal
conclusions.
