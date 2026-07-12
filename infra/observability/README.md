# Local observability

The optional development stack uses Grafana's all-in-one OpenTelemetry LGTM image for logs, traces, and metrics.

```bash
docker compose -f infra/observability/docker-compose.yml up -d
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_SERVICE_NAME=clankie-control-plane
```

Open Grafana on port 3000. Pin the image digest before production or CI use; `latest` is intentional only for the optional local scaffold.
