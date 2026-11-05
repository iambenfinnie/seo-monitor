# SEO Monitor

Daily Google web-result observations for the sites and keywords in `keywords.json`, with an email report and GitHub Pages dashboard.

## Data quality and scope

- Searches use US country targeting, English, and a desktop viewport. They are **not city-localized**. A city in a keyword is not a local search location setting.
- An observed position counts extracted organic-title links on the returned page. The requested limit is 30, but Google may return fewer results. Absence means only "not found among N observed results," never "not ranking" or an assumed top-30 search.
- A valid measurement has `status: "ok"`, a positive `resultsChecked`, no error, and either a rank within that count or null for absence within those observations.
- Failed requests, challenges, consent pages, empty extraction, and browser-launch failures have `status: "error"`. No challenge is solved or bypassed.
- Old records lacking measurement evidence are **unverified**, including legacy null ranks. Do not use them as a baseline for changes.
- This scraper is not a guaranteed rank-data provider. Validate actual returned results before treating a successful collection as dependable SEO measurement.

## Outputs

- `snapshot-YYYY-MM-DD.json`: latest attempt that day, including failed checks, timestamps, actual result counts, source settings and extracted URL evidence.
- `latest-run.json`: exact workflow attempt ID, timing, status and usable/failed check counts. Fatal errors are recorded explicitly.
- `rank-history.json`: last valid observation per keyword. Failed checks never overwrite it. This is a latest-value store, not a full time series; dated snapshots preserve attempts.
- Screenshots are recorded only when capture succeeds.

The dashboard distinguishes the latest attempt from last valid observations and flags stale data. The reporter verifies the exact GitHub run and attempt before sending, so a failed rerun cannot email an earlier attempt as new data.

## Run and test

```
npm ci
npm test
npx playwright install chromium --with-deps
npm run test:browser
npm run track
npm run report
```

`npm test` exercises validity, error cases, preservation of history, report/dashboard rendering, hostname matching, attempt freshness and CLI failure status without network access. `npm run test:browser` checks extraction against real DOM fixtures with all requests blocked. GitHub Actions runs both before collection.

The Actions runner is pinned to Ubuntu 24.04 for locked Playwright 1.59.1 compatibility. Tracking exits nonzero if any check fails; later workflow steps still publish truthful diagnostic results, email the existing recipient, and refresh the existing dashboard. The overall run remains failed. Reporting failures also exit nonzero. The daily schedule and report recipient remain unchanged.

A manual verification must use **Run workflow** on the latest `main` commit. **Re-run jobs** on an older run reuses that run's original workflow and commit, so it does not test a newly pushed repair.
