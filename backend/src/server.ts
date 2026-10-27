import { buildApp } from './app';
import { makePool } from './db';
import { PipelineRunner, defaultPaths } from './pipeline';

// The API connects as the restricted `vecdim_api` role so row-level security applies.
const url = process.env.API_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('API_DATABASE_URL (or DATABASE_URL) is not set');

// The analysis pipeline writes the results tables, so it uses the owner connection (DATABASE_URL).
// Without it the API still works; analysis just is not triggered from here.
const ownerUrl = process.env.DATABASE_URL;
const runner = ownerUrl
  ? new PipelineRunner({
      databaseUrl: ownerUrl,
      analyticsDir: process.env.ANALYTICS_DIR ?? defaultPaths.analyticsDir,
      outputRoot: process.env.ANALYSIS_DIR ?? defaultPaths.outputRoot,
      rscript: process.env.RSCRIPT,
      refDate: process.env.PIPELINE_REF_DATE || undefined, // default: today in Nigeria
      debounceMs: Number(process.env.PIPELINE_DEBOUNCE_MS ?? 20_000),
      scheduleMinutes: Number(process.env.PIPELINE_SCHEDULE_MINUTES ?? 360),
      log: (s) => console.log(`[pipeline] ${s}`),
    })
  : undefined;

const app = buildApp({ pool: makePool(url), runner });
const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`VECDIM API listening on :${port}`);
  runner?.start().catch((e) => console.error('[pipeline] could not start:', e.message));
});
