# Ontario Library Occupancy

Live and historical occupancy of Ontario university libraries: **https://libraries.eitanzur.ca**

## How it works

- `collector/collect.py` (Python stdlib only) fetches each university's public occupancy feed and appends one row per library/floor.
- `.github/workflows/collect.yml` runs it **every 15 minutes** and commits the results to the **`data` branch**:
  - `data` branch → `<university>/<YYYY-MM>.csv` with columns `t,library,space,pct,people,cap,flag`
    - `t` = Unix seconds (UTC); `space` empty = whole building; `flag` = `<25` (Queen's hides values under 25%) or `closed`
  - `latest.json` → newest snapshot plus per-source ok/error status
- The dashboard (`index.html`, `app.js`, `style.css`) is static on Vercel and reads the data straight from `raw.githubusercontent.com`. Data commits never trigger a Vercel deploy (`vercel.json` disables deploys for the `data` branch).

## Scheduling

GitHub's own cron is unreliable (new repos can wait hours for it, and busy-time runs get dropped), so the workflow keeps itself running:

- Each run executes `collector/loop.sh`, which takes a snapshot every 15 minutes for about 5.5 hours (the job limit is 6 hours).
- At the end, the run starts the next one with `gh workflow run` using the built-in `GITHUB_TOKEN`. No personal token and no outside service are involved.
- The cron schedule (`7,22,37,52 * * * *`) is only a backup that restarts the chain if it ever breaks. The `collect` concurrency group keeps a single chain alive.
- The collector skips a snapshot if the last one is under 10 minutes old, so overlapping triggers never double-record.
- **To stop collecting:** cancel the running workflow in the Actions tab (a cancelled run doesn't start the next one), then disable the workflow. Otherwise the backup cron restarts it.
- **To restart by hand:** run `gh workflow run collect.yml --repo eitanzur/library-tracker`.

## Sources

| University | Source | Detail |
|---|---|---|
| Queen's | library.queensu.ca/use-the-library/locations (HTML) | Building %; values under 25% masked |
| Waterloo | waitz.io/live/waterloo (JSON) | Head count, capacity, per floor/zone |
| Ottawa | uottawa.ca/library/study-space (HTML, Occuspace) | % per floor/zone |
| Guelph | display.safespace.io (SafeSpace) | Head count vs 3,800 capacity |

McMaster publishes per-floor data but blocks automated requests (403). It would need the library's permission.
The other ~18 Ontario universities had no public live occupancy as of November 2026. `universities.json` lists them all.

## Adding a university

Write a function in `collect.py` that returns `row(...)` dicts, add it to `SOURCES`, set its status to `live` in `universities.json`, and push.

## Local preview

```bash
python -m http.server 8765
```
Then open `http://localhost:8765/?data=<folder or URL with data>/`.
