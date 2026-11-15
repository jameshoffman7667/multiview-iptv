# Handoff 2 for the Fantasy Manager chat: projection colours and a sync-only "ticker" user level

Paste this into the chat for the **Fantasy Manager** app (James's Docker app on the same server). Context: the **IPTV Multiview** app (repo `jameshoffman7667/multiview-iptv`) already reads `GET /api/ticker/summary` and `GET /api/ticker/health` (see `docs/fantasy-manager-api-handoff.md`, Fantasy Manager 4.17.0). The rules stay in Fantasy Manager; Multiview only draws what it is sent. Nothing here writes data.

## Part 1 - projections and their colours in the summary (additive, keep existing fields)
Multiview will show, under each pinned league's scores (after the team names fade), the team's **total projection**, and under each player's current score his **projection**. James wants Fantasy Manager to send both the numbers and the colour, so the colour rule lives only in Fantasy Manager.

Add to each league in `/api/ticker/summary`:
```json
"mine": { "teamId": "1", "name": "The All Days", "points": 96.4, "projected": 134.6,
          "paceProjected": 101.2, "projectedColour": "green|amber|red|" },
"opp":  { "teamId": "4", "name": "Bills Mafia",  "points": 78.2, "projected": 120.1,
          "paceProjected": 95.0,  "projectedColour": "green|amber|red|" }
```
Add to each `players[]` entry:
```json
{ "points": 24.3, "projected": 16.1, "paceProjected": 12.4, "projectedColour": "green|amber|red|" }
```
Rules, please answer in your reply:
1. `projectedColour` uses the **same rule** as the league `colour` you already send for my team (points vs projection or pace-adjusted projection, same thresholds and the same three colour names). For a player use the same rule applied to that player's points against his own projection (`paceProjected` = projection scaled by game progress; before kickoff and after final say what you return: empty string or a fixed colour).
2. For the **opponent** team send the colour the same way (from the opponent's own points against his projection); Multiview shows it without any change of meaning.
3. `projected` stays the full-game projection; `paceProjected` is the projection a player/team should have reached by now. Send numbers rounded to 1 decimal.
4. Empty string means "no colour" (Multiview draws it grey, like the player stat lines).
Versioned as an additive change (4.18.0 or whatever you use); old Multiview versions ignore unknown fields.

## Part 2 - a sync-only "ticker" user level
Today the ticker needs a read-only token of someone with a full Fantasy Manager account. James wants a **new permission level for ticker users**: a user who can connect their own league accounts (Sleeper username and leagues) and have Fantasy Manager sync their rosters, and who can use the ticker API, but who **cannot open the main app** (no pages, no lineup tools, no trades, no other users' data).

Requested behaviour:
1. A new role, for example `ticker`, that an admin can give to a user. A `ticker` user logs in only to a small "Ticker sync" page, with: link or unlink their provider account (Sleeper username), choose which of their leagues are in the ticker (`includeInTicker`), see the sync status, create and revoke their **own read-only ticker tokens** (name, last 4 shown, revocable).
2. Their tokens carry scope `ticker:read` only: `GET /api/ticker/summary`, `/api/ticker/health`, the score-event stream, and the player headshot route, answered for **their own leagues only**. Any other API route and every page of the main app return 403 for them.
3. Syncing: Fantasy Manager pulls their rosters, matchups, points and projections exactly as it does for a full user (same cache, same polling cadence), so the summary has everything the ticker needs without the person owning anything else in the app.
4. Admin side: an admin can list ticker users, see last sync and token usage, disable a user, and cap how many ticker users exist (default off, a small limit). A ticker user never sees other users, settings or logs.
5. Security: tokens stored hashed, never returned after creation; rate limit per token; audit log lines for token create/revoke and for 403s.
Please reply with the role name, the scope names, the new page and routes, and the version.

## Part 3 - for later (betting ticker, P-43): NFL stats for any player
Multiview will also track bets on **players who are on nobody's fantasy team** and on stats Sleeper does not track (for example longest reception, receiving attempts per quarter, game spread/total). Multiview plans to read a public NFL stats source for that (not through Fantasy Manager). Tell me if Fantasy Manager already stores broader NFL box score data (all players, more stat columns, game scores and clocks) and could serve it read-only, for example `GET /api/ticker/nfl/games` and `GET /api/ticker/nfl/player?name=<n>&week=<w>`; if it does not, say so and Multiview will use a public feed.
