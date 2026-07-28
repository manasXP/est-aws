-- STR-103: E11's Tally export job tracking (aws-blocks/finance/
-- tally-export-jobs.ts). AsyncJob is fire-and-forget with no built-in
-- status API, so per its own documented pattern the handler tracks
-- `queued -> running -> completed | failed` here -- one row per requested
-- export, mirroring the Admin OpenAPI's ExportJob schema (export_id, kind,
-- status, from/to, requested_at, completed_at, failure_reason) plus the
-- stored artifact's FileBucket path. Purely additive -- CREATE TABLE
-- matches none of migrations-lint's destructive patterns.
CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'tally',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failure_reason TEXT,
  document_path TEXT
);
