import { context, propagation, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { IncomingMessage } from "node:http";

/**
 * Tracing for the catalog, only when a collector is configured (OTEL_EXPORTER_OTLP_ENDPOINT). Each request
 * gets a span that continues the caller's trace (the agents send a traceparent header).
 */
export async function setupTracing(): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const { NodeTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "catalog" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register(); // also installs the W3C trace-context propagator
}

/** Runs the handler inside a server span that continues the caller's trace. */
export async function withRequestSpan<T>(request: IncomingMessage, route: string, handle: (span: Span) => Promise<T>) {
  const parent = propagation.extract(ROOT_CONTEXT, request.headers);
  const span = trace.getTracer("gamenight.catalog").startSpan(
    `${request.method} ${route}`,
    { kind: SpanKind.SERVER, attributes: { "http.request.method": request.method ?? "GET", "http.route": route } },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => handle(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
