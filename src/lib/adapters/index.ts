import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { evmContractV1 } from "./evm-contract-v1";
import { openseaSeaDropV1 } from "./opensea-seadrop-v1";
import { openseaSignedSeaDropV1 } from "./opensea-signed-seadrop-v1";
import { squiggleWuiggleV1 } from "./squiggle-wuiggle-v1";
import { bullsRunnersV1 } from "./bulls-runners-v1";
import { terminalAssistantsV1 } from "./terminal-assistants-v1";
import { reviewedCallV1 } from "./reviewed-call-v1";
import type { MintAdapter, ResolvedMint, SupportedCollection } from "./types";
import { executionManifestFor } from "@/lib/engines";

const registry = new Map<string, MintAdapter>([
  [evmContractV1.key, evmContractV1],
  [openseaSeaDropV1.key, openseaSeaDropV1],
  [openseaSignedSeaDropV1.key, openseaSignedSeaDropV1],
  [squiggleWuiggleV1.key, squiggleWuiggleV1],
  [bullsRunnersV1.key, bullsRunnersV1],
  [terminalAssistantsV1.key, terminalAssistantsV1],
  [reviewedCallV1.key, reviewedCallV1],
]);

function normalizeDomain(value: string) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function parseDomains(raw: string): string[] {
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((item):item is string=>typeof item==="string").map(normalizeDomain) : []; }
  catch { return []; }
}

function safeUrl(input: string): URL | null {
  try { const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`; const url = new URL(candidate); return ["http:","https:"].includes(url.protocol) ? url : null; }
  catch { return null; }
}

function normalizePath(value: string): string {
  const path = value.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return path || "/";
}

export function exactUrlPathMatches(pathname: string, expected: string): boolean {
  return normalizePath(pathname).toLowerCase() === normalizePath(expected).toLowerCase();
}

function urlMatches(collection: SupportedCollection, url: URL): boolean {
  const hostname = normalizeDomain(url.hostname);
  if (!parseDomains(collection.domains).some((domain) => hostname === domain)) return false;
  try {
    const config = JSON.parse(collection.adapterConfig || "{}") as { urlMatchers?: Array<{ domain?: string; path?: string; pathPrefix?: string }> };
    if (!config.urlMatchers?.length) return true;
    return config.urlMatchers.some((matcher) => {
      if (!matcher.domain || normalizeDomain(matcher.domain) !== hostname) return false;
      const reviewedPath = matcher.path || matcher.pathPrefix;
      return !reviewedPath || exactUrlPathMatches(url.pathname, reviewedPath);
    });
  } catch { return false; }
}

async function activeCollections(): Promise<SupportedCollection[]> {
  return db.select().from(schema.collections).where(and(eq(schema.collections.active,true),eq(schema.collections.verified,true)));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ranked, deterministic project-name search. URL and contract resolution stay exact. */
export function searchCollectionsByName<T extends Pick<SupportedCollection, "name" | "slug">>(
  collections: T[],
  rawQuery: string,
): T[] {
  const query = normalizeSearchText(rawQuery);
  if (query.length < 2) return [];
  const compactQuery = query.replace(/ /g, "");

  return collections
    .map((collection) => {
      const name = normalizeSearchText(collection.name);
      const slug = normalizeSearchText(collection.slug || "");
      const compactName = name.replace(/ /g, "");
      const compactSlug = slug.replace(/ /g, "");
      const words = `${name} ${slug}`.split(" ").filter(Boolean);
      let score = Number.POSITIVE_INFINITY;
      if (query === name || query === slug) score = 0;
      else if (compactQuery === compactName || compactQuery === compactSlug) score = 1;
      else if (words.some((word) => word === query)) score = 2;
      else if (words.some((word) => word.startsWith(query))) score = 3;
      else if (name.startsWith(query) || slug.startsWith(query)) score = 4;
      else if (name.includes(query) || slug.includes(query) || compactName.includes(compactQuery) || compactSlug.includes(compactQuery)) score = 5;
      return { collection, score };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.collection.name.localeCompare(right.collection.name))
    .map((item) => item.collection);
}

export async function resolveMintInput(rawInput: string): Promise<ResolvedMint | { supported:false; reason:string }> {
  const input = rawInput.trim();
  if (!input || input.length > 2048) return { supported:false, reason:"Enter a valid mint URL, contract, or project name" };
  const collections = await activeCollections();
  let match: SupportedCollection | undefined;
  let source: ResolvedMint["source"] = "name";
  const isAddress = Boolean(ethers.isAddress(input));
  if (isAddress) {
    source = "contract";
    match = collections.find((item) => {
      if (item.contractAddress.toLowerCase() === input.toLowerCase()) return true;
      try {
        const config = JSON.parse(item.adapterConfig || "{}") as { contractAliases?: string[] };
        return config.contractAliases?.some((address) => ethers.isAddress(address) && address.toLowerCase() === input.toLowerCase()) || false;
      } catch { return false; }
    });
  } else {
    const url = safeUrl(input);
    if (url && (input.includes(".") || /^https?:/i.test(input))) {
      source = "url";
      match = collections.find((item)=>urlMatches(item, url));
    } else {
      const matches = searchCollectionsByName(collections, input);
      const normalizedInput = normalizeSearchText(input);
      const compactInput = normalizedInput.replace(/ /g, "");
      const exactMatch = matches.find((item) => {
        const name = normalizeSearchText(item.name);
        const slug = normalizeSearchText(item.slug || "");
        return normalizedInput === name || normalizedInput === slug || compactInput === name.replace(/ /g, "") || compactInput === slug.replace(/ /g, "");
      });
      if (exactMatch) match = exactMatch;
      else if (matches.length > 1) {
        return {
          supported:false,
          reason:`Multiple supported mints match: ${matches.slice(0, 4).map((item) => item.name).join(", ")}. Type a more specific name.`,
        };
      } else match = matches[0];
    }
  }
  if (!match) return { supported:false, reason:"This mint is not supported yet" };
  const adapter = registry.get(match.adapterKey);
  if (!adapter) return { supported:false, reason:"This mint adapter is unavailable" };
  // Fail closed before any project reaches eligibility, preparation, or the
  // scheduler unless its reusable V2 execution engine is explicit and agrees
  // with the reviewed transaction adapter.
  const manifest = executionManifestFor(match);
  const resolved = await adapter.resolve(match, source);
  return {
    ...resolved,
    execution: {
      onePerTransaction: manifest.onePerTransaction === true,
      maxPreparedTransactions: manifest.maxPreparedTransactions,
    },
  };
}

export function supportedAdapterKeys() { return [...registry.keys()]; }

export function getMintAdapter(key: string): MintAdapter | undefined { return registry.get(key); }
