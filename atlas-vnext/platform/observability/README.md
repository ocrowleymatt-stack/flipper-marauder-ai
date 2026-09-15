# @atlas-vnext/observability

Platform primitive: route/attempt/cost/tool traces.

Structured JSON logs (`logPlatform`) carry request correlation ids. Metrics are low-cardinality counters/histograms (`platformMetrics`). Redaction strips secrets, tokens, cookies, prompts, and file bodies. Exporters remain optional.

