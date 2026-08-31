export const MINT_ERROR_CODES = {
  definitionUncertified: "MINT_DEFINITION_UNCERTIFIED",
  definitionMismatch: "MINT_DEFINITION_MISMATCH",
  projectPaused: "MINT_PROJECT_PAUSED",
  phasePaused: "MINT_PHASE_PAUSED",
  payloadUnavailable: "MINT_PAYLOAD_UNAVAILABLE",
} as const;

export type MintErrorCode = typeof MINT_ERROR_CODES[keyof typeof MINT_ERROR_CODES];

export class MintSafetyError extends Error {
  constructor(public readonly code: MintErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MintSafetyError";
  }
}

export function mintErrorCode(error: unknown): MintErrorCode | undefined {
  if (error instanceof MintSafetyError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return Object.values(MINT_ERROR_CODES).find((code) => message.includes(`[${code}]`));
}
