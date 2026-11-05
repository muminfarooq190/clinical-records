# Clinical Records

A case workspace for uploading medical PDFs, reviewing extracted information against its source, and recording corrections.

## Start locally

Install Docker with Compose, then run:

```sh
docker compose up --build -d
```

Open http://localhost:8080, create a case, and choose **Try a synthetic record**. The worker extracts PDF text and the workspace updates automatically. Select a source reference to see the original PDF. **Review & edit** saves your correction and retains its history.

The default extraction mode creates a source excerpt for each text page. To enable structured AI facts, set `OPENAI_API_KEY` in the environment before starting Compose. `OPENAI_MODEL` defaults to `gpt-4.1-mini`. Document page text is sent to OpenAI when enabled. This live provider path requires separate verification with your API key.

## Scope of this version

This is a local, single-workspace demo using synthetic records. It has no authentication or tenant authorization. Compose binds the web port to localhost. Keep it local and use fictional data.

Uploads are text-based PDFs up to 10 MB, 100 pages and 100,000 extracted characters. Scanned PDFs return an actionable error. OCR, clinical date ordering, contradiction detection and record amendment propagation are future work. The review timeline is ordered by upload and page, with no inferred clinical chronology.

## Architecture

React and TypeScript are built into the ASP.NET Core API image. The same image runs a separate worker process. PostgreSQL stores cases, document jobs, extracted facts and correction history. Azure Blob Storage holds PDFs; Compose uses Azurite.

Uploads use a case-scoped content hash for deduplication. A blob upload completes before the document job is inserted. If the database write fails, retrying reuses the blob. An interrupted upload can leave an unreferenced blob; automated orphan cleanup is future work.

Workers claim jobs with PostgreSQL row locks and SKIP LOCKED. Claims have a five-minute lease and a random ownership token. Jobs are retried up to three times. A replacement worker can claim an expired lease, and only the current owner can atomically publish pages, facts and completion status. Manual retry resets a failed job.

API instances hold no durable process state. Workers can scale independently with `docker compose up -d --scale worker=2`. Database-backed claims prevent the same job from being claimed concurrently. All instances share PostgreSQL and blob storage. Capacity and latency have not been benchmarked.

Corrections use optimistic revisions and a transaction to prevent silently overwriting a concurrent edit. Original extraction and source quotes remain available. The demo has no reviewer identity because it has no sign-in.

The optional AI provider returns structured facts. Each quote must occur verbatim on its cited page before the job can complete. This checks source presence; a human still needs to verify the interpretation.

## Verification

GitHub Actions builds the frontend and backend, starts PostgreSQL and Azurite, and runs a browser test through the UI. It covers case creation, PDF processing, source viewing, corrections, persisted history, stale edit rejection, repeated uploads and case-scoped document access. CI uses local extraction and synthetic records.

## Stop

`docker compose down` stops services while keeping data. `docker compose down --volumes` also deletes the local demo data.
