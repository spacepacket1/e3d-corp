- Blocking: `runRiskAssess` trusts the supplied event after merely matching its ID in the log. A caller can alter payload/correlation fields while retaining a stored ID, producing an ungrounded proposal. Resolve and use the canonical stored record, or require an exact match.
- Add the required direct helper/schema edge-case tests.
- Remove nonportable run artifacts; the diff also exceeds the stated 900-line scope.

---VERDICT---
status: blocked
reason: Risk proposals can be created from tampered request data that does not match the stored event.
