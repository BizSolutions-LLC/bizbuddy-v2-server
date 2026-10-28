# Error Codes

App-level error codes returned alongside `message` in error responses:
```json
{ "message": "Human-readable explanation for logs/toasts", "code": "SOME_ERROR_CODE" }
```
HTTP status still carries the primary meaning (`409`, `400`, ...). `code` lets client code branch on the *specific* reason without parsing `message` text — which can reword, get localized, etc. without warning.

**Not retrofitted across the whole app.** Seeded from the Leave module redo (see `docs/LEAVE_MODULE.md`). Meant to grow as new or touched error responses adopt this pattern — an endpoint *without* a `code` field simply hasn't been touched yet, it isn't itself meaningful.

Defined in `src/constants/errorCodes.js` (aliased as `@constants`).

## Registry

| Code | HTTP Status | Meaning | Where |
|---|---|---|---|
| `LEAVE_POLICY_IN_USE` | 409 | Attempted to delete a Leave Type that still has `Leave`/`LeaveBalance`/`LeaveTransaction`/`LeavePolicyAssignment` rows referencing it. | `DELETE /api/leave-policies/:id` |
| `SYSTEM_AGENT_NOT_ALLOWED` | 403 | The B. Buddy account (BB-110) tried an employee-panel / self-service action (clock in, own leave/OT/punch requests, own profile/password, account deletion). | `blockSystemAgent` middleware on self-service routes |
| `SYSTEM_AGENT_PROTECTED` | 403 | A company admin tried to edit, delete or change the password of the B. Buddy account. | Employee / employment-detail write endpoints |
| `AGENT_IDENTITY_REQUIRED` | 401 | Sign-in matched the B. Buddy account but no `agentCode` + `agentPin` were sent — client should prompt and resubmit. | `POST /api/account/login` |
| `AGENT_IDENTITY_INVALID` | 401 | Staff code/PIN wrong, or the support agent is inactive or removed (archived). | `POST /api/account/login` |
| `AGENT_NOT_ASSIGNED` | 403 | Staff code/PIN valid, but the chosen company isn't the one company that support agent is assigned to. | `POST /api/account/login` |
| `AGENT_LOCKED` | 429 | Staff code locked for 15 minutes after 5 wrong PINs in a row. Response includes `lockedUntil`. A PIN reset from the dashboard unlocks it. | `POST /api/account/login` |
| `INVALID_CREDENTIALS` | 401 | System-admin username/password wrong (or current password wrong on change). | `POST /api/system-admin/auth/login`, `PUT /api/system-admin/auth/password` |
| `MFA_INVALID_CODE` | 401 | Authenticator or recovery code wrong, expired or already used. | `/api/system-admin/auth/2fa/*` |
| `MFA_TOKEN_INVALID` | 401 | The 5-minute sign-in step expired or was invalidated — go back to the password step. | `/api/system-admin/auth/2fa/*` |
| `ADMIN_LOCKED` | 429 | 5 failed passwords/codes in a row — admin locked 15 minutes (`lockedUntil` in body). An owner can unlock by resetting their password. | System-admin sign-in |

## Convention for adding a new code

1. Add the constant to `src/constants/errorCodes.js`.
2. Return it alongside `message`: `res.status(409).json({ message: "...", code: ERROR_CODES.YOUR_CODE })`.
3. Add a row to the table above.
4. Use a human-readable `SCREAMING_SNAKE_CASE` string, not an opaque number — self-documenting beats needing a lookup table to remember what a number meant.
5. Make the `message` accurate to the specific failure, not a generic catch-all covering every possible cause — see `deletePolicy` in `leavePolicyController.js` for the pattern (counts what's actually blocking the action and names it).
