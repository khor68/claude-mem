/**
 * The corpus agent: what answers a question about a knowledge corpus.
 *
 * There are two of them, and which one runs is the owner's choice, not the
 * code's. A corpus answered through the Anthropic Agent SDK spends the
 * owner's Claude subscription. An install that selected an API provider
 * expects its corpus work to run there, so the API agent answers the same
 * questions over chat completions.
 *
 * The Claude agent's module imports `@anthropic-ai/claude-agent-sdk` at the
 * top level, so it is imported here dynamically and only on the Claude
 * branch. On an API provider the Anthropic SDK is never loaded at all: an
 * install that routed away from that account does not even open it.
 */

import { resolveSelectedApiProvider, type ApiProviderId } from '../../agent-runner/api-agent.js';
import { logger } from '../../../utils/logger.js';
import { ApiCorpusAgent } from './ApiCorpusAgent.js';
import type { CorpusStore } from './CorpusStore.js';
import type { CorpusFile, KnowledgeAgentCallOptions, QueryResult } from './types.js';

/**
 * The contract every corpus agent keeps: prime a corpus, answer a question
 * about it, prime it again. The Agent SDK agent and the API agent both
 * satisfy it exactly, so the route does not know which one it holds.
 */
export interface CorpusAgent {
  /** Load the corpus and return the session id it is now answerable under. */
  prime(corpus: CorpusFile, callOptions?: KnowledgeAgentCallOptions): Promise<string>;
  /** Answer a question from the corpus. */
  query(corpus: CorpusFile, question: string, callOptions?: KnowledgeAgentCallOptions): Promise<QueryResult>;
  /** Prime the corpus again, replacing the session it was primed under. */
  reprime(corpus: CorpusFile, callOptions?: KnowledgeAgentCallOptions): Promise<string>;
}

/** A corpus agent that picks the implementation per call; `current` names the one a call would use now. */
export interface ProviderCorpusAgent extends CorpusAgent {
  current(): Promise<CorpusAgent>;
}

/**
 * The corpus agent for the selected provider, chosen on every call.
 *
 * The provider is read when a prime or a query starts, not once at worker
 * start: an owner who switches from Claude to an API provider must not keep
 * spending the Anthropic plan on corpus work until the next restart. (The My
 * Work refresh reads the settings on every run for the same reason.)
 *
 * `settingsPath` is the settings file the provider is read from; it defaults
 * to the one the worker uses.
 */
export async function createCorpusAgent(
  corpusStore: CorpusStore,
  settingsPath?: string,
): Promise<ProviderCorpusAgent> {
  const apiAgents = new Map<ApiProviderId, ApiCorpusAgent>();
  let claudeAgent: Promise<CorpusAgent> | null = null;

  const select = async (): Promise<CorpusAgent> => {
    const provider = resolveSelectedApiProvider(settingsPath);
    if (provider) {
      let agent = apiAgents.get(provider);
      if (!agent) {
        logger.info('WORKER', `Corpus agent runs on the selected provider (${provider})`);
        agent = new ApiCorpusAgent(corpusStore, provider, settingsPath);
        apiAgents.set(provider, agent);
      }
      return agent;
    }
    // Only now is the Anthropic Agent SDK loaded, and only on this branch.
    claudeAgent ??= import('./KnowledgeAgent.js').then(({ KnowledgeAgent }) => new KnowledgeAgent(corpusStore));
    return claudeAgent;
  };

  return {
    current: select,
    prime: async (corpus, callOptions) => (await select()).prime(corpus, callOptions),
    query: async (corpus, question, callOptions) => (await select()).query(corpus, question, callOptions),
    reprime: async (corpus, callOptions) => (await select()).reprime(corpus, callOptions),
  };
}
