# Machine Model

Only two machines belong to this workflow.

## MacBook

- Primary workstation.
- Default target for ambiguous phrases such as `my Mac`, `the Mac`, or `clean the computer` when the current context is this maintenance workflow.
- Expected user: `andrew`.
- Expected platform: macOS / arm64.
- Expected hostname must identify the MacBook Air.
- Optimize for constrained SSD space, interactive responsiveness, project preservation, and cheap regeneration.

## Big Mac

- Secondary heavy-lift machine.
- Never a default or inferred target.
- Every Big Mac action requires the current user request to explicitly say `Big Mac` or `bigmac`.
- Expected user: `andrew`.
- Expected platform: macOS / arm64.
- Expected hostname must identify `bigmac`.

## Cross-machine prohibition

A MacBook maintenance run cannot spill into Big Mac.
A Big Mac maintenance run cannot spill into MacBook.
Do not offload, copy, synchronize, or delete across the two machines unless the user separately requests that cross-machine operation.
