import type { JobSignals, NormalizedJob } from "./types.js";

type SignalInput = Pick<NormalizedJob, "title" | "company" | "location" | "description" | "tags">;
type JobCategory = JobSignals["categories"][number];
type JobDomain = JobSignals["domains"][number];

interface CategoryRule {
  category: JobCategory;
  domain: JobDomain;
  terms: string[];
}

const categoryRules: CategoryRule[] = [
  { category: "ai-agents", domain: "ai", terms: ["ai agent", "ai agents", "agentic", "model context protocol", "mcp", "a2a"] },
  { category: "ai-infrastructure", domain: "ai", terms: ["artificial intelligence", "machine learning", "generative ai", "llm", "inference", "foundation model", "gpu"] },
  { category: "ai-data-evals", domain: "ai", terms: ["rag", "retrieval augmented generation", "evaluation", "evals", "model monitoring", "data labeling"] },
  { category: "ai-safety-governance", domain: "ai", terms: ["ai safety", "responsible ai", "model governance", "alignment", "red teaming"] },
  { category: "robotics", domain: "ai", terms: ["robotics", "autonomous systems", "computer vision"] },
  { category: "web3-protocols", domain: "web3", terms: ["web3", "blockchain", "crypto", "ethereum", "solana", "base", "layer 1", "layer 2", "smart contract", "protocol"] },
  { category: "defi", domain: "web3", terms: ["defi", "decentralized finance", "liquidity", "staking", "yield protocol"] },
  { category: "depin", domain: "web3", terms: ["depin", "decentralized physical infrastructure"] },
  { category: "wallets-custody", domain: "web3", terms: ["wallet", "custody", "multisig", "account abstraction"] },
  { category: "exchanges-markets", domain: "web3", terms: ["crypto exchange", "digital assets", "market maker", "trading venue"] },
  { category: "web3-developer-infrastructure", domain: "web3", terms: ["rpc", "indexer", "oracle", "web3 developer", "blockchain infrastructure"] },
  { category: "gaming-metaverse", domain: "web3", terms: ["web3 gaming", "blockchain gaming", "metaverse", "gamefi"] },
  { category: "agentic-commerce", domain: "ai", terms: ["x402", "agent payments", "agentic commerce", "machine payments"] },
];

const technologyRules: Array<{ label: string; terms: string[] }> = [
  { label: "MCP", terms: ["mcp", "model context protocol"] },
  { label: "A2A", terms: ["a2a", "agent to agent"] },
  { label: "x402", terms: ["x402"] },
  { label: "LLMs", terms: ["llm", "large language model"] },
  { label: "RAG", terms: ["rag", "retrieval augmented generation"] },
  { label: "Ethereum", terms: ["ethereum"] },
  { label: "Base", terms: ["base"] },
  { label: "Solana", terms: ["solana"] },
];

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

  for (const rule of categoryRules) {
    const hits = rule.terms.filter((term) => contains(corpus, term));
    if (!hits.length) continue;
    categories.add(rule.category);
    domains.add(rule.domain);
    hits.forEach((term) => matchedTerms.add(term));
  }

  if (contains(corpus, "ai")) {
    domains.add("ai");
    matchedTerms.add("ai");
  }

  const technologies = technologyRules
    .filter((rule) => rule.terms.some((term) => contains(corpus, term)))
    .map((rule) => rule.label);
  const signalCount = matchedTerms.size;

  return {
    domains: [...domains],
    categories: [...categories],
    technologies,
    matched_terms: [...matchedTerms],
    confidence: signalCount >= 3 ? "high" : signalCount === 2 ? "medium" : signalCount === 1 ? "low" : "none",
  };
}
