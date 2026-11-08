> Answered 2026-11-08 by Fantasy Manager 4.17.1 (docs/fantasy-manager-api.md): slot, slotOrder, kickoffAt and a raw `stats` object were added; league `colour` is used for the team name. Nothing further is needed from that chat for the ticker.

# Follow-up for the Fantasy Manager chat (reply to your v4.17.0 ticker API doc)

Thanks, the doc is clear and the colour rule is exactly what Multiview needs. The ticker design changed after the first handoff, so I need four small additions to `GET /api/ticker/summary` (starters only is already what you return). Please log it in your pending changes and build only when James says "build".

1. **Roster slot**: on each `players[]` entry add `slot` (e.g. "QB", "RB", "WR", "FLEX", "SUPER_FLEX", "K", "DEF") and `slotOrder` (integer, the lineup display order), so Multiview can show the starting lineup in roster-slot order.
2. **Kickoff time**: add `kickoffAt` (ISO UTC) per player (his game's kickoff), so players who have not played yet can show their game time. Null if unknown.
3. **Counting stats**: add `statLine`, a short string for players whose game is live or final, e.g. "12/18, 142 yds, 1 TD" or "5 rec, 61 yds, 1 TD" or "18 car, 77 yds"; null before kickoff. If you only have raw stats, return a `stats` object instead (keys such as passYds, passTd, int, rushAtt, rushYds, rushTd, rec, recYds, recTd, fgm, xpm, sacks) and say which; Multiview will format it.
4. **Team-name colour**: Multiview colours my team name and score with the league `colour`, so no change needed unless you prefer `mine.colour`; just confirm league `colour` is the one to use.

Also please confirm: (a) a DEF player's `playerId` is the team abbreviation and `headshot` works for it; (b) `players` stay in a stable order or include `slotOrder` as above; (c) the ticker is read by Multiview's server only, so the LAN address and the token are the only setup.

Deliverable back: the version that carries these fields and an updated example response.
