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

GitHub's own cron is unreliable for new repos and at busy times, so **cron-job.org** also starts the workflow every 15 minutes:

- Request: `POST https://api.github.com/repos/eitanzur/library-tracker/actions/workflows/collect.yml/dispatches`
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
- Body: `{"ref":"main"}`. A success returns HTTP 204.
- Token: a fine-grained GitHub token scoped to **this repo only**, permission **Actions: Read and write**. When it expires, make a new one and paste it into the cron-job.org job.

The collector skips a run if the last snapshot is under 10 minutes old, so the GitHub cron and the external trigger never double-record.

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
