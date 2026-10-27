# VECDIM: offline-first field app, PostGIS backend and role dashboard

A working prototype of the VECDIM data-collection and decision-support layers. The backend runs the pack's R analysis itself: validation flags, cleaned data, risk estimates and alerts are produced by the system from the dataset and the R code, with nobody running scripts by hand (see [The analysis pipeline](#the-analysis-pipeline)).

| Part | Where | Stack |
|---|---|---|
| Field app (offline-first) | [app/](app/) | React Native (Expo SDK 58), expo-sqlite, expo-location, NetInfo |
| Shared validator (device and server) | [packages/validator/](packages/validator/) | TypeScript, no dependencies |
| Sync queue logic (app side) | [packages/sync-core/](packages/sync-core/) | TypeScript, no React Native dependency |
| API + database + pipeline runner | [backend/](backend/) | Node 20, Fastify, PostgreSQL 16 + PostGIS |
| Analysis pipeline | [analytics/](analytics/) | the pack's R code (R, dplyr, ggplot2, randomForest), run by the backend |
| Dashboard | [dashboard/](dashboard/) | one static HTML page served by the API |
| Dataset and demo users | [seed/](seed/) | CSV, loaded as supplied; no result files |

## What you need installed

Git, Docker with Docker Compose, Node.js 20 or newer, and Expo Go on a phone or an Android emulator. The app is on Expo SDK 58, so Expo Go must be the SDK 58 build (the app says so if it is not). Nothing else. (R is installed inside the Docker image; you only need R on your own machine to run the database tests outside Docker, see Tests.)

## Run everything (one command)

```
docker compose up --build
```

This starts PostgreSQL + PostGIS, applies the migrations, loads the demo users and the dataset (safe to repeat), starts the API, and the API starts the R pipeline by itself.

- Dashboard: <http://localhost:3000/dashboard/> (use `API_PORT=3100 docker compose up --build` if port 3000 is taken, and change the port below). The **Analysis** tab shows the run.
- Health: <http://localhost:3000/api/v1/health> returns `{"status":"ok"}`
- **The first analysis run starts when the API is up and takes about a minute** (the random forest is cross-validated four ways). Until it finishes, the alerts list is empty and the Analysis tab says "running". After that, `GET /api/v1/alerts` (header `X-User-Id: u_uniosun_01`) returns 647 items.

### The mobile app

```
cd app
npm install
npx expo start
```

Open it in Expo Go (scan the QR code) or press `a` for an emulator. **Run these commands inside the `app` folder, never in the repo root.** Then in the app: **Settings → Server address**:

- Android emulator: `http://10.0.2.2:3000` (the default)
- Real phone: `http://<your computer's Wi-Fi address>:3000`, with the phone on the same network. Use **Test connection**.

**If Expo Go shows "Cannot find native module" errors** (for example `ExpoAsset` or `ExpoCrypto`), the Expo Go app is too old or is carrying over state from another project. Update Expo Go to the current version for SDK 58 (the Expo CLI offers to do this on Android: answer yes), force-close Expo Go, and open only this project. Switching between projects without closing Expo Go can leave the native modules unregistered. If port 3000 is taken on your machine, start Expo with `EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 npx expo start` (PowerShell: `$env:EXPO_PUBLIC_API_URL="http://10.0.2.2:3100"; npx expo start`) so the emulator's default server address matches.

Settings also picks which demo field worker the phone uploads as, and has **Test tools** (on by default) that add simulated GPS buttons (6 m, 18 m, 60 m, a point in Osogbo, a point in Ikorodu) to the form, so the GPS checks can be shown without a mock-location app.

### Tests

```
npm install
npm test                                  # validator (70), sync queue (14), sync/batch logic and pipeline helpers (34)
docker compose up -d db                   # for the database tests below
TEST_DATABASE_URL=postgres://vecdim:vecdim@localhost:5432 npm test     # adds the PostgreSQL/PostGIS tests, which run R
npm run parity                            # parity run; writes parity_output.txt
```

