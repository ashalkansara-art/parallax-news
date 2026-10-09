# Parallax News

A personal news reader in the spirit of Ground News. It reads RSS feeds from 63 outlets, groups articles about the same event into one story, and shows how much of the coverage comes from left, centre and right-leaning outlets.

## What it does

- **Stories, not articles.** Headlines from different outlets about the same event are clustered into one story card with a coverage bar (left / centre / right).
- **Compare coverage.** Open any story to see each side's headlines next to each other.
- **Blindspots.** Stories that one side of the spectrum is barely covering get a badge and their own panel.
- **Only your topics.** World, UK politics, US politics, India, business, environment, science, health, technology, F1 and football. Celebrity, showbiz, royal gossip, shopping deals and other sports are filtered out (`config/filters.json`).
- **No minor stories.** The "covered by at least" control (default 3 outlets) hides stories few outlets picked up.
- **Top today and this week.** Every tab opens with its five biggest stories of the day, or of the past seven days. Each update reads the live site's previous `data.json` to carry the week forward, since feeds only reach back a few days.
- **F1 spoiler shield.** From the first competitive session of a race weekend (sprint qualifying or qualifying), F1 headlines that could give away a result are hidden. Build-up news and non-race news (contracts, calendar) still show. Results come back when you tap "I've watched it", or automatically after a delay you choose (default 36 hours after lights out). The F1 desk shows the next race, a countdown and session times in your time zone.
- **Football spoiler shield.** Football headlines that read like a result (a scoreline, "beat", "late winner", player ratings) are hidden until you tap "I'm caught up", or once they're older than a delay you choose (default 24 hours). Transfer news, injuries and previews still show.
- **Your reading balance.** Tracks which side of the spectrum the articles you open come from.
- **Extras.** Search, save for later, "not interested", muted words, per-outlet on/off, "new since your last visit", light and dark themes. All personal settings stay in your browser.

## Run it

Needs Node 18 or newer and nothing else.

```sh
node scripts/build.mjs          # fetch live feeds -> public/data.json
npx serve public                # open http://localhost:3000
```

`npm run sample` builds a file of made-up sample stories for trying the layout offline.

## Host it free on GitHub Pages (auto-updates every 30 minutes)

1. Push this folder to a new GitHub repository.
2. In the repo, open Settings → Pages and set Source to **GitHub Actions**.
3. The `Update news` workflow runs on every push and every 30 minutes, rebuilds the news file and publishes the site. Run it by hand from the Actions tab the first time.
4. On iPhone, open the site in Safari, tap Share, then **Add to Home Screen**. It opens full screen with its own icon. On Android, use Chrome's **Install app**.

## Customise

- `config/sources.json`: outlets, their feeds, lean (-2 Left to 2 Right), factuality and owner. Ratings are an approximate consensus of AllSides, Ad Fontes Media and Media Bias/Fact Check.
- `config/filters.json`: blocked words, topic keywords, and the words that count as F1 spoilers.
- `config/f1-calendar.json`: remaining 2026 race weekends and session times in UTC. Times are approximate; check formula1.com.
- `JOIN_THRESHOLD` and `MIN_SHARED` in `scripts/build.mjs`: raise them if unrelated stories get merged, lower them if the same story shows up twice.
