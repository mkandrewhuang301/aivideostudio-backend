import { createHash } from 'node:crypto';

const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_USER_AGENT = 'FantasiaVideoSummarizer/1.0';
const LOOKUP_TIMEOUT_MS = 4_000;
const ARTICLE_CACHE_SECONDS = 30 * 24 * 60 * 60;
const NEGATIVE_CACHE_SECONDS = 6 * 60 * 60;
const MAX_ARTICLE_CHARS = 12_000;
const MAX_QUERY_CHARS = 120;
const MEMORY_CACHE_MAX_ENTRIES = 200;

export interface SourceIdentityProposal {
  title: string;
  characterNames: string[];
  evidenceQuotes: string[];
  confidence: number;
}

export interface WikipediaArticle {
  title: string;
  extract: string;
  url: string;
}

export interface SourceIdentityAssessment {
  accepted: boolean;
  confidence: number;
  matchedCharacterNames: string[];
  matchedSignals: string[];
  rejectionReason?: string;
}

export interface ResolvedSourceKnowledge {
  source: 'wikipedia';
  title: string;
  summary: string;
  url: string;
  confidence: number;
  allowedCharacterNames: string[];
  matchedSignals: string[];
}

export interface KnowledgeCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ResolveSourceKnowledgeArgs {
  proposal: SourceIdentityProposal | null;
  subtitleText?: string | null;
  verifiedEvidenceText?: string | null;
  minimumConfidence?: number;
}

export interface ResolveSourceKnowledgeDependencies {
  fetchImpl?: typeof fetch;
  cache?: KnowledgeCache | null;
}

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function normalizeKnowledgeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizedArticleTitle(value: string): string {
  return normalizeKnowledgeText(value.replace(/\s*\([^)]*\)\s*$/, ''));
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 2) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function uniqueBoundedStrings(values: string[], limit: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = raw.trim().slice(0, maxLength);
    const normalized = normalizeKnowledgeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function assessSourceIdentity(
  proposal: SourceIdentityProposal,
  article: WikipediaArticle,
  sourceText: string,
  minimumConfidence = 0.9,
): SourceIdentityAssessment {
  const threshold = clamp01(minimumConfidence);
  const proposalTitle = normalizeKnowledgeText(proposal.title);
  const articleTitle = normalizedArticleTitle(article.title);
  if (!proposalTitle || proposalTitle !== articleTitle) {
    return {
      accepted: false,
      confidence: 0,
      matchedCharacterNames: [],
      matchedSignals: [],
      rejectionReason: 'wikipedia_title_mismatch',
    };
  }
  if (clamp01(proposal.confidence) < threshold) {
    return {
      accepted: false,
      confidence: clamp01(proposal.confidence),
      matchedCharacterNames: [],
      matchedSignals: ['exact_wikipedia_title'],
      rejectionReason: 'planner_confidence_below_threshold',
    };
  }

  const normalizedSource = normalizeKnowledgeText(sourceText);
  const normalizedArticle = normalizeKnowledgeText(article.extract);
  const explicitTitle = containsNormalizedPhrase(normalizedSource, proposalTitle);
  const characterNames = uniqueBoundedStrings(proposal.characterNames, 12, 80);
  const matchedCharacterNames = characterNames.filter((name) => {
    const normalized = normalizeKnowledgeText(name);
    return normalized.length >= 2
      && containsNormalizedPhrase(normalizedSource, normalized)
      && containsNormalizedPhrase(normalizedArticle, normalized);
  });
  const evidenceQuotes = uniqueBoundedStrings(proposal.evidenceQuotes, 8, 180);
  const matchedQuoteCount = evidenceQuotes.filter((quote) => {
    const normalized = normalizeKnowledgeText(quote);
    return normalized.length >= 4 && containsNormalizedPhrase(normalizedSource, normalized);
  }).length;

  const matchedSignals = ['exact_wikipedia_title'];
  if (explicitTitle) matchedSignals.push('title_in_source_text');
  if (matchedCharacterNames.length > 0) {
    matchedSignals.push(`${matchedCharacterNames.length}_characters_in_source_and_article`);
  }
  if (matchedQuoteCount > 0) matchedSignals.push(`${matchedQuoteCount}_evidence_quotes_in_source`);

  const independentlyCorroborated = explicitTitle
    || matchedCharacterNames.length >= 2
    || (matchedCharacterNames.length >= 1 && matchedQuoteCount >= 2);
  if (!independentlyCorroborated) {
    return {
      accepted: false,
      confidence: Math.min(0.89, clamp01(proposal.confidence)),
      matchedCharacterNames,
      matchedSignals,
      rejectionReason: 'insufficient_independent_corroboration',
    };
  }

  const confidence = Math.min(0.99,
    threshold
      + (explicitTitle ? 0.04 : 0)
      + Math.min(0.03, matchedCharacterNames.length * 0.01)
      + Math.min(0.02, matchedQuoteCount * 0.01));
  return { accepted: true, confidence, matchedCharacterNames, matchedSignals };
}

function cacheKeyForTitle(title: string): string {
  const digest = createHash('sha256').update(normalizeKnowledgeText(title)).digest('hex').slice(0, 32);
  return `video-summary:wikipedia:v1:${digest}`;
}

function readMemoryCache(key: string): string | null | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeMemoryCache(key: string, value: string, ttlSeconds: number): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value as string | undefined;
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
}

