# Monitoring Infrastructure

Centralized Prometheus metrics collection and Alertmanager alerting stack for PERO-J microservices (backend, indexer, and oracle daemon).

## Overview

- **Prometheus**: Central metrics scraper configured with a 15-second scrape interval across all microservices (`infra/monitoring/prometheus.yml`).
- **Alertmanager**: Alert routing engine with multi-channel dispatch (Slack, Discord, PagerDuty) configured in `infra/monitoring/alertmanager.yml`.
- **Deployments**: Docker Compose (`docker-compose.monitoring.yml`) and Kubernetes manifests (`k8s/monitoring/`).

## Architecture & Scrape Targets

Prometheus scrapes the following microservices on 15s intervals:
- **Indexer** (`indexer:3001/metrics`): Ledger processing lag, block ingestion rates, decode times.
- **Backend API** (`backend:8080/metrics`): Request latency, error rates, active connections.
- **Oracle Daemon** (`oracle-daemon:8081/metrics`): Feed freshness, price updates, dispute statuses.

## Quick Start (Docker Compose)

Start the monitoring stack alongside local services:

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

- Prometheus UI: [http://localhost:9090](http://localhost:9090)
- Alertmanager UI: [http://localhost:9093](http://localhost:9093)

## Kubernetes Deployment

Deploy to Kubernetes monitoring namespace:

```bash
kubectl apply -f k8s/monitoring/
```

## Notification Routing

Alerts are routed according to severity:
- `critical`: PagerDuty incident paging and #alerts-monitoring Slack channel.
- `high`: Discord webhooks and Slack channel.
- `operations`: Dedicated #ops-alerts channel for unresolved markets and stalled governance votes.
