# Handoff for the Fantasy Manager chat: live ticker + score-event API for the IPTV Multiview app

Paste this into the chat for the **Fantasy Manager** app (James's other Docker app on the same server). Context: the **IPTV Multiview** app (repo `jameshoffman7667/multiview-iptv`, a relay + browser/Android UI for IPTV) will show a fantasy ticker along the bottom of its screen and pop up the player headshot when a rostered player scores. Multiview will get all its data from Fantasy Manager (not from Sleeper directly). I need Fantasy Manager to expose a small, read-only, token-protected API. Follow the normal release rules for this app (log the request in its pending changes log, build only when James says "build", then versioning, changelog, release, and the Claude Code update prompt as usual). Do not deploy anything yourself.

## What Multiview will show (so you know what the data is for)
1. **Ticker**: scrolls across the bottom: for each league: league name coloured by how my team is doing against projection, `my team points` (green) vs `opponent points` (red), then chips for the top scoring players on each side.
2. **Pop-up** when a player scores: headshot top centre; green `+points` on the left (leagues where I own him); red `+points` on the right (leagues where my opponent owns him); below, a row per league: my total (green), league name (coloured), opponent total (red). The numbers show the **before** values first, then roll up to the **after** values. One player at a time; simultaneous scores queue. Options in Multiview: a delay (to line up with delayed streams), and a minimum points threshold.

## Please add (read-only, no writes)
Auth: `Authorization: Bearer <token>`; create a dedicated **read-only token** in the app's settings (name it "multiview"), revocable, never logged. Multiview's server calls these (the browser never sees the token). If the app already has login sessions, keep them separate: this is for service access only. All JSON, UTF-8, ISO-8601 UTC timestamps. Responses must not include any private data beyond what is listed (no emails, tokens, provider credentials).

### 1. `GET /api/ticker/summary?week=<optional>`
```json
{
  "generatedAt": "2026-11-08T18:02:11Z",
  "season": 2026, "week": 9,
  "leagues": [{
    "leagueId": "123", "name": "The Forgotten Titans", "platform": "sleeper",
    "status": "pre|live|final",
    "colour": "green|amber|red",             // league-name colour, see "Colour rule" below
    "colourBasis": { "points": 96.4, "projected": 134.6, "paceProjected": 101.2 },   // what the colour was computed from
    "mine":  { "teamId": "1", "name": "The All Days", "points": 96.4, "projected": 134.6 },
    "opp":   { "teamId": "4", "name": "Bills Mafia",  "points": 78.2, "projected": 120.1 },
    "players": [{
      "playerId": "6794", "name": "Ja'Marr Chase", "pos": "WR", "nflTeam": "CIN",
      "side": "mine|opp", "starter": true, "points": 24.3, "projected": 16.1,
      "gameStatus": "pre|live|final", "gameClock": "Q2 8:41"
    }]
  }]
}
```
- Include **starters only** in `players` (bench excluded) unless `?bench=1`.
- Polling load: Multiview polls this every 15 s during games (30-60 s otherwise); make it cheap (serve from your cache, not a live fetch to the provider per call).

### 2. `GET /api/ticker/stream` (Server-Sent Events)
Event type `score`, one per player scoring change (starters only), emitted as soon as Fantasy Manager detects it. Support `Last-Event-ID` / `?since=<eventId>` so a reconnect does not replay old events, and keep the last **10 minutes** of events so Multiview can catch up. Send a comment heartbeat every 15 s.
```json
{
  "id": "evt_000123", "detectedAt": "2026-11-08T18:02:11Z", "providerAt": "2026-11-08T18:01:40Z",
  "playerId": "6794", "name": "Ja'Marr Chase", "pos": "WR", "nflTeam": "CIN",
  "delta": 6.4, "points": 24.3,
  "reason": "TD",
  "headshot": "/api/headshot/6794",
  "leagues": [{
    "leagueId": "123", "name": "The Forgotten Titans", "side": "mine|opp",
    "mineBefore": 96.4, "mineAfter": 102.8, "oppBefore": 78.2, "oppAfter": 78.2,
    "colour": "green|amber|red"
  }]
}
```
- One event per player per change, with **all** leagues he appears in (as mine or as an opponent's starter). If he is mine in some leagues and the opponent's in others, `side` is per league.
- `delta` is the change in his league points (the same number in every league unless scoring differs: if scoring differs per league, add `deltaByLeague` or put `delta` inside each league entry; please do the latter: `leagues[].delta`).
- `detectedAt` = when Fantasy Manager noticed the change; `providerAt` = the provider's own timestamp if it has one (else null). Multiview applies its own user-set delay on top of `detectedAt`.
- Ignore stat corrections and negative changes for events (but the summary must still show the right totals). If you prefer to emit them, set `"correction": true` and Multiview will skip the pop-up.
- Merge changes that arrive within the same poll for the same player into one event.

### 3. Headshots: `GET /api/headshot/<playerId>` (token required)
Return a cutout-friendly image (PNG/JPG), cached on disk, with a placeholder silhouette for unknown players. Multiview proxies and caches it so the Android app never reaches outside. If you already store a headshot URL, proxying/redirecting is fine; tell me the source so I can note any licence/terms.

### 4. `GET /api/ticker/health` -> `{ "status": "ok", "version": "x.y.z", "lastProviderUpdate": "..." }` (also fine to reuse `/healthz`).

## Colour rule (please answer in your reply)
You already colour league names by performance vs projection in the Fantasy Manager UI. I need the **exact rule** so Multiview shows the same colours:
- thresholds and what they compare (points vs full-week projection? vs pace-adjusted projection by game progress?),
- the colour values (hex) you use,
- behaviour **before kickoff** and **after final**.
Return the colour in the API (`colour`) so the rule lives only in Fantasy Manager, and tell me the hex values so Multiview can match them (Multiview draws green `#35e07a`, amber `#ffc447`, red `#ff5a5a` in its mock-ups; tell me if yours differ).

## Questions back to James / this chat
1. Which provider leagues are included (all, or a "ticker" flag per league)? Suggest an `includeInTicker` setting per league, default on.
2. What polling cadence does Fantasy Manager use against Sleeper during games, and what is the typical delay from a real play to your detection? (This sets how well the pop-up lines up with the stream.)
3. The container's reachable address from the Multiview container (same Docker network name and port, or host IP:port), and the version that will have this API.
4. Anything in your current API that already covers this (so we reuse it instead of adding endpoints).

## Deliverable back to me
A short doc (and the app's release notes): the final endpoint list with example responses, the token setup steps, the colour rule + hex values, the address Multiview should use, and the version. Then I (the Multiview chat) will log and build the ticker (P-25) and pop-ups (P-26) against it.

## Addendum 2026-11-08 - extra fields needed for the ticker design
Starters only for both teams. Please add to each `players[]` entry in `/api/ticker/summary`: `slot` and `slotOrder` (roster slot such as QB, RB1, FLEX, and its display order), `kickoffAt` (ISO time), `gameStatus` (pre|live|final), and `statLine` (a short counting-stat string such as "12/18, 142 yds, 1 TD" or "5 rec, 61 yds, 1 TD"). Add team display names (`mine.name`, `opp.name`) and totals with projections (already listed). Colour: Multiview now colours my team name and score by vs-projection (and the opponent in white), so please return `colour` on `mine` as well as the league. Pop-ups use a 3.0-point default minimum, set in Multiview; no server-side filter needed. Negative changes need no events.
