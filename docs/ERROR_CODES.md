# Error Codes

App-level error codes returned alongside `message` in error responses:
```json
{ "message": "Human-readable explanation for logs/toasts", "code": "SOME_ERROR_CODE" }
```
HTTP status still carries the primary meaning (`409`, `400`, ...). `code` lets client code branch on the *specific* reason without parsing `message` text — which can reword, get localized, etc. without warning.

**Not retrofitted across the whole app.** Seeded from the Leave module redo (see `docs/UPDATED_LEAVE_MODULE.md`). Meant to grow as new or touched error responses adopt this pattern — an endpoint *without* a `code` field simply hasn't been touched yet, it isn't itself meaningful.

Defined in `src/constants/errorCodes.js` (aliased as `@constants`).

## Registry

| Code | HTTP Status | Meaning | Where |
|---|---|---|---|
| `LEAVE_POLICY_IN_USE` | 409 | Attempted to delete a Leave Type that still has `Leave`/`LeaveBalance`/`LeaveTransaction`/`LeavePolicyAssignment` rows referencing it. | `DELETE /api/leave-policies/:id` |

## Convention for adding a new code

1. Add the constant to `src/constants/errorCodes.js`.
2. Return it alongside `message`: `res.status(409).json({ message: "...", code: ERROR_CODES.YOUR_CODE })`.
3. Add a row to the table above.
4. Use a human-readable `SCREAMING_SNAKE_CASE` string, not an opaque number — self-documenting beats needing a lookup table to remember what a number meant.
5. Make the `message` accurate to the specific failure, not a generic catch-all covering every possible cause — see `deletePolicy` in `leavePolicyController.js` for the pattern (counts what's actually blocking the action and names it).
