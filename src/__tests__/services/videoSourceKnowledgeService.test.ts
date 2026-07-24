import {
  assessSourceIdentity,
  resolveSourceKnowledge,
  type KnowledgeCache,
  type SourceIdentityProposal,
  type WikipediaArticle,
} from '../../services/videoSourceKnowledgeService';

const RICK_PROPOSAL: SourceIdentityProposal = {
  title: 'Rick and Morty',
  characterNames: ['Rick', 'Morty'],
  evidenceQuotes: ['Rick comes home', 'Morty looks shocked'],
  confidence: 0.96,
};

const RICK_ARTICLE: WikipediaArticle = {
  title: 'Rick and Morty',
  extract: 'Rick and Morty is an animated series following Rick Sanchez and Morty Smith.',
  url: 'https://en.wikipedia.org/wiki/Rick_and_Morty',
};

describe('videoSourceKnowledgeService identity gate', () => {
  it('never accepts model confidence without independent source corroboration', () => {
    const assessment = assessSourceIdentity(RICK_PROPOSAL, RICK_ARTICLE, 'An unrelated scene');
    expect(assessment.accepted).toBe(false);
    expect(assessment.rejectionReason).toBe('insufficient_independent_corroboration');
    expect(assessment.confidence).toBeLessThan(0.9);
  });

  it('rejects a near or wrong Wikipedia title even when characters overlap', () => {
    const assessment = assessSourceIdentity(RICK_PROPOSAL, {
      ...RICK_ARTICLE,
      title: 'Rick and Morty: The Anime',
    }, 'Rick and Morty talk in the garage');
    expect(assessment.accepted).toBe(false);
    expect(assessment.rejectionReason).toBe('wikipedia_title_mismatch');
  });

  it('accepts an exact title explicitly corroborated by source text', () => {
    const assessment = assessSourceIdentity(
      RICK_PROPOSAL,
      RICK_ARTICLE,
      'The user says this is Rick and Morty. Rick comes home.',
    );
    expect(assessment.accepted).toBe(true);
    expect(assessment.confidence).toBeGreaterThanOrEqual(0.9);
    expect(assessment.matchedSignals).toContain('title_in_source_text');
    expect(assessment.matchedCharacterNames).toContain('Rick');
  });

  it('requires more than one shared character when the title is not in source text', () => {
    const proposal: SourceIdentityProposal = {
      title: 'Galactic Family',
      characterNames: ['Alice', 'Bob'],
      evidenceQuotes: [],
      confidence: 0.98,
    };
    const article: WikipediaArticle = {
      title: 'Galactic Family (TV series)',
      extract: 'The series follows Alice, Bob, and their crew.',
      url: 'https://en.wikipedia.org/wiki/Galactic_Family_(TV_series)',
    };
    expect(assessSourceIdentity(proposal, article, 'Alice enters the room').accepted).toBe(false);
    const accepted = assessSourceIdentity(proposal, article, 'Alice enters. Bob calls to her.');
    expect(accepted.accepted).toBe(true);
    expect(accepted.matchedCharacterNames).toEqual(['Alice', 'Bob']);
  });
});

describe('videoSourceKnowledgeService Wikipedia resolution', () => {
  const cacheValues = new Map<string, string>();
  const cache: KnowledgeCache = {
    get: jest.fn(async (key) => cacheValues.get(key) ?? null),
    set: jest.fn(async (key, value) => { cacheValues.set(key, value); }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cacheValues.clear();
  });

  it('fetches only an exact Wikipedia result and caches the bounded article', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { search: [{ title: 'Rick and Morty' }, { title: 'Rick and Morty: The Anime' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { pages: [{ title: 'Rick and Morty', extract: RICK_ARTICLE.extract }] },
      }), { status: 200 })) as unknown as typeof fetch;

    const first = await resolveSourceKnowledge({
      proposal: RICK_PROPOSAL,
      subtitleText: 'This is Rick and Morty. Rick comes home and Morty reacts.',
    }, { fetchImpl, cache });
    const second = await resolveSourceKnowledge({
      proposal: RICK_PROPOSAL,
      subtitleText: 'This is Rick and Morty. Rick comes home and Morty reacts.',
    }, { fetchImpl, cache });

    expect(first).toEqual(expect.objectContaining({
      source: 'wikipedia',
      title: 'Rick and Morty',
      allowedCharacterNames: ['Rick', 'Morty'],
    }));
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('fails open when Wikipedia is unavailable or malformed', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(resolveSourceKnowledge({
      proposal: RICK_PROPOSAL,
      subtitleText: 'Rick and Morty',
    }, { fetchImpl, cache: null })).resolves.toBeNull();
  });

  it('does not let user context act as circular identity corroboration', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { search: [{ title: 'Rick and Morty' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: { pages: [{ title: 'Rick and Morty', extract: RICK_ARTICLE.extract }] },
      }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveSourceKnowledge({
      proposal: RICK_PROPOSAL,
    }, { fetchImpl, cache: null })).resolves.toBeNull();
  });

  it('does not spend a Wikipedia request on a low-confidence proposal', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(resolveSourceKnowledge({
      proposal: { ...RICK_PROPOSAL, confidence: 0.89 },
      subtitleText: 'Rick and Morty',
    }, { fetchImpl, cache: null })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
