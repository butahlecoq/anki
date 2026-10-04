# Security boundaries

The sync HTTP service accepts JSON pairing, sync, and restore requests up to 32 MiB. It rejects a larger declared `Content-Length` before parsing and also counts streamed bytes, so chunked requests cannot grow the in-memory JSON buffer past the same limit. Media uploads use a separate streamed 20 MiB cap and are stored only after MIME validation, digest verification, and authorization. Sync, media, device-management, and backup routes require an active paired-device token; pairing and health are the intentional unauthenticated entry points.

Anki package import validates ZIP paths, duplicate names, entry count, declared and extracted sizes, checksums, compression formats, and nested Zstandard windows before parsing collection data. It caps packages at 128 MiB compressed, 256 MiB expanded, 64 MiB per entry/window, and 20,000 entries/frames. Encrypted, split, and ZIP64 archives are rejected. Content-addressed media names prevent archive filenames from becoming filesystem paths.

This request-body limit is a resource bound, not a substitute for the bounded, resumable sync batches tracked in #19. A large local outbox can still need batching before it can fit this transport limit.

Imported card fields and templates are sanitized before rendering. Card previews render in an iframe with `sandbox="allow-same-origin"` and a `default-src 'none'` policy; scripts and active external resources are not allowed. Do not add `allow-scripts` to that iframe without a separately reviewed isolation design.

Server credentials are stored as hashes and are never returned by device-list commands. Client-held paired credentials are stored in the browser collection database so they remain available offline. Import failures are surfaced to the user without logging raw parser exceptions; credentials and collection payloads must not be written to logs.
