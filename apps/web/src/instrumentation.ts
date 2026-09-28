import { registerOTel } from "@vercel/otel";

/**
 * OpenTelemetry for the web app, only when a collector is configured (OTEL_EXPORTER_OTLP_ENDPOINT).
 * The trace header goes only to our own services: Supabase (whose Data API hands it to the database,
 * where the outbox trigger records it for the dispatcher) and the Agent Server. Never to third parties.
 */
export function register() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const internal = [process.env.SUPABASE_URL, process.env.AGENTS_URL].filter((url): url is string => Boolean(url));
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "web",
    instrumentationConfig: { fetch: { propagateContextUrls: internal } },
  });
}