The database tests create and drop their own database, so they never touch your data. Without `TEST_DATABASE_URL` they are skipped. **They run the real R pipeline** (about 3 runs, a few minutes in total), so R with `dplyr`, `ggplot2` and `randomForest` must be installed (`apt install r-base-core r-cran-dplyr r-cran-ggplot2 r-cran-randomforest`, or set `RSCRIPT` to your `Rscript`). Without R, the unit tests and the parity test still run (parity uses the snapshot).

## The analysis pipeline

**Choice: the pack's R code runs inside the backend's container** (the option the brief prefers), not a re-implementation. The R files in [analytics/R/](analytics/R/) are the pack's, with one change: `REF_DATE` in `helpers.R` reads the environment variable `VECDIM_REF_DATE` (default: the pack's fixed `2026-10-08`), so a live run judges "future date" against today. Everything else is byte-for-byte the pack's code, so when the analysts improve the model they replace those files and nothing in the backend changes. Re-implementing it in TypeScript would have to be redone for every change to the model and would need its own parity test for the random forest; the only part worth duplicating is the validator, because the phone needs it offline (and that has a parity test).

**How a run works** ([pipeline.ts](backend/src/pipeline.ts)):

1. Export one CSV in the pack's column layout: the dataset rows (`raw_entomology`, kept exactly as supplied with every bad row in it, in file order, because the random forest depends on row order) followed by every record uploaded from the app (`field_records`, source `app`). Values the form does not capture are written as `NA`.
2. Run `Rscript R/run_all.R input.csv outputs/` (validate and clean, descriptive analysis, random forest and alerts) with a 15-minute limit.
3. Check what came back (one flag row per input row, cleaned + flagged = input, one risk prediction per clean row).
4. In **one transaction**, replace the results tables. If anything fails (R missing, a crash, a timeout, a bad output), nothing is replaced: the previous results stay in place and the failure is recorded in `analysis_runs` with R's output.

**What triggers it** (all four, the first three automatic):

| Trigger | When |
|---|---|
| `startup` | when the API starts and no run has ever succeeded (first deployment) |
| `sync` / `enrichment` | after a batch with an accepted record, or after enrichment; waits 20 s for more data (`PIPELINE_DEBOUNCE_MS`) so a burst of syncs costs one run |
| `schedule` | every 6 hours (`PIPELINE_SCHEDULE_MINUTES`, 0 turns it off) |
| `manual` | `POST /api/v1/analysis/run` (UNIOSUN), the "Run analysis now" button, or `npm run pipeline` |

Only one run happens at a time; requests that arrive during a run become one follow-up run ([PipelineRunner](backend/src/pipeline.ts), unit-tested).

**Where the results are stored**

| What | Where |
|---|---|
| validation flags (`validation_flags_all.csv`) | table `pipeline_flags`, one row per record and rule columns (latest run) |
| cleaned data | the records with `any_flag = false`; the dataset rows R accepted also become ordinary `field_records` (source `seed`) so the Field and VECDIM views have data |
| risk predictions (`risk_predictions.csv`) | table `risk_predictions`, with a PostGIS point and GiST index (`GET /risk-points?bbox=`) |
| alerts (`alerts.csv`) | table `alerts` (`tier` and `pyrethroid_resistance_flag` separate) |
| model metrics, variable importance, descriptive tables | table `analysis_files` (`GET /analysis/files/model_metrics.csv`, UNIOSUN) |
| every run: trigger, time, status, counts, R version, input hash, R's log | table `analysis_runs` |
| all of R's files for the last 5 runs, including the figures | `ANALYSIS_DIR` (`/data/analysis` volume in Docker) |

Role scope applies to the results as it does to records (row-level security): UNIOSUN sees everything, a VECDIM user their state, field workers none.

