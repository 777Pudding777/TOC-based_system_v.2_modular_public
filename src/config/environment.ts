/**
 * src/config/environment.ts
 * Environment configuration and validation.
 * Reads from Vite environment variables and provides typed access.
 *
 * @module environment
 */

/**
 * Environment configuration interface
 */
export interface EnvironmentConfig {
  /** OpenRouter API key for VLM access */
  openRouterApiKey: string | null;
  /** OpenAI API key (alternative provider) */
  openAiApiKey: string | null;
  /** Tavily API key */
  tavilyApiKey: string | null;
  /** Web fetch proxy URL for regulatory documents */
  webFetchProxyUrl: string | null;
  /** Application title */
  appTitle: string;
  /** Application version */
  appVersion: string;
  /** Is development mode */
  isDevelopment: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Get environment configuration
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  return {
    openRouterApiKey: import.meta.env.VITE_OPENROUTER_API_KEY || null,
    openAiApiKey: import.meta.env.VITE_OPENAI_API_KEY || null,
    tavilyApiKey: import.meta.env.VITE_TAVILY_API_KEY || null,
    webFetchProxyUrl: import.meta.env.VITE_WEB_FETCH_PROXY_URL || null,
    appTitle: import.meta.env.VITE_APP_TITLE || "IFC BIM Visual Compliance Checker",
    appVersion: import.meta.env.VITE_APP_VERSION || "1.0.0",
    isDevelopment: import.meta.env.DEV === true,
  };
}

/**
 * Validate environment configuration
 */
export function validateEnvironment(): ValidationResult {
  const config = getEnvironmentConfig();
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check for API keys
  if (!config.openRouterApiKey && !config.openAiApiKey) {
    warnings.push(
      "No VLM API key configured. Set VITE_OPENROUTER_API_KEY or VITE_OPENAI_API_KEY in .env file."
    );
  }

  // Check OpenRouter key format
  if (config.openRouterApiKey) {
    if (!config.openRouterApiKey.startsWith("sk-or-")) {
      warnings.push("OpenRouter API key should start with 'sk-or-'. Please verify your key.");
    }
  }

  // Check OpenAI key format
  if (config.openAiApiKey) {
    if (!config.openAiApiKey.startsWith("sk-")) {
      warnings.push("OpenAI API key should start with 'sk-'. Please verify your key.");
    }
  }

  // Log validation results in development
  if (config.isDevelopment) {
    if (warnings.length > 0) {
      console.warn("[Environment] Warnings:", warnings);
    }
    if (errors.length > 0) {
      console.error("[Environment] Errors:", errors);
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Check if VLM is configured
 */
export function hasVlmApiKey(): boolean {
  const config = getEnvironmentConfig();
  return !!(config.openRouterApiKey || config.openAiApiKey);
}

/**
 * Get preferred VLM provider based on available keys
 */
export function getPreferredVlmProvider(): "openrouter" | "openai" | "mock" {
  const config = getEnvironmentConfig();
  
  // Prefer OpenRouter if key is available
  if (config.openRouterApiKey) {
    return "openrouter";
  }
  
  if (config.openAiApiKey) {
    return "openai";
  }
  
  return "mock";
}
