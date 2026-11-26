import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { setting } from "./env";

// Sends every model call and run span to Langfuse. Start it before anything that makes a call.
// A Langfuse that cannot be reached loses the traces, never the run: stopping only logs it.
// A test passes its own project, so it needs no Langfuse settings.
type Project = { baseUrl: string; publicKey: string; secretKey: string };

export function startTracing(service: string, project?: Project): () => Promise<void> {
  const processor = new LangfuseSpanProcessor({
    ...(project ?? {
      baseUrl: setting("LANGFUSE_BASE_URL"),
      publicKey: setting("LANGFUSE_PUBLIC_KEY"),
      secretKey: setting("LANGFUSE_SECRET_KEY"),
    }),
    environment: "workshop",
  });
  const sdk = new NodeSDK({ serviceName: service, spanProcessors: [processor] });
  sdk.start();
  return async () => {
    try {
      await processor.forceFlush();
      await sdk.shutdown();
    } catch (error) {
      const reason = error instanceof Error ? error.message || String((error as { code?: string }).code) : String(error);
      console.error(`Langfuse did not take the last traces: ${reason}`);
    }
  };
}
