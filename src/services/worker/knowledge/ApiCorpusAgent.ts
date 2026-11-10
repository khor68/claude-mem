/**
 * The corpus agent for an API provider.
 *
 * The knowledge corpus used to answer only through the Anthropic Agent SDK,
 * which spends the owner's Claude subscription. An install that chose
 * OpenRouter (or any OpenAI-compatible endpoint) had its corpus work run on
 * the account it routed away from — the very account the selection was meant
 * to stop paying. This agent answers the same corpus questions over chat
 * completions instead, on the provider the settings name.
 *
 * It never falls back to Claude. A provider that refuses (401, 402, 429)
 * fails the question with that refusal: another account is not an authorized
 * substitute, and a corpus question is not worth an unrequested spend.
 *
 * There is no session to resume, so the "session" is a synthetic id over the
 * corpus version: `api:<provider>:<hash of name and updated_at>`. It changes
 * when the corpus is rebuilt, so a query against a corpus that changed since
 * it was primed reports the same "not primed" answer the Agent SDK path
 * reports, instead of answering from a corpus the reader never saw.
 */

import { createHash } from 'node:crypto';
import {
  ApiProviderError,
  askApiTarget,
  resolveApiTarget,
  type ApiProviderId,
  type ApiTarget,
} from '../../agent-runner/api-agent.js';
import { logger } from '../../../utils/logger.js';
import { AppError } from '../../server/ErrorHandler.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusStore } from './CorpusStore.js';
import type { CorpusFile, CorpusObservation, KnowledgeAgentCallOptions, QueryResult } from './types.js';

/** The prefix every synthetic corpus session id carries. */
const API_SESSION_PREFIX = 'api:';

/**
 * How much of the corpus one question may carry. The provider's context
 * window is not known here, so the budget is a fixed, modest one: the corpus
 * excerpt is evidence for one answer, not a transcript to reason over.
 */
const CORPUS_CONTEXT_TOKEN_BUDGET = 12_000;

/**
 * Words that carry no retrieval signal. Without them every question matches
 * every observation on "the" and the selection picks by noise.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
  'whom', 'how', 'why', 'when', 'where', 'did', 'do', 'does', 'done', 'i', 'we', 'you', 'my', 'our',
  'your', 'about', 'from', 'by', 'as', 'at', 'so', 'if', 'not', 'no', 'yes', 'can', 'could',
  'would', 'should', 'there', 'their', 'them', 'they', 'he', 'she', 'his', 'her', 'has', 'have',
  'had', 'just', 'also', 'more', 'most', 'some', 'any', 'all', 'into', 'than', 'then', 'use',
  'used', 'using', 'get', 'got', 'make', 'made', 'was', 'were', 'been', 'being', 'am', 's',
]);

/** The terms of a question: lowercased words, minus the ones that say nothing. */
function questionTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(term => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(terms)];
}

/**
 * The weight a field's words carry when they match the question. A title or a
 * concept says more about a topic than a sentence of narrative does.
 */
const FIELD_WEIGHTS: Array<{ text: (observation: CorpusObservation) => string; weight: number }> = [
  { text: observation => observation.title, weight: 4 },
  { text: observation => observation.concepts.join(' '), weight: 3 },
  { text: observation => observation.subtitle ?? '', weight: 3 },
  { text: observation => observation.facts.join(' '), weight: 2 },
  { text: observation => observation.type, weight: 2 },
  { text: observation => observation.narrative ?? '', weight: 1 },
  { text: observation => observation.files_read.join(' '), weight: 1 },
  { text: observation => observation.files_modified.join(' '), weight: 1 },
  { text: observation => observation.project, weight: 1 },
];

/**
 * How well an observation answers a question. Whole-word matches score the
 * field's weight; a question word that is the start of an observation word
 * ("auth" in "authentication") scores half of it. No network, no model: the
 * selection is the same on every run, so the same question sends the same
 * evidence.
 */
