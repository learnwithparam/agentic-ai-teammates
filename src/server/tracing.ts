import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { setting } from "./env";

// Sends every model call and run span to Langfuse. Start it before anything that makes a call.
export function startTracing(service: string): () => Promise<void> {
  const processor = new LangfuseSpanProcessor({
    publicKey: setting("LANGFUSE_PUBLIC_KEY"),
    secretKey: setting("LANGFUSE_SECRET_KEY"),
    baseUrl: setting("LANGFUSE_BASE_URL"),
    environment: "workshop",
  });
  const sdk = new NodeSDK({ serviceName: service, spanProcessors: [processor] });
  sdk.start();
  return async () => {
    await processor.forceFlush();
    await sdk.shutdown();
  };
}
