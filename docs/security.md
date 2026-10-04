# Security boundaries

The sync HTTP service accepts JSON pairing and synchronization requests up to 32 MiB. It rejects a larger declared `Content-Length` before parsing and also counts streamed bytes, so chunked requests cannot grow the in-memory JSON buffer past the same limit. Media uploads use a separate 20 MiB limit and are stored only after digest verification.

This request-body limit is a resource bound, not a substitute for the bounded, resumable sync batches tracked in #19. A large local outbox can still need batching before it can fit this transport limit.

Imported card templates render in a sandboxed iframe without script permission. Do not add `allow-scripts` to that iframe without a separately reviewed isolation design.
