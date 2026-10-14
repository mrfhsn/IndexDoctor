# Google Cloud Run Deployment Guide

This guide documents the exact configuration, provisioning steps, and verification procedures for running IndexDoctor on Google Cloud Run.

---

## 1. Prerequisites & GCP Services

Ensure the following Google Cloud APIs are enabled in your GCP project:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

### Secret Manager Binding (Never Pass Secrets via Flags)

Store the Gemini API Key securely in Google Cloud Secret Manager:

```bash
# Store key from standard input (do not echo to shell history)
printf '%s' "YOUR_GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-

# Grant Secret Manager Accessor role to the default compute service account
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format="value(projectNumber)")

gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 2. Production Deployment Command

Deploy directly from source using Google Cloud Build:

```bash
gcloud run deploy indexdoctor \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --cpu-boost \
  --no-cpu-throttling \
  --min-instances 1 \
  --max-instances 5 \
  --concurrency 8 \
  --timeout 60 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

### Key Flag Explanations:

- `--memory 2Gi`: Required for running PGlite WASM alongside V8 memory heaps without OOM risk.
- `--cpu 1`: Dedicated compute core for PostgreSQL query planning and AST parsing.
- `--cpu-boost`: Allocates additional CPU during container boot to initialize PGlite WASM in < 3 s.
- `--no-cpu-throttling`: Keeps CPU allocated outside requests so the in-process worker thread can cleanly process background recycling and state cleanup.
- `--concurrency 8`: Caps simultaneous requests per container instance to match worker queue headroom.
- `--min-instances 1`: Keeps one instance warm during launch week to eliminate cold starts for first-time visitors.

---

## 3. Container Health & Lifecycle Probes

IndexDoctor exposes dedicated health probe endpoints:

| Probe                   | Endpoint           | Expected Response                                 | Description                                                            |
| :---------------------- | :----------------- | :------------------------------------------------ | :--------------------------------------------------------------------- |
| **Readiness / Startup** | `/api/health`      | HTTP 200, `ready: true`, `sandbox.state: "ready"` | Confirms HTTP listener, worker thread init, and PGlite WASM readiness. |
| **Liveness**            | `/api/health/live` | HTTP 200, `alive: true`                           | Fast liveness ping without querying the sandbox worker.                |

---

## 4. Verification Suite

Run the automated deployment verification script against the deployed service:

```bash
npm run verify:deploy
```

The script executes a 12-point validation matrix:

1. `gcloud run services describe`: Validates memory (2Gi), CPU (1), min/max instances, concurrency, and secret binding.
2. `GET /api/health`: Validates ready state and sandbox worker health.
3. `GET /api/health/live`: Validates process liveness.
4. Security Headers: Confirms `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `HSTS`.
5. Frontend Single Page App: Confirms root `/` serves static HTML bundle.
6. Golden Presets (3 runs): Confirms planner verification (`status: "verified"`, `outcome: "improved"`, index used).
7. Hostile Input Recovery: Rejects illegal `COPY` DDL with HTTP 422 and verifies subsequent request succeeds.
8. Rate Limiting: Confirms rapid burst requests return HTTP 429 without bypassing via spoofed `X-Forwarded-For`.
9. Cloud Logging Privacy Audit: Sends canary request and verifies query text and sentinel names are **never** logged to Cloud Logging (Invariant I4).

---

## 5. Performance Benchmarks

Run live performance measurements against the deployed service:

```bash
npm run measure
```

This generates `docs/measurements.md`, capturing p50/p95 latency metrics, cost reduction percentages, 20-parallel burst resilience, and 100-run sequential soak stability.

---

## 6. Post-Hackathon Teardown / Cost Reduction

After the launch week ends, scale down the service to zero instances to avoid ongoing compute charges:

```bash
# Allow scale to zero and enable CPU throttling
gcloud run services update indexdoctor \
  --region us-central1 \
  --min-instances 0 \
  --cpu-throttling

# Or delete the service entirely
gcloud run services delete indexdoctor --region us-central1 --quiet
```
