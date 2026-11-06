# Server reply: BB-118 "Running since" on the System Admin Dashboard

**For:** bizbuddy-v2-client-web (System Admin Dashboard)
**Server:** no change needed. The data is already in the health endpoint.

## The idea
Show when the live server started and which commit it's running, so system admins can see what's deployed without opening Render. It's for reference only.

Check first whether the dashboard's Live Server page already shows any of these fields.

## Endpoint
`GET /api/system-admin/server/health`

Uses the existing system admin session, like the other system-admin calls. Not cached, so it always returns current values.

```json
{
  "success": true,
  "data": {
    "instance": { "commit": "688ce14", "branch": "master" },
    "process":  { "startedAt": "2026-11-06T02:15:00.000Z" }
  }
}
```

Only the fields for this label are shown. The response has more.

| Field | Type | Notes |
|---|---|---|
| `data.process.startedAt` | ISO date (UTC) | When the server last started |
| `data.instance.commit` | string or `null` | Short commit id. `null` when not running on Render |
| `data.instance.branch` | string or `null` | Deployed branch. `null` when not running on Render |

## Suggested UI
> **Running since** Nov 6, 2026, 10:15 AM · commit 688ce14 (master)

- Show the date in the viewer's local time.
- When `commit` or `branch` is `null`, leave that part out, e.g. **Running since** Nov 6, 2026, 10:15 AM.
- If the health call fails, hide the label. It's only for reference, so don't show an error for it.
- Put it on a page that already calls `/server/health` if there is one, so it needs no extra request.

## Wording
Use **Running since**, not "Deployed on". Each deploy starts a new server, so the date is usually the deploy time, but a crash or manual restart also resets it. The commit shows whether the code actually changed.

## Security
Keep this inside the System Admin Dashboard. Don't show it on public pages or in the company panel.
