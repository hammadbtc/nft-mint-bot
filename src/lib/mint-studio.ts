export type StudioDraftFields = {
  id: string;
  name: string;
  slug: string;
  chainId: string;
  contractAddress: string;
  siteUrl: string;
  domains: string;
  imageUrl: string;
  mintMethod: string;
  mintAbi: string;
  mintPrice: string;
  maxPerWallet: string;
  maxSupply: string;
  paymentToken: string;
  adapterKey: string;
  adapterConfig: string;
};

export const emptyStudioDraft: StudioDraftFields = {
  id: "",
  name: "",
  slug: "",
  chainId: "1",
  contractAddress: "",
  siteUrl: "",
  domains: "",
  imageUrl: "",
  mintMethod: "",
  mintAbi: "[]",
  mintPrice: "",
  maxPerWallet: "",
  maxSupply: "",
  paymentToken: "",
  adapterKey: "reviewed-call-v1",
  adapterConfig: JSON.stringify({
    schemaVersion: 1,
    engine: "custom-reviewed-v1",
    phases: [],
  }, null, 2),
};

export function parseStudioJson(value: string, label: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON`); }
}

export function studioDomains(value: string): string[] {
  const domains = value.split(/[\n,]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set(domains)];
}

function optionalPositiveInteger(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

export function buildStudioDraftPayload(fields: StudioDraftFields): Record<string, unknown> {
  const chainId = Number(fields.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Chain ID must be a positive integer");
  const domains = studioDomains(fields.domains);
  if (!domains.length) throw new Error("At least one exact mint domain is required");
  const mintAbi = parseStudioJson(fields.mintAbi, "Mint ABI");
  if (!Array.isArray(mintAbi) || !mintAbi.length) throw new Error("Mint ABI must contain at least one entry");
  const adapterConfig = parseStudioJson(fields.adapterConfig, "Adapter configuration");
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) {
    throw new Error("Adapter configuration must be a JSON object");
  }
  if (fields.mintPrice && !/^\d+$/.test(fields.mintPrice)) throw new Error("Mint price must be decimal wei");

  return {
    ...(fields.id.trim() ? { id: fields.id.trim() } : {}),
    name: fields.name.trim(),
    slug: fields.slug.trim(),
    chainId,
    contractAddress: fields.contractAddress.trim(),
    siteUrl: fields.siteUrl.trim(),
    domains,
    ...(fields.imageUrl.trim() ? { imageUrl: fields.imageUrl.trim() } : {}),
    mintMethod: fields.mintMethod.trim(),
    mintAbi,
    ...(fields.mintPrice ? { mintPrice: fields.mintPrice } : {}),
    ...(fields.maxPerWallet ? { maxPerWallet: optionalPositiveInteger(fields.maxPerWallet, "Max per wallet") } : {}),
    ...(fields.maxSupply ? { maxSupply: optionalPositiveInteger(fields.maxSupply, "Max supply") } : {}),
    ...(fields.paymentToken.trim() ? { paymentToken: fields.paymentToken.trim() } : {}),
    adapterKey: fields.adapterKey,
    adapterConfig,
  };
}

export function studioDraftFromResolver(draft: Record<string, unknown>, current: StudioDraftFields): StudioDraftFields {
  const domains = Array.isArray(draft.domains) ? draft.domains.map(String).join("\n") : current.domains;
  const abi = typeof draft.mintAbi === "string" ? draft.mintAbi : JSON.stringify(draft.mintAbi ?? [], null, 2);
  return {
    ...current,
    name: typeof draft.name === "string" ? draft.name : current.name,
    slug: typeof draft.slug === "string" ? draft.slug : current.slug,
    chainId: draft.chainId == null ? current.chainId : String(draft.chainId),
    contractAddress: typeof draft.contractAddress === "string" ? draft.contractAddress : current.contractAddress,
    siteUrl: typeof draft.siteUrl === "string" ? draft.siteUrl : current.siteUrl,
    domains,
    imageUrl: typeof draft.imageUrl === "string" ? draft.imageUrl : current.imageUrl,
    mintMethod: typeof draft.mintMethod === "string" ? draft.mintMethod : current.mintMethod,
    mintAbi: abi,
    mintPrice: draft.mintPrice == null ? current.mintPrice : String(draft.mintPrice),
    maxPerWallet: draft.maxPerWallet == null ? current.maxPerWallet : String(draft.maxPerWallet),
    maxSupply: draft.maxSupply == null ? current.maxSupply : String(draft.maxSupply),
    paymentToken: typeof draft.paymentToken === "string" ? draft.paymentToken : current.paymentToken,
    adapterKey: typeof draft.adapterKey === "string" ? draft.adapterKey : current.adapterKey,
    adapterConfig: JSON.stringify(draft.adapterConfig ?? {}, null, 2),
  };
}

export function certificationCommand(versionId: string): string {
  return `npm run support:certify-definition -- ${versionId} ./certification-transaction.json > ./certification-evidence.json`;
}