function scoreObservation(observation: CorpusObservation, terms: string[]): number {
  const weights = new Map<string, number>();
  for (const field of FIELD_WEIGHTS) {
    for (const token of field.text(observation).toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
      if (!token) continue;
      const current = weights.get(token);
      if (current === undefined || field.weight > current) weights.set(token, field.weight);
    }
  }

  let score = 0;
  for (const term of terms) {
    const exact = weights.get(term);
    if (exact !== undefined) {
      score += exact;
      continue;
    }
    if (term.length < 3) continue;
    for (const [token, weight] of weights) {
      if (token.startsWith(term)) {
        score += weight * 0.5;
        break;
      }
    }
  }
  return score;
}

/**
 * The observations that may answer this question, best first, within the
 * token budget.
 *
 * A question that matches nothing falls back to the most recent observations
 * rather than to an empty context: the answer then says the corpus does not
 * hold the answer, which is the truth, instead of the model answering from
 * what it happens to know.
 */
function selectObservations(
  corpus: CorpusFile,
  question: string,
  renderer: CorpusRenderer,
  budgetTokens: number = CORPUS_CONTEXT_TOKEN_BUDGET,
): CorpusObservation[] {
  const terms = questionTerms(question);
  const scored = corpus.observations.map(observation => ({ observation, score: scoreObservation(observation, terms) }));
  const matching = scored.filter(entry => entry.score > 0);

  const ordered = (matching.length > 0 ? matching : scored).slice().sort((a, b) =>
    b.score - a.score
    || b.observation.created_at_epoch - a.observation.created_at_epoch
    || a.observation.id - b.observation.id);

  const selected: CorpusObservation[] = [];
  let usedTokens = 0;
  for (const entry of ordered) {
    const tokens = renderer.estimateTokens(renderer.renderObservation(entry.observation));
    // The first observation always goes in: a corpus whose best match alone
    // exceeds the budget still answers better than an empty context.
    if (selected.length > 0 && usedTokens + tokens > budgetTokens) break;
    selected.push(entry.observation);
    usedTokens += tokens;
  }
  return selected;
}

/**
 * The synthetic session id of a corpus version on a provider.
 *
 * The hash covers the corpus name and its `updated_at`, so a rebuilt corpus
 * (which gets a new `updated_at`) no longer matches the id it was primed
 * with, and a query against it reports "not primed" instead of answering from
 * a corpus version the reader never saw.
 */
export function apiCorpusSessionId(provider: ApiProviderId, corpus: CorpusFile): string {
  const digest = createHash('sha256')
    .update(`${corpus.name}|${corpus.updated_at}`)
    .digest('hex')
    .slice(0, 16);
  return `${API_SESSION_PREFIX}${provider}:${digest}`;
}

export class ApiCorpusAgent {
  private readonly renderer = new CorpusRenderer();

  constructor(
    private readonly corpusStore: CorpusStore,
    private readonly provider: ApiProviderId,
    private readonly settingsPath?: string,
  ) {}

  async prime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    const target = this.requireTarget();
    const prompt = [
      'Here is the summary of a knowledge corpus you will answer questions from.',
      '',
      this.renderCorpusSummary(corpus),
      '',
      'Acknowledge in one sentence that this corpus is loaded. Do not answer any question yet.',
    ].join('\n');

    try {
      await askApiTarget(target, prompt, {
        systemPrompt: this.systemPrompt(corpus),
        abortSignal: callOptions.abortController?.signal,
      });
    } catch (error) {
      throw this.providerError('prime', error);
    }

    // A prime the caller abandoned is not a prime: nothing is written, so no
    // later query can spend on a corpus the owner never finished loading.
    callOptions.abortController?.signal.throwIfAborted();

