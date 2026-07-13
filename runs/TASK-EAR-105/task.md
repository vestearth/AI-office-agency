# TASK-EAR-105: Integrate Coupon into Website and Mobile checkout

Parent `TASK-EAR-101`; blocked by `TASK-EAR-103`. Feature/general/high; `dev-2`.

Integrate the authenticated public coupon validate/apply contract into the actual Website and Mobile checkout owners identified during execution. Display authoritative server preview, send coupon through canonical order creation, handle every stable business error, and show applied coupon/discount/reward in order history. Do not call Admin APIs or calculate authoritative discounts client-side.

Scope must be narrowed to the current client repositories before edits; if a Website/Mobile client repo is absent, deliver verified API contract examples and record that external client implementation is waiting for its owner. No unrelated UI redesign.

Acceptance: valid and invalid flows; authoritative preview; duplicate submit/payment retry/failure recovery; successful order/history display; staging API smoke through gateway; client tests/build; permission separation verified.

