export interface ProviderSubmitRequest {
  prompt: string;
  durationSec: number;
  startImagePath: string | null;
  jobId: string;
}

export type ProviderSubmitResult =
  | { ok: true; providerJobId: string }
  | { ok: false; kind: "rejected" | "ambiguous"; error: string };

export type ProviderPollResult =
  | { status: "running" }
  | { status: "succeeded"; result: string }
  | { status: "failed"; kind: "rejected" | "failed" | "ambiguous"; error: string };

export interface GenerationProvider {
  readonly name: string;
  submit(request: ProviderSubmitRequest): Promise<ProviderSubmitResult>;
  poll(providerJobId: string): Promise<ProviderPollResult>;
}