    const sessionId = apiCorpusSessionId(this.provider, corpus);
    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);
    logger.info('WORKER', `Corpus agent primed for corpus "${corpus.name}" on ${this.provider}`);
    return sessionId;
  }

  async query(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions = {}): Promise<QueryResult> {
    const sessionId = this.requireSessionId(corpus);
    const target = this.requireTarget();

    const selected = selectObservations(corpus, question, this.renderer);
    const prompt = [
      'Here is the part of the knowledge corpus that may answer the question.',
      '',
      selected.map(observation => this.renderer.renderObservation(observation)).join('\n'),
      '',
      `Question: ${question}`,
      '',
      'Answer the question using only the observations above, and name the observations you used. If they do not answer the question, say that the corpus does not hold the answer.',
    ].join('\n');

    let answer: string;
    try {
      answer = await askApiTarget(target, prompt, {
        systemPrompt: this.systemPrompt(corpus),
        abortSignal: callOptions.abortController?.signal,
      });
    } catch (error) {
      throw this.providerError('query', error);
    }

    return { answer, session_id: sessionId };
  }

  async reprime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    corpus.session_id = null;
    return this.prime(corpus, callOptions);
  }

  /**
   * The session id of a corpus that is primed for this provider and version.
   *
   * The same answer the Agent SDK path gives for a corpus that was never
   * primed: a 409 `CORPUS_NOT_PRIMED`, which the route answers as such.
   */
  private requireSessionId(corpus: CorpusFile): string {
    const expected = apiCorpusSessionId(this.provider, corpus);
    const current = corpus.session_id;
    if (!current || !current.startsWith(API_SESSION_PREFIX) || current !== expected) {
      throw new AppError(`Corpus "${corpus.name}" has no session — call prime first`, 409, 'CORPUS_NOT_PRIMED');
    }
    return current;
  }

  /**
   * The endpoint, key and model of the selected provider. A provider that is
   * selected but has no key is still the provider: the work fails there with
   * that provider's own complaint, never on another account.
   */
  private requireTarget(): ApiTarget {
    const resolution = resolveApiTarget(this.settingsPath);
    if (!resolution.target) {
      throw new AppError(
        `The selected provider cannot answer for this corpus: ${resolution.reason}`,
        401,
        'PROVIDER_NOT_AUTHENTICATED',
      );
    }
    return resolution.target;
  }

  /**
   * A provider refusal in the route's own shape: a 401 or 403 is the owner's
   * to fix, a 402 is an account with no credit, a 429 is a quota that is
   * gone. None of them is retried here and none of them moves the work to
   * another provider.
   */
  private providerError(action: 'prime' | 'query', error: unknown): Error {
    if (error instanceof ApiProviderError) {
      if (error.status === 401 || error.status === 403) {
        return new AppError(`Corpus ${action} failed: ${error.message}`, 401, 'PROVIDER_NOT_AUTHENTICATED');
      }
      if (error.status === 402) {
        return new AppError(`Corpus ${action} failed: ${error.message}`, 402, 'PROVIDER_NO_CREDIT');
      }
      if (error.status === 429) {
        return new AppError(`Corpus ${action} failed: ${error.message}`, 429, 'PROVIDER_QUOTA_EXHAUSTED');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** The corpus's own system prompt, plus what this path needs it to say. */
  private systemPrompt(corpus: CorpusFile): string {
    return [
      corpus.system_prompt,
      'Only the observations quoted in the request are available to you; the corpus may hold more.',
    ].filter(part => part && part.trim()).join('\n\n');
  }

  /** A bounded summary of the corpus: enough to acknowledge, not the whole corpus. */
  private renderCorpusSummary(corpus: CorpusFile): string {
    const concepts = new Set(corpus.observations.flatMap(observation => observation.concepts));
    return [
      `Corpus: ${corpus.name}`,
      corpus.description ? `Description: ${corpus.description}` : '',
      `Observations: ${corpus.stats.observation_count}`,
      `Date range: ${corpus.stats.date_range.earliest} to ${corpus.stats.date_range.latest}`,
      concepts.size > 0 ? `Concepts: ${[...concepts].sort().slice(0, 50).join(', ')}` : '',
    ].filter(line => line).join('\n');
  }
}