**New data, not only the sample file.** App records arrive without the climate, satellite and health-facility values (field form spec), so R's own `missing_core` rule flags them and the model leaves them out until they are enriched. A national user enriches them with `POST /api/v1/enrichment`; the next run (triggered by that call) includes them. Slide positivity decides `high_risk` (30% or more, the pack's definition). This is tested end to end in [integration.test.ts](backend/test/integration.test.ts) ("new field data flows through the pipeline"): three new records are posted, a run shows them flagged and outside the model (clean stays 1,303, flagged goes up by three), they are enriched, the next run puts them in the model (clean 1,306), in `risk_predictions`, and in a new alert `Osun|Osogbo|2026-10`. To try it by hand:

```
curl -X POST localhost:3000/api/v1/enrichment -H "X-User-Id: u_uniosun_01" -H "Content-Type: application/json" \
  -d '{"records":[{"record_id":"<uuid from the app>","rainfall_mm":180.5,"temp_c":27.2,"ndvi":0.52,"elevation_m":310,"dist_water_km":1.4,"slide_positivity_pct":45}]}'
```

There is no real satellite or health-facility feed in this prototype; `enrichment` is the entry point where one would plug in (the values are checked by the database's constraints).

**Our numbers against the brief's** (dataset only, reference date 2026-10-08; checked by the integration test):

| | Brief | This system |
|---|---|---|
| records in / flagged / clean | 1,525 / 222 / 1,303 | 1,525 / 222 / 1,303 |
| alerts (ALERT / WARNING / WATCH) | 647 (86 / 135 / 426) | 647 (86 / 135 / 426) |
| rules (outside Nigeria, 0,0, state mismatch, far from LGA, dead > exposed, positivity, future date, temperature, rainfall, duplicate, missing core) | 12, 8, 30, 30, 18, 10, 10, 8, 6, 25, 115 | 12, 8, 30, 30, 18, 10, 10, 8, 6, 25, 115 |
| model AUC (covariates, random 5-fold) | 0.820 | 0.820 (all four settings and the variable importances also match the reference files) |

They match because the code is the same. Two things would change them, and both are correct behaviour: (1) **time**: the run uses today's date for the future-date rule. The dataset's future-dated rows are all in April to September 2027, so the counts stay at 222 until then; the tests pin `2026-10-08`. (2) **new records**: once app records exist the totals include them (flagged until enriched).

## Parity test (validator vs the R pipeline)

`npm run parity` runs the validator over all 1,525 rows with the reference date 2026-10-08 and compares every rule with the `validation_flags_all.csv` **that the system's own R pipeline produces**: when R is installed the script runs the pipeline's validation step fresh on the dataset; when it is not, it falls back to a committed snapshot of that output ([fixtures/](packages/validator/test/fixtures/)), and a test fails if the snapshot ever drifts from a fresh run. Result, saved in [parity_output.txt](parity_output.txt): **0 differing rows on all 11 rules**, for the server validator (11 rules) and for the device validator (the 8 R rules marked Device). The same comparison runs as an automated test ([parity.test.ts](packages/validator/test/parity.test.ts)).

The device and server validators are one module ([rules.ts](packages/validator/src/rules.ts)): a single table of rules with Device/Server/Block/Warn, one predicate per rule. That is deliberate, so the two can never drift apart. R's missing-value (`NA`) behaviour is reproduced with three-valued logic. The two accuracy rules (not in the dataset) are covered by unit tests at 10, 10.1, 50 and 50.1 m.

## Design decisions

- **Offline first.** Everything the worker enters lives in SQLite on the phone: drafts, saved records and the sync queue are one table with a status (`draft`, `pending_sync`, `synced`, `synced_with_flags`, `rejected`). A draft is autosaved 0.7 s after each change and when the app goes to the background, and is offered back on the next launch ("You have an unfinished record from 14:32. Resume or discard?") with every value, the `record_id` and the GPS fix restored. The `record_id` (UUID v4) is created when the form opens, and never changes.
- **Safe sync.** `sync-core` uploads whatever is due, matches answers by `record_id`, and keeps failed records `pending_sync` with exponential back-off (5 s doubling to 15 min, ±20% jitter). Because uploads are idempotent, being killed mid-upload is harmless: on reopening, the same records are sent again and the server answers `already_received`. It runs on launch, when the connection returns (NetInfo), when the app comes to the front, after Save and every 30 s. Rejected records are never deleted or retried automatically; the worker opens one, sees the server's message beside the field, changes only that field and taps Resubmit.
- **Server.** Every record in a batch runs in its own transaction, so one rejection rolls back nothing else. A batch always answers HTTP 200. Every attempt, including rejected ones with their errors and the payload, is written to `sync_batch_items`.
- **Database as system of record.** Constraints repeat the Block rules (see below), so bad data cannot get in even if the API is bypassed. Role scope is row-level security, not just API code.
- **GPS.** The app asks for the best fix, keeps the most accurate reading for up to 60 s, accepts at 10 m or better, lets the worker continue with a warning between 10 and 50 m, and blocks above 50 m or with no accuracy ([gps.ts](packages/validator/src/gps.ts), tested).
- **Dates.** The "future date" reference is the phone's local date on the device and today's date in Nigeria (WAT) on the server, so a record made late in the evening is never "from the future".

## Database

Versioned migrations in [backend/migrations/](backend/migrations/) (`001_schema`, `002_access_control`, `003_record_exists`, `004_analysis_pipeline`), applied by `npm run migrate` and tracked in `schema_migrations`.

| Table | Purpose | Links |
|---|---|---|
| `lgas` | the 15 pilot LGAs with reference points | referenced by `field_records` and `alerts` |
| `users` | demo users: role `field`/`vecdim`/`uniosun`; a VECDIM user has a state | owner of records and batches |
| `field_records` | one row per accepted form. `record_id` primary key (made on the phone), `geom geometry(Point,4326)` generated from lat/lon, GiST index, `payload` as received, `captured_at` (device) and `received_at` (server) | `owner_user_id`→`users`, `(state,lga)`→`lgas`, `batch_id`→`sync_batches` |
| `validation_results` | one row per record and Warn rule it triggered | `record_id`→`field_records` |
| `sync_batches` | what each device sent and when, with counts | `user_id`→`users` |
| `sync_batch_items` | the outcome of every record in every batch, including rejected attempts with errors and payload | `batch_id`→`sync_batches` |
| `raw_entomology` | the supplied dataset exactly as given, bad rows included (no constraints on purpose); the pipeline's input | read by the pipeline |
| `analysis_runs` | one row per pipeline run: trigger, status, counts, R version, input hash, log | referenced by the results tables |
| `pipeline_flags` | R's validation flags, one row per analysed record (latest run) | `run_id`→`analysis_runs` |
| `risk_predictions` | R's per-record risk and tier, PostGIS point with GiST index (latest run) | `run_id`→`analysis_runs` |
| `analysis_files` | R's small CSV outputs (model metrics, importance, descriptive tables) (latest run) | `run_id`→`analysis_runs` |
| `alerts` | R's `alerts.csv` (latest run); `tier` and `pyrethroid_resistance_flag` are separate columns | `(state,lga)`→`lgas`, `run_id`→`analysis_runs` |

Constraints on `field_records`: unique `record_id`; `n_exposed` 1 to 500; `n_dead` between 0 and `n_exposed`; coordinates inside Nigeria, not 0,0, and inside the chosen state's box; accuracy at most 50 m; ward belongs to the LGA; allowed species and insecticide; `itn_use_pct` 0 to 100; temperature, rainfall and positivity ranges; a trigger for the future date; audit columns (`payload`, `captured_at`, `received_at`, `record_id`) cannot be updated. A rejected record is never stored, so a corrected version with the same ID is a new attempt, not a duplicate.

Access: the API connects as `vecdim_api`, which is not the table owner, so RLS applies. Each transaction sets `app.user_id`, `app.role` and `app.state`. A field worker reads only their own records, a VECDIM user only their state, UNIOSUN everything; `vecdim_api` has no UPDATE or DELETE on records. Two small `SECURITY DEFINER` functions (`record_exists`, `has_duplicate_record`) return only a boolean, so the idempotency and duplicate checks see the whole table.

UNIOSUN tier counts in one query: `SELECT tier, count(*) FROM alerts GROUP BY tier;` gives 86 ALERT, 135 WARNING, 426 WATCH.

## API

`/api/v1`: `GET /health`, `POST /records/batch`, `GET /records?state=&lga=&since=`, `GET /alerts?state=&lga=&from=&to=` (plus `tier` and `resistance` filters), `GET /alerts/summary`, and the bonus `GET /risk-points?bbox=minLon,minLat,maxLon,maxLat` (PostGIS `&&` on the GiST-indexed point; VECDIM and UNIOSUN, scoped by role). Analysis: `GET /analysis/latest` (status and counts for what the caller may see), `GET /analysis/runs`, `POST /analysis/run` (UNIOSUN, answers 202), `GET /analysis/files/{name}` (UNIOSUN), `POST /enrichment` (UNIOSUN). Extras used by the apps: `GET /users`, `GET /me`, `GET /records/attention`, `GET /sync/batches`. Not built: `/alerts/{id}/acknowledge`, `/export/dhis2` (bonus items in the contract).

## Why this backend

**Choice:** TypeScript on Node with Fastify, PostgreSQL + PostGIS, and the rules written once in a shared TypeScript package.

- **The existing R pipeline.** The backend runs it (see [The analysis pipeline](#the-analysis-pipeline)): it exports the data to the pack's CSV layout, calls `Rscript`, checks the output and loads it into PostgreSQL in one transaction. The seam is deliberately thin: R only ever sees a CSV and only ever writes CSVs, so the analysts keep working in R, and if R is ever replaced only the exporter and the loader (about 150 lines) change; the tables the API reads keep their shape. The cost is that the API container carries R (about 600 MB) and a run takes a minute; for more data, move the runner into its own container or job queue unchanged, since it only needs the database and `Rscript`.
- **Future modelling.** Retraining, new covariates and the NTD module are new or changed R files in `analytics/` (or a second runner for Python) that read the exported data and write result tables. The API serves those tables and stays unaware of the model. The honest trade-off: Python (FastAPI) would sit closer to the modelling code, but it would mean writing the validator twice, once for the phone (which must be JavaScript) and once for the server, and keeping them identical is exactly what the parity test exists to police. One shared module removes that risk, and the modelling jobs do not need to live in the API process anyway.
- **Scalability.** Uploads are small idempotent batches, so 10,000 field workers are mostly many short, independent requests. The API is stateless and scales horizontally behind a load balancer; PostgreSQL is the shared state. Per-record transactions keep locks short; the unique key and the indexes on `record_id`, `(state, lga)`, owner and the duplicate key keep lookups cheap. First things to add under real load: PgBouncer for connections, `captured_at`/month partitioning of `field_records` and `sync_batch_items`, and a read replica for the dashboard. The weak spots are the per-record round trips in a batch (a few queries each) and the unbounded `sync_batch_items` log, both fixable without changing the design.
- **Maintainability.** One language across phone, server and tests; plain SQL migrations instead of an ORM so the rules in the database are readable; no framework magic (about 700 lines of backend code); validator, queue logic and batch logic are pure functions with injected storage, so a new developer can run the tests without a database. The cost is that Node is not the usual language for a public-health analytics team, which is why the analytical work stays in R/Python and only talks to the system through PostgreSQL.

## Known limitations (what is not done or not verified)

- **`docker compose up --build` was run on Windows with Docker Desktop (WSL 2), from empty volumes, with the final image.** It applied the four migrations, loaded 7 users and 1,525 dataset rows, and the API started the R pipeline by itself: run 1 (trigger `startup`, Debian R 4.2.2) finished in 58 s with 1,525 rows, 222 flagged, 1,303 clean and 647 alerts (86 / 135 / 426), and all 11 rule counts matched the brief. Through the API the Osun VECDIM user saw only Osun (41 / 44 / 129) and a field worker was refused the analysis endpoints. An earlier run exposed a bug, now fixed: the database healthcheck passed during Postgres's first-run init (socket only), so the API started too early; it now checks over TCP. Not run: compose on Linux or macOS, and the database tests inside the container (they ran against PostgreSQL 16.10 + PostGIS 3.6.2 installed on Windows, with R 4.6.1).
- **The app was run on an Android emulator (Pixel 6, API 34, Expo Go 58.0.5)** and reached its home screen against the Dockerised API; the screens, autosave timing and GPS behaviour were not exercised by hand, and it was not run on a physical phone. It type-checks (Expo SDK 58, `expo-doctor` 20/20) and Metro bundles it for both Android and iOS (including the shared packages), and its logic (validation, GPS decisions, queue, back-off, resubmission, a connection dropped mid-upload against the real server logic) is unit-tested. The screens, autosave timing and GPS behaviour have not been exercised by hand. Please run the manual checks below.
- **The `outputs/` folder was empty in my copy of the pack**, which is why nothing in this system reads result files: the pipeline produces them. During development I also ran the R code by hand (R 4.6.1 on Windows) and the numbers matched the brief; the database tests were run with that R, and Docker uses Debian's R 4.2. Both give the same results (see the table in [The analysis pipeline](#the-analysis-pipeline)).
- **Enrichment is a stub.** There is no real climate, satellite or health-facility feed. `POST /enrichment` accepts the six values from a national user. Until a record is enriched it is flagged `missing_core` by R and kept out of the model, so a field worker's new record does not appear in alerts or risk estimates until then. That is the pack's own rule, but in production it means a delay between a sync and its effect on the alerts, set by how quickly enrichment arrives.
- **Analysis runs in the API process** and uses the owner database connection (it writes the results tables). Fine for one server; with several API instances each would run its own schedule, so move the runner to one worker (or a job queue) first. A run takes about a minute at this data size; the random forest and its four cross-validations will grow with the data.
- **Duplicates, live data and R.** R keeps the lowest `record_id` of a duplicate group and flags the rest; the server flags the later arrival at upload. For app records (random UUIDs) these can pick different records. Both are stored; only R's choice affects the model.
- Authentication is a demo header (`X-User-Id`); no passwords or tokens. The `vecdim_api` password is a development default in migration 002.
- Duplicate rule on live uploads: a record is flagged when a different record with the same key is already stored, so the later arrival is flagged (Warn), not the one with the larger `record_id`. Both are stored.
- `mortality_pct` uses R's rounding (exact ties to even), so it can differ from PostgreSQL's `round()` by 0.1 on exact ties; it never changes a WHO class.
- A rejected record can be corrected in the app but its edits are not autosaved until Resubmit. The dashboard's Field view reads server data (accepted records and rejected attempts); the phone itself is the full view of pending records.
- No maps, DHIS2 export, alert acknowledgement or real authentication. The Expo template suggests Expo Router; two screens use simple state navigation instead.

## Manual checks (from the brief)

1. Airplane mode, save three records, close and reopen: all three are listed as "Waiting to sync".
2. Half-fill a form, force-close, reopen: the "Unfinished record" prompt offers it back with every value.
3. Test tools: 6 m is accepted, 18 m shows a warning and can be saved, 60 m cannot be saved. Choose Ife Central then "Point: Osogbo": a "km from Ife Central" warning appears.
4. Turn the connection on: records upload by themselves and become Synced.
5. Enter `n_dead` above `n_exposed` and tap Save: blocked, message beside the field. (To see a server rejection, save with the server on a different clock, or post a bad record with curl.)

## Credits and AI assistance

Built with **Claude Code** (Anthropic's AI coding assistant). It wrote the code, tests and this README from the brief and the candidate pack, ran the tests, built the backend runner for the pack's R code and checked its results against the reference numbers in the brief, and installed local R and PostgreSQL/PostGIS to test against. The author is responsible for the submission and must be able to explain every line (see Interview in the brief). Libraries: Fastify, node-postgres, Vitest, Expo (sqlite, location, crypto), NetInfo, React Native. The WHO bands, rules, constants and API shapes come from the candidate pack's documents. The data is synthetic.
