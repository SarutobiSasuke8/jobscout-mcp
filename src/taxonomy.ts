import type { JobSignals, NormalizedJob } from "./types.js";

type SignalInput = Pick<NormalizedJob, "title" | "company" | "location" | "description" | "tags">;
type JobCategory = JobSignals["categories"][number];
type JobDomain = JobSignals["domains"][number];

interface CategoryRule {
  category: JobCategory;
  domain: JobDomain;
  /** Terms specific enough to match on their own. */
  terms: string[];
  /**
   * Short forms that are ordinary English in a job advert ("base", "protocol", "wallet") and
   * only mean what we want when the listing is already talking about the domain. They match
   * only when a domain anchor is present, so "Base salary from 28k" in a nursing advert does
   * not become the Base L2, and "infection control protocol" does not become web3-protocols.
   */
  anchoredTerms?: string[];
}

/**
 * Anchors are unambiguous in job-advert English. A listing containing one of these is genuinely
 * discussing the domain, which is what licenses the short forms above.
 */
const domainAnchors: Record<JobDomain, string[]> = {
  ai: [
    "ai", "artificial intelligence", "machine learning", "generative ai", "llm",
    "large language model", "agentic", "ai agent", "ai agents", "mcp", "model context protocol",
  ],
  web3: [
    "web3", "blockchain", "crypto", "ethereum", "solana", "onchain", "on chain",
    "smart contract", "defi", "depin", "gamefi", "staking", "tokenomics",
  ],
};

const categoryRules: CategoryRule[] = [
  { category: "ai-agents", domain: "ai", terms: ["ai agent", "ai agents", "agentic", "model context protocol", "mcp", "a2a"] },
  { category: "ai-infrastructure", domain: "ai", terms: ["artificial intelligence", "machine learning", "generative ai", "llm", "inference", "foundation model", "gpu"] },
  { category: "ai-data-evals", domain: "ai", terms: ["rag", "retrieval augmented generation", "model evaluation", "llm evaluation", "evals", "model monitoring", "data labeling"], anchoredTerms: ["evaluation"] },
  { category: "ai-safety-governance", domain: "ai", terms: ["ai safety", "responsible ai", "model governance", "ai alignment", "model alignment", "red teaming"], anchoredTerms: ["alignment"] },
  { category: "robotics", domain: "ai", terms: ["robotics", "autonomous systems", "computer vision"] },
  { category: "web3-protocols", domain: "web3", terms: ["web3", "blockchain", "crypto", "ethereum", "solana", "layer 1", "layer 2", "smart contract", "base network", "base l2", "base chain", "blockchain protocol"], anchoredTerms: ["base", "protocol"] },
  { category: "defi", domain: "web3", terms: ["defi", "decentralized finance", "liquidity pool", "onchain liquidity", "staking", "yield farming"], anchoredTerms: ["liquidity"] },
  { category: "depin", domain: "web3", terms: ["depin", "decentralized physical infrastructure"] },
  { category: "wallets-custody", domain: "web3", terms: ["crypto wallet", "hardware wallet", "self custody", "digital asset custody", "multisig", "account abstraction"], anchoredTerms: ["wallet", "custody"] },
  { category: "exchanges-markets", domain: "web3", terms: ["crypto exchange", "digital assets", "market maker", "trading venue"] },
  { category: "web3-developer-infrastructure", domain: "web3", terms: ["rpc", "indexer", "blockchain oracle", "price oracle", "web3 developer", "blockchain infrastructure"], anchoredTerms: ["oracle"] },
  { category: "gaming-metaverse", domain: "web3", terms: ["web3 gaming", "blockchain gaming", "metaverse", "gamefi"] },
  { category: "agentic-commerce", domain: "ai", terms: ["x402", "agent payments", "agentic commerce", "machine payments"] },
];

const technologyRules: Array<{ label: string; domain: JobDomain; terms: string[]; anchoredTerms?: string[] }> = [
  { label: "MCP", domain: "ai", terms: ["mcp", "model context protocol"] },
  { label: "A2A", domain: "ai", terms: ["a2a", "agent to agent"] },
  { label: "x402", domain: "ai", terms: ["x402"] },
  { label: "LLMs", domain: "ai", terms: ["llm", "large language model"] },
  { label: "RAG", domain: "ai", terms: ["rag", "retrieval augmented generation"] },
  { label: "Ethereum", domain: "web3", terms: ["ethereum"] },
  { label: "Base", domain: "web3", terms: ["base network", "base l2", "base chain", "base mainnet"], anchoredTerms: ["base"] },
  { label: "Solana", domain: "web3", terms: ["solana"] },
];

/**
 * Terms that are real signal but too weak to justify "high" confidence on their own. Every
 * anchored short form is inherently in this class: it only matched because something else in
 * the listing was already on-domain. Confidence must rest on at least one specific term rather
 * than on an accumulation of weak ones, otherwise the more generic corporate boilerplate a
 * listing carries, the more confident the classifier becomes.
 */
const lowSpecificityTerms = new Set([
  "ai", "gpu", "inference", "evals", "autonomous systems",
  "layer 1", "layer 2", "rpc", "indexer", "metaverse",
  "digital assets", "market maker", "trading venue",
  "base", "protocol", "wallet", "custody", "liquidity", "oracle", "evaluation", "alignment",
]);

function searchable(value: string): string {
  return ` ${value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, " ").trim()} `;
}

function contains(corpus: string, term: string): boolean {
  return corpus.includes(searchable(term));
}

export function classifyJob(input: SignalInput): JobSignals {
  const corpus = searchable([input.title, input.company, input.location, input.description ?? "", ...input.tags].join(" "));
  const matchedTerms = new Set<string>();
  const domains = new Set<JobDomain>();
  const categories = new Set<JobCategory>();

  const anchored: Record<JobDomain, boolean> = {
    ai: domainAnchors.ai.some((term) => contains(corpus, term)),
    web3: domainAnchors.web3.some((term) => contains(corpus, term)),
  };

  const hitsFor = (rule: { domain: JobDomain; terms: string[]; anchoredTerms?: string[] }): string[] => {
    const candidates = anchored[rule.domain] ? [...rule.terms, ...(rule.anchoredTerms ?? [])] : rule.terms;
    return candidates.filter((term) => contains(corpus, term));
  };

  for (const rule of categoryRules) {
    const hits = hitsFor(rule);
    if (!hits.length) continue;
    categories.add(rule.category);
    domains.add(rule.domain);
    hits.forEach((term) => matchedTerms.add(term));
  }

  if (contains(corpus, "ai")) {
    domains.add("ai");
    matchedTerms.add("ai");
  }

  const technologies = technologyRules.filter((rule) => hitsFor(rule).length > 0).map((rule) => rule.label);

  const signalCount = matchedTerms.size;
  const hasSpecificTerm = [...matchedTerms].some((term) => !lowSpecificityTerms.has(term));
  const confidence: JobSignals["confidence"] = signalCount === 0
    ? "none"
    : !hasSpecificTerm
      ? "low"
      : signalCount >= 3
        ? "high"
        : signalCount === 2
          ? "medium"
          : "low";

  return {
    domains: [...domains],
    categories: [...categories],
    technologies,
    matched_terms: [...matchedTerms],
    confidence,
  };
}
