# The app is a free web app that anyone can run

kiroku ships as a web app added to the iPhone Home Screen, and using it costs its
learners nothing, forever. No one buys an Apple Developer membership, no one buys a
paid hosting plan on our behalf, and no learner's collection or credentials pass
through infrastructure we operate. Each learner runs the app and the gateway they
need on a free tier, and connects with their own AnkiWeb account.

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
  and would make us the party holding other people's account traffic. Each learner
  deploys their own gateway on a free tier instead, following
  `docs/ankiweb-account-sync.md`. A shared gateway is not a feature we may add later
  without reopening this decision.
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
- **Distribution is a URL.** Anyone can obtain kiroku and connect their own account.
  There is no listing, no install count and no review gate. This is the point.
- **Push is best-effort only.** Daily review is unaffected, because the learner opens
  the app. Due-count badges are not, and we do not claim them.
- **The offline-first promise is conditional.** It holds for an installed Home Screen
  app on an ordinary iOS configuration. It does not hold under Lockdown Mode, and the
  physical iPhone evidence in `docs/offline-verification.md` is still outstanding.

## Revisiting this

The fee is the whole decision. If an Apple Developer membership ever becomes
available to the owner, the question to reopen is not "can we ship native" - the
answer is yes - but "is native storage and real push worth a recurring fee for a
private single-learner tool". Answer that question on its merits, not as a
reflex. Do not reopen this ADR to add a paid dependency.