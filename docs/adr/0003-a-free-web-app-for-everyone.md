# The app is a free web app that anyone can run

Kiroku is source code that a learner obtains and runs on their own machine. They
also run the PC service that relays their account traffic; no service is operated
on their behalf. Using Kiroku costs its learners nothing. No one buys an Apple
Developer membership or a paid hosting plan, and no learner's collection or
credentials pass through infrastructure we operate. Each learner connects with
their own AnkiWeb account. Account relay topology is recorded in ADR 0004.

## Context

The owner asked why we could not build the iPhone app on top of the two upstream
Anki repositories. The research in `docs/research/why-not-reuse-upstream-anki-clients.md`
answered that: AnkiDroid is not a Kotlin Multiplatform project and its engine is an
Android AAR wrapping Rust, `ankitects/anki` ships no WebAssembly build and no public
embedding interface, and AnkiMobile is closed source. That question is settled.

The live constraint is money, and it is recurring. That reframing matters, because
the earlier framing invited an easy objection.

**"No Mac" was never the barrier.** A native iOS app can be built without owning a
Mac: hosted macOS runners are free on public repositories, and Codemagic and CircleCI
sell macOS minutes. What cannot be avoided is Apple. On-device testing and
distribution require Apple Developer Program membership at $99/year, and free
provisioning allows 3 devices and 3 apps with profiles that expire after 7 days. A
$99 recurring fee is the price of admission, and it is a fee, not a one-off setup
cost.

The owner's answer was unambiguous: kiroku must be completely free to use, now and in
future, and if it is later shared publicly every user brings their own AnkiWeb
account.

## Considered options

**Build a native iOS app with the Rust engine.** Rejected on cost, before any
engineering question. Reuse is not available in any case - AnkiDroid's engine is an
Android AAR and `rslib` has no mobile target or public interface - so this would be a
rewrite paid for at $99/year.

**Build a native wrapper around the existing PWA, using a WKWebView shell.**
Technically sound, and it genuinely buys two things we cannot get from Safari:
app-private storage that Safari's eviction cannot reach, and real push. Rejected on
the same cost basis. This option stays on the table only if the owner's constraint
ever changes, and revisiting it means reopening the fee question rather than just
the code.

**Ship a free web app, and let each learner run their own account and gateway** -
chosen.

## Consequences

- **We operate no shared gateway.** This is the direct cost of "everyone uses their
  own AnkiWeb account". A shared gateway would sit between a stranger's browser and
  their AnkiWeb credentials, which contradicts the privacy promise in `README.md`
  and would make us the party holding other people's account traffic. Under ADR 0004,
  each learner's PC service runs the relay and the learner reaches it over their
  private network. A separate always-on hosted gateway is not part of the supported
  topology. A shared gateway is not a feature we may add later without reopening
  this decision.
- **The PC relay is a pass-through.** It accepts account requests only from the
  configured app origin and an authenticated paired device, forwards supported
  protocol traffic to AnkiWeb, and does not store or log account traffic. Only the
  learner's paired devices use this relay.
- **Money is a permanent engineering constraint, not a launch-phase one.** Every
  future proposal has a cost line, and a proposal whose running cost is non-zero is
  out of scope. This is the reason the free tier of every dependency is a hard
  requirement rather than a preference, and the reason reaching a free tier limit
  must fail loudly instead of suggesting a paid upgrade.
- **We inherit the platform's storage limits, and they are our worst product risk.**
  Safari can evict a whole origin, least recently used, and our multi-year review log
  is a single-origin store. "Add to Home Screen" exempts the app from the seven-day
  script-writable storage cap, but it does not exempt it from eviction. See #21, and
  call `navigator.storage.persist()`.
- **Lockdown Mode removes our offline shell and our session serialisation.** It
  disables Service Workers and Web Locks, and we depend on both. The app must detect
  the absence and tell the learner rather than failing quietly. See #149.
- **There is no forced upgrade path.** With no store listing, no store review and no
  forced update, old builds stay installed indefinitely. Every future schema or
  protocol change must assume it will meet clients that are months behind, which
  raises the value of the version tripwire in #150 and of the Schema Ladder's
  declared minimums.
- **Distribution is source-based.** The earlier statement that distribution is a
  URL described an app that was not hosted. A URL alone cannot give a learner the
  application: they obtain the source and run the app and relay on their own
  machine. There is no listing, install count, or review gate.
- **Push is best-effort only.** Daily review is unaffected, because the learner opens
  the app. Due-count badges are not, and we do not claim them.
- **The offline-first promise is conditional.** It holds for an installed Home Screen
  app on an ordinary iOS configuration. It does not hold under Lockdown Mode, and the
  physical iPhone evidence in `docs/offline-verification.md` is still outstanding.

## Revisiting this

Reopen this decision if the owner changes the requirement that Kiroku and its
required services cost nothing to operate, or decides that the learner must use a
hosted service rather than run the app and relay themselves. An Apple Developer
membership becoming available is not by itself enough; decide explicitly whether
native storage and real push justify the recurring fee for a private
single-learner tool. Do not reopen this ADR to add a paid dependency while the
no-cost requirement remains in force.
