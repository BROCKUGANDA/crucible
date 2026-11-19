# SLO/SLI Definitions

## Service Level Indicators

- **API Availability:** Percentage of 200 responses
- **API Latency:** p50, p95, p99 response times
- **Queue Lag:** Time between job creation and processing
- **Indexer Lag:** Blocks behind latest chain head
- **Evaluation Completion Rate:** Percentage of evaluations completing successfully

## Service Level Objectives

- **API Availability:** 99.9% monthly uptime
- **API Latency:** p95 < 500ms
- **Queue Processing:** 95% of jobs processed within 5 minutes
- **Indexer Lag:** < 10 blocks behind
- **Evaluation Completion:** 95% success rate

## Measurement

- Metrics collected via Prometheus
- Alerts via PagerDuty
- Monthly SLO reports
