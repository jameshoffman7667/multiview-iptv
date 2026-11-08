# Fantasy ticker and score pop-ups - scope (draft, nothing built)

Logged as P-25 (ticker) and P-26 (pop-ups) in `docs/pending-changes.md`. Mock-ups: `docs/img/fantasy-ticker-single.png`, `-quad.png`, `-nine.png` (sample data, generic broadcast, no real logos; source `docs/img/fantasy-ticker-mock.html`).

## 1. What it is
- **Ticker**: a thin bar along the bottom of the app that scrolls every league's matchup score (my team - opponent) and, per matchup, the top scoring players on each side.
- **Pop-ups**: when a rostered player scores, his headshot slides down from the top centre with the points, the leagues he is in, and the new league totals.
- Data comes from **Fantasy Manager**, James's own Docker app on the same server (not from Sleeper directly). The multiview server talks to it; browsers and the Android app never see its address or token.

## 2. Data flow
```
Fantasy Manager (docker)  --HTTP+SSE, read-only token-->  multiview server (src/fantasy.js)
        |                                                    |  keeps the latest snapshot + a 10-minute event log
        |                                                    |  proxies and caches headshots
                                                              v   /api/fantasy/summary, /api/fantasy/stream (SSE), /api/fantasy/headshot/<id>
                                                      page (ticker + pop-up layer), phones, TV app
```
- New env on the multiview container: `FANTASY_URL` (e.g. `http://fantasy-manager:PORT`, same Docker network or host:port) and `FANTASY_TOKEN` (read-only). Names only in the repo; values in the server `.env`.
- Admin-only setting to turn the feature on; every logged-in user can use it (it shows James's leagues, so default **admins only**, option to allow viewers; see questions).
- Server polls the summary every 15 s while any game is live (30-60 s otherwise) and holds one SSE connection for events. If Fantasy Manager is down the ticker shows "Fantasy offline" and hides itself after 60 s; nothing else in the app is affected.

## 3. Contract needed from Fantasy Manager
Written as a handoff prompt for that app's chat: `docs/fantasy-manager-api-handoff.md` (also given to James as a file). In short: `GET /api/ticker/summary`, an SSE `GET /api/ticker/stream` of score events with before/after league totals, a headshot URL per player, a ready-made league colour (green/amber/red) so this app does not re-implement the performance-vs-projection rule, and a read-only bearer token.

## 4. Ticker (P-25)
- Fixed strip at the bottom, 34 px (taller on TV), above nothing else; the video grid shrinks by that height so it never covers broadcast graphics. Hidden while the app is in the floating (PiP) player and in zoom if the person turns "hide when zoomed" on.
- One scrolling row (CSS transform animation, speed option; pauses while the pointer is over it / remote focus). Per league: **league name** (coloured by performance vs projection) - **my team score** (green) - **opponent score** (red) - then compact player chips: my players green, opponent's red, `Chase 24.3`. Leagues separated by a thin rule; final results get a small "F".
- Order: leagues with live games first, then not started, then final. Tap a league in the ticker opens a small matchup sheet (both lineups with points / projection) - phase 2.
- Settings (per device, in Settings > Fantasy): Ticker on/off, speed (slow / normal / fast), show players on/off, leagues (all / pick), hide when zoomed.
- Mock-up: the strip at the bottom of each image.

## 5. Score pop-ups (P-26)
Layout (see mock-ups; no background, no outline, only a soft drop shadow so it reads on bright grass):
- Centre top: **player headshot** (150 px at 1600 wide; scales with the viewport and layout: 100% single, 85% quad, 70% nine).
- **Left of the headshot: green +points** the player just scored for leagues where I have him. **Right: red +points** for leagues where he is on my opponent's roster. A side with no leagues is not drawn.
- Under the headshot: name, position, team, a short reason when known ("TD").
- Under that, one row per league the player is in: **my total (green) - league name - opponent total (red)**. League name colour = performance vs projection, using the same rule as Fantasy Manager (the app sends the colour).
- Only **one player at a time**. Each is shown for **5 s** (not counting the slides). Simultaneous scores queue (first in, first out, 0.25 s gap). If the same player scores again while queued, the two are merged into one pop-up with the combined points. Queue age limit option (drop events older than 60 s so a burst never runs minutes behind).
- Animation: slides **down from the top** (0.45 s ease-out), holds, slides **back off the top** (0.45 s ease-in). On arrival the league rows show the **score before the update** and the player points show **0** for **0.5 s**, then all numbers **roll up** to the actual values (about 0.9 s, ease-out, tabular digits so the width does not jump). The rest of the 5 s the final numbers stay.
- Options (per device, Settings > Fantasy): Pop-ups on/off; **Delay** 0-180 s (default 0) - the pop-up is shown at `event time + delay`, so it lines up with a delayed stream; **Minimum points** (default 1.0; 0 = every change); include opponents' players on/off; size auto / small / medium / large; queue age limit.
- Never shown during PiP, over a modal dialog, or while the picker/guide is open (held and shown right after, within the age limit). Pop-ups do not take focus or taps (`pointer-events: none`).

## 6. Timing and the delay option (important)
- A pop-up can never be earlier than the fantasy provider's own stat update, which lags the real play (typically tens of seconds; not measured yet). IPTV streams are also behind live by a similar or larger amount. The **Delay** option only adds time; it cannot fix a stream that is *faster* than the stats. To help set it, phase 2 can add a "calibrate" button: James taps when he sees a touchdown on the stream, and the app stores the offset from the next scoring event.
- Event time is Fantasy Manager's detection time (and the provider's time when it has one), not the page's receive time, so reconnecting does not replay old events: the page asks for events since "now minus 5 s" on connect.

