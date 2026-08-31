export type ResolverStatus = "resolved" | "needs-input" | "unsupported";

export type MintResolverInput = {
  platform: string;
  chainId: number;
  contractAddress: string;
  name?: string;
  slug?: string;
  siteUrl?: string;
  domains?: string[];
  feeRecipient?: string;
  providerPayload?: unknown;
};

export type ResolverEvidence = {
  blockNumber: number;
  blockHash: string;
  contractCodeHash: string;
  observations: Record<string, unknown>;
};

export type MintResolverResult = {
  resolverKey: string;
  resolverVersion: string;
  status: ResolverStatus;
  platform: string;
  chainId: number;
  contractAddress: string;
  draft?: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  evidence: ResolverEvidence;
  certificationRequired: true;
};

export type MintResolverDescriptor = {
  key: string;
  version: string;
  label: string;
  mode: "onchain" | "provider-payload" | "manual-plugin";
  support: "qualified" | "prefill-only" | "manual-review";
  notes: string;
};

