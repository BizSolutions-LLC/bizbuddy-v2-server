# BB-114 — Questions for the mobile developer

We're improving server speed (BB-114). A few endpoints get called far more often than their data changes. Before we change anything that affects the app, we'd like to know how the app uses them. Please answer briefly: short answers or "don't know" are fine.

Thanks for the `/contest-policy/my-requests` path fix. We expect that 404 to disappear from the error list.

## 1. `GET /api/account/profile`
In the last 30 days it was the 2nd most-called endpoint (18,892 calls) and the most expensive overall.
1. When does the app call it? Tick all that apply: app start / sign-in / every screen open / app returning from background / pull-to-refresh / on a timer / other: ___
2. If it's on a timer, how often?
3. Which fields does the app actually read from the response (`user`, `profile`, `company`, `subscription`, and which fields inside each)?
4. Could the app fetch it once per session and refresh only after the user edits their profile, or on pull-to-refresh? Is anything stopping that?
5. Does the app cache the response locally (for example AsyncStorage or another local store)?

## 2. `GET /api/notifications` and `GET /api/notifications/unread-count`
Most-called endpoint (33,614 calls) plus the unread count (623).
1. How often does the app poll these, and on which screens?
2. Does polling continue while the app is in the background?
3. Does the app listen for the socket events the server already sends, or only push notifications? Could a socket event or push replace the polling?

## 3. `PUT /api/presence`
16,293 calls.
1. When and how often does the app send it (heartbeat interval, app state changes)?
2. Is it sent while in the background?

## 4. `GET /api/company-setup/checklist`
1. Does the mobile app show the setup guide, or call this endpoint at all?

## 5. Lists: `GET /api/leaves`, `GET /api/timelogs`, `GET /api/cutoff-periods/:id/approvals`
1. Does the app load any of these? If yes, on which screens, and with what `limit` / page size?
2. Does it re-load them on a timer or only on screen open / pull-to-refresh?

## 6. Anything else
1. Which other endpoints does the app call on a timer, and at what intervals?
2. Is there anything slow in the app you'd like us to look at on the server side?

## Planned server changes (no app change needed)
Server-only changes are planned for late November 2026. Responses stay **exactly the same**, so no app update is needed:
- the database connection setup
- a short cache on the setup checklist
- fewer queries on `/timelogs` and `/leaves`

We'll let you know when they're live in case you notice anything different.