## 7. Layout and platform notes
- Single / quad / nine: one pop-up for the whole page, centred over the top, not per tile. In nine-screen view it covers part of the top row's scoreboard bugs for 5 s; scaling it down (70%) helps, and the "Size" option lets James pick small.
- With no background the text depends on its shadow; on pure white graphics it will be weaker. A faint dark gradient behind the whole block is a one-line option if James wants it (off by default, as asked).
- Android app and TV box: same page, so the same ticker and pop-ups; the pop-up layer is above the web page but below the native local-mode video (local mode makes the page see-through, so it still draws on top of it).
- Cast to a TV only shows the cast stream, not the ticker or pop-ups (they are page overlays).
- Accessibility: pop-ups are `aria-live="polite"` (one summary line) and can be turned off.

## 8. Server and page work (estimate)
| Part | Work |
| --- | --- |
| `src/fantasy.js` | client for Fantasy Manager (summary poll, SSE with reconnect), event log (10 min), headshot proxy + disk cache, `/api/fantasy/*` routes, settings |
| Page ticker | bar, marquee, per-league chips, settings, hide rules, grid height |
| Page pop-up | queue, merge, timers with delay, slide + roll animation (CSS + requestAnimationFrame), settings, layout scaling |
| Tests | contract tests with a mock Fantasy Manager (events, merge, threshold, delay, queue age), UI tests (one at a time, 5 s, 0 then roll, slide in/out, PiP hides), screenshots |
Release plan: 0.10.0 = connection + ticker (minor), 0.11.0 = pop-ups (minor). No compose change except the two new env values.

## 9. Open questions (also in the pending log)
1. **League name colour rule**: Fantasy Manager's exact thresholds (green / amber / red vs projection, and what happens before kickoff and after final). The handoff asks that app to return the colour so the rule lives in one place.
2. Who sees it: admins only, or every logged-in user (it shows James's leagues)?
3. Fantasy Manager address and a read-only token for the multiview container (Claude Code adds them to the stack env; never put in the repo).
4. Default minimum points (suggested 1.0) and default delay (0).
5. Should points scored by opponents' *bench* players be ignored (suggested: yes, starters only)?
6. Do negative changes (fumble lost, stat corrections) pop up? Suggested: no pop-up, the league totals and ticker still update.

## 10. Revision 2026-11-08 (James's answers) - supersedes sections 4 and 9 where they differ
- **Admins only** for ticker and pop-ups. **Starters only**, both teams. Negative changes: no pop-up. **Default minimum for pop-ups: 3.0 points** (big plays only).
- **Ticker design replaced.** Per league: league name, my team name + score (coloured vs projection), opponent score + team name (white); team names sit under their scores. The league name pins to the left edge, then the score pair pins just right of it with the ticker's right edge at the opponent score; names scroll off. Player items slide in behind the pinned block until the next league pushes it off. Then each team's full starting lineup in roster-slot order: pre-game shows game time; live shows name, points and counting stats in brackets; final shows score and stats in light grey. A player whose points rose since his last appearance on screen for that side (mine or opponent, across all leagues) shows green (mine) or red (opponent) with a glow and rolls up, with the team total rolling up too.
- **Needs from Fantasy Manager** (added to the handoff): roster slot and order, team names, kickoff time, game state, per-player counting-stat line, and per-player points. Display tracking of "last seen score" lives in the page, per device.
- **Build impact:** the ticker becomes a pinned-header marquee with per-item state (more work than a plain scroll; roughly the size of the pop-up work). Mock-ups in docs/img/ show the old ticker; a new ticker mock-up can be made before building.
- Still open: league-name colour (assumed neutral now), the colour rule, address and token. Fantasy Manager's API doc from James is awaited.
