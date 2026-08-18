export type ExecutionEngineKey =
  | "scheduled-public-v1"
  | "scheduled-server-signed-v1"
  | "stealth-owner-switch-v1"
  | "custom-reviewed-v1";

export type DetectionMode = "precise-timer" | "provider-payload" | "owner-switch";
export type PreparationMode = "static-prearm" | "payload-warm" | "switch-gated";
export type BroadcastMode = "sequencer-first" | "private-relay-optional" | "standard";

export type ExecutionEngineProfile = {
  key: ExecutionEngineKey;
  detection: DetectionMode;
  preparation: PreparationMode;
  broadcast: BroadcastMode;
  supportsNonceLadder: boolean;
  requiresDedicatedWalletForLadder: boolean;
  launchTimeGasEstimation: boolean;
  finalPinnedStateRequired: boolean;
};

export type ExecutionManifest = {
  engine: ExecutionEngineKey;
  onePerTransaction?: boolean;
  maxPreparedTransactions?: number;
};
