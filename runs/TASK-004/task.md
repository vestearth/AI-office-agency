# TASK-004: Implement Prometheus Metrics Collector in api-gateway

## Overview
Currently, `api-gateway` uses a `SimpleMetricsCollector` which stores metrics in memory without persistence or integration with standard monitoring tools. We need to implement a `PrometheusCollector` that satisfies the `MetricsCollector` interface to allow monitoring via Prometheus/Grafana.

## Type
feature

## Priority
medium

## Target Service
api-gateway

## Target Files
- `middleware/metrics.go`
- `main.go` (or wherever the server is started, to expose `/metrics` endpoint)

## Description
1. Implement `PrometheusCollector` in `middleware/metrics.go` (or a new file `middleware/prometheus.go`).
2. The collector must implement:
   - `IncrementRequestCount(method, path string, statusCode int)`
   - `RecordRequestDuration(method, path string, duration time.Duration)`
   - `IncrementErrorCount(method, path string, statusCode int)`
3. Use the `github.com/prometheus/client_golang/prometheus` library.
4. Update `main.go` to expose a `/metrics` endpoint using `promhttp.Handler()`.
5. Ensure the labels include `method`, `path`, and `status_code`.

## Acceptance Criteria
- [ ] `PrometheusCollector` is implemented and follows the `MetricsCollector` interface.
- [ ] `/metrics` endpoint is available and returns valid Prometheus format metrics.
- [ ] `http_requests_total` counter is incremented on each request.
- [ ] `http_request_duration_seconds` histogram/summary records request latency.
- [ ] `http_errors_total` counter is incremented on 4xx/5xx responses.