const defaultCache: KnowledgeCache = {
  async get(key) {
    const local = readMemoryCache(key);
    if (local !== undefined) return local;
    try {
      const { redis } = await import('../redis/client');
      const value = await redis.get(key);
      if (value != null) {
        const ttl = value.includes('"missing":true') ? NEGATIVE_CACHE_SECONDS : ARTICLE_CACHE_SECONDS;
        writeMemoryCache(key, value, ttl);
      }
      return value;
    } catch {
      return null;
    }
  },
  async set(key, value, ttlSeconds) {
    writeMemoryCache(key, value, ttlSeconds);
    try {
      const { redis } = await import('../redis/client');
      await redis.set(key, value, 'EX', ttlSeconds);
    } catch {
      // Redis caching is an optimization. Wikipedia enrichment must continue without it.
    }
  },
};

function wikipediaUrl(params: Record<string, string>): string {
  const search = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  return `${WIKIPEDIA_API_URL}?${search.toString()}`;
}

async function fetchWikipediaJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': WIKIPEDIA_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Wikipedia request failed (${response.status})`);
  return response.json();
}

async function fetchWikipediaArticle(title: string, fetchImpl: typeof fetch): Promise<WikipediaArticle | null> {
  const query = title.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return null;
  const searchRaw = await fetchWikipediaJson(fetchImpl, wikipediaUrl({
    action: 'query',
    list: 'search',
    srsearch: query,
    srnamespace: '0',
    srlimit: '5',
  })) as { query?: { search?: Array<{ title?: unknown }> } };
  const expectedTitle = normalizeKnowledgeText(query);
  const exact = searchRaw.query?.search?.find((result) => (
    typeof result.title === 'string' && normalizedArticleTitle(result.title) === expectedTitle
  ));
  if (!exact || typeof exact.title !== 'string') return null;

  const pageRaw = await fetchWikipediaJson(fetchImpl, wikipediaUrl({
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    redirects: '1',
    titles: exact.title,
  })) as { query?: { pages?: Array<{ title?: unknown; extract?: unknown; missing?: unknown }> } };
  const page = pageRaw.query?.pages?.[0];
  if (!page || page.missing === true || typeof page.title !== 'string' || typeof page.extract !== 'string') {
    return null;
  }
  const extract = page.extract.trim().slice(0, MAX_ARTICLE_CHARS);
  if (!extract) return null;
  return {
    title: page.title,
    extract,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

async function loadWikipediaArticle(
  title: string,
  fetchImpl: typeof fetch,
  cache: KnowledgeCache | null,
): Promise<WikipediaArticle | null> {
  const key = cacheKeyForTitle(title);
  if (cache) {
    const cached = await cache.get(key).catch(() => null);
    if (cached) {
      try {
        const value = JSON.parse(cached) as WikipediaArticle | { missing: true };
        return 'missing' in value ? null : value;
      } catch {
        // Ignore corrupt cache entries and replace them with a fresh bounded response.
      }
    }
  }

  const article = await fetchWikipediaArticle(title, fetchImpl);
  if (cache) {
    await cache.set(
      key,
      JSON.stringify(article ?? { missing: true }),
      article ? ARTICLE_CACHE_SECONDS : NEGATIVE_CACHE_SECONDS,
    ).catch(() => {});
  }
  return article;
}

export async function resolveSourceKnowledge(
  args: ResolveSourceKnowledgeArgs,
  dependencies: ResolveSourceKnowledgeDependencies = {},
): Promise<ResolvedSourceKnowledge | null> {
  const proposal = args.proposal;
  if (!proposal?.title.trim()) return null;
  const minimumConfidence = clamp01(args.minimumConfidence ?? 0.9);
  if (clamp01(proposal.confidence) < minimumConfidence) return null;

  try {
    const article = await loadWikipediaArticle(
      proposal.title,
      dependencies.fetchImpl ?? fetch,
      dependencies.cache === undefined ? defaultCache : dependencies.cache,
    );
    if (!article) return null;
    // User context can help the planner propose a candidate title, but it is deliberately excluded
    // here: using the same user assertion as both proposal and corroboration would be circular.
    const sourceText = [args.subtitleText ?? '', args.verifiedEvidenceText ?? '']
      .filter(Boolean)
      .join('\n');
    const assessment = assessSourceIdentity(proposal, article, sourceText, minimumConfidence);
    if (!assessment.accepted) return null;
    return {
      source: 'wikipedia',
      title: article.title,
      summary: article.extract,
      url: article.url,
      confidence: assessment.confidence,
      allowedCharacterNames: assessment.matchedCharacterNames,
      matchedSignals: assessment.matchedSignals,
    };
  } catch {
    // External context is optional. Network, parsing, and cache failures must never fail a summary.
    return null;
  }
}
