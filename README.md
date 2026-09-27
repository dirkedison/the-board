# THE BOARD

Our NFL pick'em, off the whiteboard and onto everyone's phone.

**Rules:** one pick per time slot (Thu, Sun 1PM, Sun 4PM, Sun 8PM, Mon, plus any extra slots that week), always against the spread. Picks still come in through the group chat. The commissioner enters them here, and everything else is automatic.

**Live site:** https://dirkedison.github.io/the-board/ (password protected)

## What it does

- **Board.** Each week laid out like the whiteboard. Every player's letter sits next to the team they took, covers get circled and non-covers get crossed out. Scores are live, and a "sweating right now" panel shows who's covering during games.
- **Standings.** Record, win %, games back, streaks, a sparkline per player, and a week-by-week grid.
- **Stats:**
  - the race (games over .500 after every slot) and lead changes
  - time in first place
  - records by time slot
  - favorite/underdog and home/road tendencies
  - lone-wolf vs. herd picks
  - "pick twins" (who picks alike)
  - a team ledger
  - biggest covers and bad beats
- **Player pages.** Every pick with its ATS margin, plus a chart of that player against the field.
- **Automatic grading.** Final scores come from ESPN's public scoreboard, so nobody enters results by hand.

## Commissioner guide

Open the pencil icon (Commissioner).

1. **One-time setup.** Create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select repositories* → `the-board`.
   - Permissions: *Contents* → **Read and write**.

   Paste the token into **Publishing setup**. It is stored only on that device.
2. **Each week:**
   1. Pick the week and tap **Load week N from ESPN**. This pulls the schedule and ESPN's lines.
   2. Fix any line that differs from ours.
   3. As picks land in the group chat, tap a player, then tap the team(s) they picked. Tapping another game in the same slot moves their pick, and tapping it again clears it.
3. **Publish.** Everyone sees the update within a minute or two.
4. **Results need nothing from you.** Games grade themselves from final scores. Use *••• → Result* only to override one.

Other tools:

- **Slots.** Games are grouped by kickoff (Thu, Sun AM, Sun 1PM, Sun 4PM, Sun 8PM, Mon, Sat…). Move a game with *••• → Slot*.
- **Change league password.** Re-encrypts everything. Share the new password in the group chat.
- **Backup.** Downloads the full league as JSON, or restores from one.

## How the password protection works

The site is static (GitHub Pages, free). League data is committed **only** as `data/league.enc.json`, encrypted with AES-256-GCM using a key derived from the league password (PBKDF2-SHA256, 310k iterations). Without the password the file is unreadable noise, even though the repo is public. The site's code is public, but the picks aren't.

## Local development

```bash
npm run serve                                  # http://localhost:8080
BOARD_PASSWORD=... npm run decrypt             # data/league.enc.json -> data/league.json (gitignored)
BOARD_PASSWORD=... npm run encrypt             # data/league.json -> data/league.enc.json
```

No build step. It's plain ES modules in `js/`:

| File | What it does |
| --- | --- |
| `core.js` | grading against the spread, standings, timeline |
| `stats.js` | analytics |
| `charts.js` | SVG charts |
| `espn.js` | ESPN scores |
| `crypto.js` | encryption |
| `admin.js` | commissioner page |
| `app.js` | views and routing |
