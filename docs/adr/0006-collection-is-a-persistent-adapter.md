# Collection remains a persistent adapter

## Status

Accepted

## Context

`Collection` owns the browser's durable local data. Its operations depend on IndexedDB transactions, schema upgrades, cross-tab coordination, and persistence behavior. Replacing it with an in-memory implementation in ordinary feature tests would claim a storage substitution guarantee the product does not provide, while making important storage failures and transaction boundaries invisible.

At the same time, allowing every feature and test to use Dexie's tables and lifecycle surface couples callers to the storage library and makes storage behavior impossible to change behind the Collection boundary.

## Decision

`Collection` is the application-facing persistent adapter. It remains backed by Dexie and IndexedDB; it does not promise an in-memory implementation. Callers use named collection operations and read-only projections. Dexie tables, transactions, and database lifecycle controls stay inside the adapter and narrowly scoped storage infrastructure.

Rules and projections that do not require persistence remain ordinary pure functions and can be tested without building an IndexedDB schema for every assertion. Tests that exercise Collection behavior use isolated IndexedDB databases through the public collection factory and lifecycle support.

## Consequences

- Tests cannot seed application state by reaching into Dexie tables. They use meaningful Collection operations or dedicated import flows.
- Tests of pure rules and projections do not need a fake Collection implementation.
- IndexedDB transaction and upgrade behavior remains covered against the real adapter.
- A future storage replacement requires an explicit product and architecture decision rather than assuming in-memory substitutability.
