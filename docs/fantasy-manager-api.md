# Fantasy Manager -> IPTV Multiview: ticker API (v4.17.0)

Answers to the Multiview handoff. Read-only, token-protected, JSON/UTF-8, ISO-8601 UTC. Nothing here writes to Sleeper.

## Address and version
- Version with the API: **4.17.0** (confirm with `GET /api/ticker/health`, which returns the running version).
- Multiview's server calls `http://<Fantasy Manager host LAN IP>:<CLIENT_PORT>` (the client container's published port, default 5000; ask Claude Code on the server for the exact value). nginx there forwards `/api/` to the server container, and the stream route is un-buffered. The server container's own port 4000 is not published. **No compose or .env change is needed**, so Multiview does not have to join the Fantasy Manager Docker network.
- Do not use the public hostname: it may sit behind Cloudflare Access.

## Token setup (owner only)
1. Sign in to Fantasy Manager as the owner -> Account -> **Multiview access** -> **Create token**. It is shown once; copy it.
2. Put it in Multiview's server settings. Send `Authorization: Bearer <token>` on every call.
3. **Rotate** makes a new token and kills the old one; **Revoke** turns the API off. Only a hash is stored; the token is never logged. The token only works on the four endpoints below (not on the rest of the app).
Responses carry no emails, tokens or provider credentials.

## Endpoints
### GET /api/ticker/summary?week=&bench=1
Served from a cache (rebuilt at most every 15 s during games, every 60 s otherwise), so polling every 15 s is cheap. Only leagues with Game Day "include" on appear.
```json
{ "generatedAt": "2026-11-08T18:02:11Z", "season": 2026, "week": 9,
  "leagues": [{
    "leagueId": "123", "name": "The Forgotten Titans", "platform": "sleeper",
    "status": "pre|live|final",
    "colour": "green|amber|red",
    "colourBasis": { "points": 96.4, "projected": 134.6, "oppPoints": 78.2, "oppProjected": 120.1, "remaining": 80.0, "threshold": 4.0 },
    "mine": { "teamId": "1", "name": "The All Days", "points": 96.4, "projected": 134.6 },
    "opp":  { "teamId": "4", "name": "Bills Mafia",  "points": 78.2, "projected": 120.1 },
    "players": [{ "playerId": "6794", "name": "Ja'Marr Chase", "pos": "WR", "nflTeam": "CIN", "side": "mine|opp",
                  "starter": true, "points": 24.3, "projected": 16.1, "gameStatus": "pre|live|final", "gameClock": "8:41 - 2nd" }] }] }
```
- `status`: `pre` = none of the starters' games has started, `final` = all are finished, otherwise `live` (so a week with Thursday done and Sunday to come is `live`).
- `projected` for a team is the **expected final** (live estimate); for a player it is his week projection. `teamId` is the Sleeper roster id. `gameClock` is ESPN's status text, null before kickoff.
- `players` = starters only; `?bench=1` adds bench players with `"starter": false`. `?week=` asks for another week (computed on demand, cached 60 s).

### GET /api/ticker/stream  (Server-Sent Events)
Event `score`, one per starter whose points went UP since the last look, all leagues he appears in merged into one event. Heartbeat comment `: hb` every 15 s. Reconnect with `Last-Event-ID` or `?since=evt_<n>`: the last 10 minutes are replayed (the buffer is in memory, so a server restart empties it); with neither, you get new events only. Ids rise with time (`evt_<ms>`).
```json
{ "id": "evt_1794078131000", "detectedAt": "2026-11-08T18:02:11Z", "providerAt": null,
  "playerId": "6794", "name": "Ja'Marr Chase", "pos": "WR", "nflTeam": "CIN",
  "delta": 6.4, "points": 24.3, "reason": null, "headshot": "/api/headshot/6794",
  "leagues": [{ "leagueId": "123", "name": "The Forgotten Titans", "side": "mine|opp", "delta": 6.4,
                "mineBefore": 96.4, "mineAfter": 102.8, "oppBefore": 78.2, "oppAfter": 78.2, "colour": "green|amber|red" }] }
```
- `leagues[].delta` is the per-league change (scoring can differ); top-level `delta`/`points` are the largest per-league delta and his points in the first league. `side` is per league.
- `providerAt` is always null (Sleeper gives no timestamp) and `reason` is always null (no play-by-play); apply your own delay on `detectedAt`.
- Negative changes and stat corrections are **not** emitted (the summary still has the right totals). The first look at a new week sets the baseline and emits nothing.

### GET /api/headshot/<playerId>
Token required. PNG/JPG from the existing disk cache (Sleeper's image site first, then ESPN's; 30-day hits, misses retried after a day). Unknown players get a grey silhouette (SVG). Sleeper player ids; for a DEF use the team abbreviation. Licence/terms: these are the public Sleeper and ESPN CDN images the app already shows; Multiview should cache them locally only, not republish.

### GET /api/ticker/health
`{ "status": "ok", "version": "4.17.0", "lastProviderUpdate": "2026-11-08T18:02:11Z" }` (`lastProviderUpdate` = when the last snapshot was built, null before the first). Token required.

## League colour rule (the one on the Game Day cards, server/gameday.js)
- remaining = (my projected - my points) + (opp projected - opp points), each side floored at 0; threshold = 5% of remaining.
- **green** if my expected final leads the opponent's by at least the threshold; **red** if it trails by at least the threshold; **amber** (the app's yellow) otherwise.
- Before kickoff the projections are the full-week ones; after the final, remaining is 0 so green = won, red = lost, amber = tied.
- Hex used in the app: green `#3FAE58`, amber `#D9A521`, red `#D6533B` (Multiview's mock-up values differ; the API returns the word, so use either).
- `colourBasis` shows the numbers used, so it differs from your draft's pace fields (this app compares expected finals, not points vs a pace).

## Your questions
1. Leagues: the per-league **include** switch Game Day already has (default on) is the ticker flag; no second switch. Off = absent from summary and events.
2. Cadence: Sleeper live matchups are re-read at most every 45 s and the ticker looks every 15 s during games, so a score reaches the stream about 15-60 s after Sleeper itself shows it (not measured live; Sleeper's own lag comes first). No push from Sleeper exists.
3. Address and version: above.
4. Existing endpoints: `/api/gameday` has the same numbers but needs a login session and is per-browser, so it is not reused directly; the ticker uses the same code.
