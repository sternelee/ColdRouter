/**
 * ColdRouter ProviderPlugin for OpenClaw
 *
 * Registers ColdRouter as an LLM provider in OpenClaw.
 * Uses a local proxy to handle smart routing to provider APIs.
 */

import type { ProviderPlugin } from "./types";
import { buildProviderModels } from "./models";
import type { ProxyHandle } from "./proxy";
import { getCustomModels, toOpenClawModel } from "./model-registry.js";

let activeProxy: ProxyHandle | null = null;

export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

export const coldrouterProvider: ProviderPlugin = {
  id: "coldrouter",
  label: "ColdRouter",
  docsPath: "https://github.com/user/ColdRouter",
  aliases: ["cold"],
  envVars: [],

  get models() {
    const customModels = getCustomModels().map(toOpenClawModel);
    if (!activeProxy) {
      return buildProviderModels("http://127.0.0.1:8403", customModels);
    }
    return buildProviderModels(activeProxy.baseUrl, customModels);
  },

  auth: [],
};
