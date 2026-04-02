/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * 100% local — rules-based scoring handles all requests in <1ms.
 * Ambiguous cases default to configurable tier (MEDIUM by default).
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types";
import { classifyByRules } from "./rules";
import { selectModel, type ModelPricing } from "./selector";
import { getCustomModels } from "../model-registry";

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing: Map<string, ModelPricing>;
};

/**
 * Route a request to the cheapest capable model.
 *
 * 1. Check overrides (large context, structured output)
 * 2. Run rule-based classifier (14 weighted dimensions, <1ms)
 * 3. If ambiguous, default to configurable tier (no external API calls)
 * 4. Select model for tier
 * 5. Return RoutingDecision with metadata
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const { config, modelPricing } = options;

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);
  // User-only tokens — system prompt (tool defs, instructions) doesn't make
  // the task more complex and shouldn't inflate scoring or force overrides
  const estimatedUserTokens = Math.ceil(prompt.length / 4);

  // --- Rule-based classification (runs first to get agenticScore) ---
  // Pass user-only tokens so scoreTokenCount reflects actual request complexity
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedUserTokens, config.scoring);

  // Determine if agentic tiers should be used:
  // 1. Explicit agenticMode config OR
  // 2. Auto-detected agentic task (agenticScore >= 0.75)
  const agenticScore = ruleResult.agenticScore ?? 0;
  const isAutoAgentic = agenticScore >= 0.75;
  const isExplicitAgentic = config.overrides.agenticMode ?? false;
  const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
  const tierConfigs = useAgenticTiers ? config.agenticTiers! : config.tiers;

  // --- Override: large context → force COMPLEX ---
  // Uses user-only tokens — system prompt tool definitions shouldn't force COMPLEX
  if (estimatedUserTokens > config.overrides.maxTokensForceComplex) {
    const customModels = getCustomModels();
    const allowedModels = customModels.filter((m) => m.tiers.includes("COMPLEX")).map((m) => m.id);
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${useAgenticTiers ? " | agentic" : ""}`,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
      allowedModels,
    );
  }

  // Structured output detection
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;

  let tier: Tier;
  let confidence: number;
  const method: "rules" | "llm" = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    // Ambiguous — default to configurable tier (no external API call)
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }

  // Apply structured output minimum tier
  if (hasStructuredOutput) {
    const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }

  // Add agentic mode indicator to reasoning
  if (isAutoAgentic) {
    reasoning += " | auto-agentic";
  } else if (isExplicitAgentic) {
    reasoning += " | agentic";
  }

  // Collect models that support this tier
  const customModels = getCustomModels();
  const allowedModels = customModels.filter((m) => m.tiers.includes(tier)).map((m) => m.id);

  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
    allowedModels,
  );
}

export { getFallbackChain, getFallbackChainFiltered } from "./selector";
export { DEFAULT_ROUTING_CONFIG } from "./config";
export type { RoutingDecision, Tier, RoutingConfig } from "./types";
export type { ModelPricing } from "./selector";
