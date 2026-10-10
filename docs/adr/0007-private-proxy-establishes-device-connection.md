# The authenticated private proxy establishes the device connection

The owner requested automatic PC connection without an address or code in #327. The existing private app and PC service share a Tailscale Serve HTTPS origin. Requiring the learner to copy that origin and generate a pairing code duplicates authentication already performed by the private network.

The explicitly configured Tailscale owner's proxy identity may establish the existing opaque device credential. The app discovers and connects its PC at its own origin; opening AnkiWeb still presents the account username and password. Connection itself never exchanges collection data, resets local work, or persists account passwords.

This authorization requires a loopback backend, an exact configured owner login, and the exact app Origin on credential issuance. Same-origin capability GET may omit Origin. [Tailscale Serve supplies authenticated identity and strips spoofed headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers); arbitrary tailnet members and Funnel are not authorized by this decision. The configuration is default-disabled and must not be enabled behind an untrusted identity-forwarding proxy. The local PC is trusted to operate its own service.

Subsequent sync and relay requests retain normal revocable device-token authentication. Revoking a lost device's token removes that token's access; its private-network access must also be revoked to prevent a new authenticated owner connection. Separately hosted deployments retain explicit advanced manual pairing. Private connection errors offer retry without falling back to a code/address form.

This refines how ADR 0004's PC connection is established. The learner-owned PC remains the relay; no shared service or ongoing hosting cost is introduced. A generated code, QR scan, or second-device approval would preserve redundant setup in the supported private flow, so those alternatives were rejected.
