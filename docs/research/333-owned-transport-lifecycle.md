# Owned transport lifecycle control

[Issue #333](https://github.com/butahlecoq/anki/issues/333) records hosted run 38095784420 at `5d236ce224d263411b3f1bd64288edc576e4f0c4`: the original native transport diagnostic case timed out at its unchanged 30000ms deadline, then retry1 passed. The first hosted trace was not uploaded. Its exact pending action and historical cause remain unknown.

The unchanged complete journey on main `bbab1a58c3ab9c36419aac61e89227e6537059b4` passed six Windows comparisons, three per engine, one worker, zero retries, 29.8s. This bounds recurrence without establishing a cause. Source, log, head and traces are retained in `runtime/333-main-comparison*`.

## Reproduced boundary

A real accepted TCP connection that sends no HTTP request prevents the original `server.close()` callback from completing. The isolated control failed on both engines at the default 5000ms assertion deadline; it destroyed only its own client in cleanup. First source and artifacts are retained in `runtime/333-lifecycle-red*`.

Ranked explanations were: owned server shutdown waiting for an unused connection; browser request-failure event timing; host contention. Only the first has a reproduced mechanism. Introducing the same owned unused connection immediately before shutdown in the **complete original transport journey** then reproduced its 30000ms timeout on both engines. Healthy-document and HTTP-404 observations completed; refused-network observations were never reached. Source, logs and first traces are retained in `runtime/333-whole-lifecycle-red*`.

This proves the controlled shutdown defect, not that the unavailable historical trace had this cause.

## Correction and retained observations

The shared test-only `closeOwnedHttpServer` first stops accepting connections, then releases only that fixture server's connections with `closeAllConnections`, and awaits the original close callback. Deck restoration already used that connection-release operation; its existing regression and journeys now consume the same helper.

The original full transport journey remains one case. A second runs every same healthy/HTTP/refused-network assertion and diagnostic attachment with an accepted unused connection. Both retain the original case deadline and configured retries. No application responses, collections or browser events are mocked; no branch is skipped or expected failure accepted.

Focused verification passed 18 cases in 37.4s: three repeats per engine of both complete transport variants and the existing unused-TCP restoration regression, one worker, zero retries. Original comparison and all red artifacts remain separate. Full final local/hosted gates and independent Standards/Spec reviews are still required; this focused result does not close #333.
