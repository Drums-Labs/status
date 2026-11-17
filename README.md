# Drums status

Service status for Drums, probed from GitHub Actions so it keeps working when our own hosts, console or database do
not (the 2026-11-16 outage took down the console, both gateways and the database together, and nothing outside our
stack showed it).

## What is checked

Every 5 minutes (`.github/workflows/status.yml`), from GitHub's runners:

| probe | URL | counts as up |
|---|---|---|
| Console sign-in | https://console.drums.run/sign-in | HTTP 200 |
| Gateway beta.drums.run | https://beta.drums.run/gw/healthz | HTTP 200 |
| Gateway lab.drums.run | https://lab.drums.run/gw/healthz | HTTP 200 |
| Control-plane database (Supabase REST) | https://eqaqsuesgrzvtrhdjrok.supabase.co/rest/v1/ | any HTTP answer below 500 |

Each probe has a 10 s timeout. **Up**: the expected answer within 3 s. **Slow** (degraded): the expected answer after
more than 3 s. **Down**: a wrong status, a 5xx, a network error or no answer within 10 s. Uptime over 24 h and 7 days
counts Up and Slow as available. GitHub can delay or skip scheduled runs when it is busy; a skipped run is a gap in
the history, not a Down.

History: the `data` branch holds `history.jsonl` (one line per run) in a single commit that each run replaces, pruned
to 7 days. The page (`index.html`) and `status.json` are rebuilt from it on every run.

## Code

`src/status.mjs` is plain Node (20 or later), no dependencies:

```bash
node src/status.mjs probe  --history data/history.jsonl   # probe, append, prune to 7 days
node src/status.mjs render --history data/history.jsonl --out site
node --test test/
```

## Turning it on (owner, once)

Nothing below has been done yet. In particular **no DNS record was created**.

1. Merge the pull request that adds the workflows. Scheduled runs start from `main`; the first run creates the `data`
   branch.
2. Optional: add the repository secret `SUPABASE_ANON_KEY` (the public anon key the console already ships). Without
   it the REST probe still works: Supabase's API answers 401, which proves it is answering.
3. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
4. Settings > Secrets and variables > Actions > Variables: add `PAGES_ENABLED` = `true`. The deploy job is skipped
   until then, so the schedule does not fail every 5 minutes before Pages exists.
5. Custom domain `status.drums.run`:
   - DNS (at the drums.run DNS provider): a `CNAME` record `status` -> `drums-labs.github.io`. Not applied.
   - Settings > Pages > Custom domain: `status.drums.run`, then tick Enforce HTTPS once the certificate is issued.
     With a GitHub Actions Pages source the custom domain is this setting; a `CNAME` file in the site is not used.
   - Verify the domain for the organization (Organization settings > Pages > Add a domain) so no other account can
     claim `status.drums.run`.

Until step 5 the page is at https://drums-labs.github.io/status/.
