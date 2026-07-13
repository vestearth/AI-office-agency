# TASK-EAR-102: Publish approved Coupon shared contracts

Parent `TASK-EAR-101`; feature/backend/high; `dev-2`; shared-lib only.

Add only approved Admin coupon gaps and authenticated public validate/apply/purchase fields to the owning proto(s), including stable business errors and response preview. Generate Go/gRPC/gateway/Swagger artifacts and publish before any Order, gateway or client bump. Backward compatible; no local replace.

Acceptance: approved Discount status/cap and coupon usage fields represented; canonical purchase accepts coupon without exposing Admin APIs; generated artifacts current; tests/build pass; published version recorded for TASK-EAR-103-105.

