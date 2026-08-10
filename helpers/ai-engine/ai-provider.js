/**
 * helpers/ai-engine/ai-provider.js - Part 1: Configuration & Prompting
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
const { GEMINI_RESPONSE_SCHEMA } = require('../datasets/response-schemas.js');

// Define the fallback prompt file path (relative to the helpers folder).
const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', 'datasets', 'system_prompt_all.txt');

let cachedDefaultPrompt = null;

function getDefaultSystemPrompt() {
  if (cachedDefaultPrompt !== null) {
    return cachedDefaultPrompt;
  }

  try {
    cachedDefaultPrompt = fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf8').trim();
    console.log('📄 System prompt loaded successfully from dataset.');
  } catch (err) {
    cachedDefaultPrompt = '';
    console.warn(`⚠️ Default system prompt unavailable at ${DEFAULT_PROMPT_PATH}: ${err.message}`);
  }

  return cachedDefaultPrompt;
}

// ==========================================
// 2. PROVIDER CONFIGURATION MATRIX
// ==========================================

const providers = [];
const PROVIDER_CONFIGS = {
  GEMINI: { type: 'gemini', model: 'gemini-3.5-flash-lite' },
  GROQ: { url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  CEREBRAS: { url: 'https://api.cerebras.ai/v1', model: 'llama3.3-70b' },
  SAMBANOVA: { url: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct' },
  MISTRAL: { url: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  OPENROUTER: { url: 'https://openrouter.ai/api/v1', model: 'inclusionai/ling-3.0-tiny:free' },
  DEEPSEEK: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};
const FAILURE_STATE_PATH = path.join(__dirname, '.ai-provider-failures.json');
const FAILURE_RETRY_DELAY_MS = 3 * 60 * 1000;
const PROVIDER_DISABLED_RETRY_DELAY_MS = 10 * 60 * 1000;

function loadFailureState() {
  try {
    if (!fs.existsSync(FAILURE_STATE_PATH)) {
      return { providers: {}, cooldownUntil: 0 };
    }

    const raw = fs.readFileSync(FAILURE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
        cooldownUntil: Number(parsed.cooldownUntil) || 0,
      };
    }
  } catch (err) {
    console.warn(`⚠️ Unable to read provider failure state: ${err.message}`);
  }

  return { providers: {}, cooldownUntil: 0 };
}

function saveFailureState(state) {
  try {
    fs.writeFileSync(FAILURE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`⚠️ Unable to write provider failure state: ${err.message}`);
  }
}

function getProviderFailureInfo(providerName, state = loadFailureState()) {
  const entry = state.providers[providerName] || {};
  return {
    count: Number(entry.count) || 0,
    disabled: Boolean(entry.disabled),
    disabledUntil: Number(entry.disabledUntil) || 0,
    lastClassification: entry.lastClassification || null,
  };
}

function maybeReenableProvider(providerName, state = loadFailureState()) {
  const providerState = getProviderFailureInfo(providerName, state);

  if (!providerState.disabled) {
    return providerState;
  }

  if (!providerState.disabledUntil || Date.now() < providerState.disabledUntil) {
    return providerState;
  }

  const reenabledState = {
    ...providerState,
    disabled: false,
    disabledUntil: 0,
  };

  state.providers[providerName] = reenabledState;
  saveFailureState(state);
  console.log(`♻️ Provider [${providerName}] rejoined the pool after cooldown.`);

  return reenabledState;
}

function classifyProviderFailure(err) {
  const rawMessage = err && err.message ? err.message : String(err || '');
  const message = rawMessage.toLowerCase();

  if (message.includes('missing required field') || message.includes('missing required') || message.includes('pelafalan')) {
    return 'missing-field';
  }

  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests') || message.includes('quota') || message.includes('overloaded')) {
    return 'rate-limit';
  }

  if (message.includes('socket') || message.includes('timeout') || message.includes('econnreset') || message.includes('fetch failed') || message.includes('network')) {
    return 'transient';
  }

  return 'transient';
}

function markProviderFailure(providerName, classification, state = loadFailureState()) {
  const existing = getProviderFailureInfo(providerName, state);
  const nextState = {
    count: existing.count + 1,
    disabled: existing.disabled,
    disabledUntil: existing.disabledUntil || 0,
    lastClassification: classification,
  };

  if (classification === 'missing-field' && nextState.count >= 3) {
    nextState.disabled = true;
    nextState.disabledUntil = Date.now() + PROVIDER_DISABLED_RETRY_DELAY_MS;
    console.warn(`🛑 Provider [${providerName}] marked unusable after ${nextState.count} missing-field failures.`);
    console.warn(`⏳ Provider [${providerName}] will rejoin the pool after 10 minutes.`);
  } else if (classification === 'rate-limit') {
    console.warn(`⏳ Provider [${providerName}] hit a rate-limit condition.`);
  }

  state.providers[providerName] = nextState;
  saveFailureState(state);
  return nextState;
}

function isProviderAvailable(provider, state = loadFailureState()) {
  const providerState = maybeReenableProvider(provider.name, state);
  if (providerState.disabled) {
    return false;
  }

  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    return false;
  }

  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gemini Registration (Native SDK)
 */
Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_') && key.includes('GEMINI'))
  .forEach(envKey => {
    const apiKey = process.env[envKey];
    if (!apiKey) return;

    const name = envKey.replace('API_KEY_', '');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

    providers.push({
      name: formattedName,
      type: PROVIDER_CONFIGS.GEMINI.type,
      client: new GoogleGenAI({ apiKey }),
      modelName: PROVIDER_CONFIGS.GEMINI.model,
    });
  });

/**
 * Helper to register OpenAI-compatible clients safely.
 */
function registerOpenAIProvider(apiKey, name, baseURL, model) {
  if (apiKey) {
    providers.push({
      name,
      type: 'openai-compatible',
      client: new OpenAI({ 
        apiKey, 
        baseURL,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/kamus-terbuka", 
          "X-Title": "Kamus Terbuka AI Pipeline",
        }
      }),
      model,
    });
  }
}

// Registering non-gemini providers
Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_') && !key.includes('GEMINI'))
  .forEach(envKey => {
    const apiKey = process.env[envKey];
    const type = Object.keys(PROVIDER_CONFIGS).find(p => envKey.includes(p));

    if (apiKey && type) {
      const name = envKey.replace('API_KEY_', '');
      const formattedName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      
      registerOpenAIProvider(
        apiKey,
        formattedName,
        PROVIDER_CONFIGS[type].url,
        PROVIDER_CONFIGS[type].model
      );
    }
  });

// ---------------------------------------------------------------------------
// Provider availability is validated when a batch is actually requested so
// non-AI entry points can still import this module safely.
// ---------------------------------------------------------------------------
const totalExpectedKeys = Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_') && process.env[key]).length;

// Ensure at least one provider is available
if (providers.length === 0) {
  console.warn('⚠️ No AI providers were registered at module load time. AI calls will fail until at least one valid API key is configured.');
} else if (providers.length !== totalExpectedKeys) {
  console.warn(`[WARN] Provider initialization mismatch: expected ${totalExpectedKeys} keys from .env, but registered ${providers.length}. Ignoring unsupported or unusable API_KEY_* entries.`);
}

if (providers.length > 0) {
  console.log(`Successfully registered ${providers.length}/${totalExpectedKeys} providers.`);
}

// Track provider index across batch calls for round-robin rotation
let currentProviderIndex = 0;

/**
 * helpers/ai-engine/ai-provider.js - Part 3: Logic & Communication
 */

/**
 * Cleans potential markdown blocks (```json ... ```) or conversational fluff 
 * from AI responses to ensure valid JSON parsing.
 */
function cleanJsonResponse(rawText) {
  if (!rawText) return "";
  let cleaned = rawText.trim();
  
  // Remove markdown code blocks (case-insensitive for 'json')
  cleaned = cleaned.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '');
  
  return cleaned;
}

/**
 * Executes a single AI call against a specific provider configuration.
 * Standardizes the output to always return the array of entries.
 */
async function callProvider(provider, rows, options = {}) {
  // Resolve prompt: options.prompt (string), options.promptPath (file), or fallback to the default dataset prompt.
  let prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const promptPath = options.promptPath || DEFAULT_PROMPT_PATH;

  if (!prompt) {
    try {
      prompt = fs.readFileSync(promptPath, 'utf8').trim();
    } catch (e) {
      prompt = getDefaultSystemPrompt();
    }
  }

  const useTextResponse = options.responseMode === 'text';
  const userPayload = options.userPayload || `Process the following entries and return the JSON object with the "entries" key:\n${JSON.stringify(rows)}`;

  // --- GOOGLE GEN AI SDK (Fixed for JS CamelCase) ---
  if (provider.type === 'gemini') {
    const config = {
      temperature: 0.1,
    };

    if (!useTextResponse) {
      config.response_mime_type = 'application/json';
      config.response_schema = options.responseSchema || GEMINI_RESPONSE_SCHEMA;
    }

    const response = await provider.client.models.generateContent({
      model: provider.modelName,
      contents: [
        { role: 'user', parts: [{ text: prompt + "\n\n" + userPayload }] }
      ],
      config,
    });

    let rawText = "";
    try {
      rawText = response.text;
    } catch (e) {
      rawText = response.candidates[0].content.parts[0].text;
    }

    if (useTextResponse) {
      return cleanJsonResponse(rawText);
    }

    const parsed = JSON.parse(cleanJsonResponse(rawText));
    return parsed.entries || parsed;
  }

  // --- OPENAI-COMPATIBLE PROVIDERS ---
  if (provider.type === 'openai-compatible') {
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: userPayload },
    ];

    const completion = await provider.client.chat.completions.create({
      model: provider.model,
      messages,
      ...(useTextResponse ? {} : { response_format: { type: 'json_object' } }),
      temperature: 0.1,
    });

    const rawContent = completion.choices[0].message.content;

    if (useTextResponse) {
      return cleanJsonResponse(rawContent);
    }

    const cleanedContent = cleanJsonResponse(rawContent);
    const parsed = JSON.parse(cleanedContent);

    if (parsed.entries && Array.isArray(parsed.entries)) return parsed.entries;
    if (Array.isArray(parsed)) return parsed;

    const possibleArray = Object.values(parsed).find((val) => Array.isArray(val));
    if (possibleArray) return possibleArray;

    throw new Error('Response JSON did not contain a valid array of results.');
  }

  throw new Error(`Unknown provider type: ${provider.type}`);
}

/**
 * helpers/ai-provider.js - Part 4: Batch Management & Export
 */

async function processPromptWithAI(prompt, userPayload, options = {}) {
  const totalProviders = providers.length;

  if (totalProviders === 0) {
    throw new Error('No AI providers are configured. Set at least one API_KEY_* environment variable before calling processPromptWithAI.');
  }

  let attempts = 0;
  let cursor = currentProviderIndex;

  while (attempts < totalProviders) {
    const state = loadFailureState();

    if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
      const remainingMs = state.cooldownUntil - Date.now();
      console.log(`⏳ All providers are temporarily unavailable. Sleeping ${Math.ceil(remainingMs / 1000)}s before retrying...`);
      await sleep(remainingMs);
      continue;
    }

    const provider = providers[cursor % totalProviders];
    cursor = (cursor + 1) % totalProviders;

    maybeReenableProvider(provider.name, state);

    if (!isProviderAvailable(provider, state)) {
      attempts++;
      continue;
    }

    try {
      console.log(`🤖 Requesting prompt via [${provider.name}] (${provider.model || provider.modelName})...`);
      const result = await callProvider(provider, [{ prompt, userPayload }], {
        ...options,
        prompt,
        userPayload,
        responseMode: 'text',
      });

      currentProviderIndex = cursor % totalProviders;
      return result;
    } catch (err) {
      console.warn(`⚠️ Provider [${provider.name}] failed: ${err.message}`);
      const classification = classifyProviderFailure(err);
      markProviderFailure(provider.name, classification);

      attempts++;

      const nextState = loadFailureState();
      const blockedProviders = providers.filter((candidate) => !isProviderAvailable(candidate, nextState));
      if (blockedProviders.length === totalProviders) {
        nextState.cooldownUntil = Date.now() + FAILURE_RETRY_DELAY_MS;
        saveFailureState(nextState);
        console.log('⏳ All providers are blocked by failures or rate limits. Sleeping 3 minutes before retrying.');
        await sleep(FAILURE_RETRY_DELAY_MS);
      }

      if (attempts < totalProviders) {
        console.log(`🔄 Switching to next provider.`);
      }
    }
  }

  throw new Error('❌ All configured AI providers failed for this prompt. Check API balances and network.');
}

/**
 * Rotates through available providers until a batch is successfully processed.
 * The currentProviderIndex is global, so successful providers are "sticky" 
 * for the duration of the process until they hit a rate limit.
 */
// Main function that accepts options: prompt, promptPath, responseSchema
async function processBatchWithAI(rows, options = {}) {
  const totalProviders = providers.length;

  if (totalProviders === 0) {
    throw new Error('No AI providers are configured. Set at least one API_KEY_* environment variable before calling processBatchWithAI.');
  }

  let attempts = 0;
  let cursor = currentProviderIndex;

  while (attempts < totalProviders) {
    const state = loadFailureState();

    if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
      const remainingMs = state.cooldownUntil - Date.now();
      console.log(`⏳ All providers are temporarily unavailable. Sleeping ${Math.ceil(remainingMs / 1000)}s before retrying...`);
      await sleep(remainingMs);
      continue;
    }

    const provider = providers[cursor % totalProviders];
    cursor = (cursor + 1) % totalProviders;

    maybeReenableProvider(provider.name, state);

    if (!isProviderAvailable(provider, state)) {
      attempts++;
      continue;
    }

    try {
      console.log(`🤖 Requesting batch processing via [${provider.name}] (${provider.model || provider.modelName})...`);
      const results = await callProvider(provider, rows, options);

      if (!results || !Array.isArray(results) || results.length === 0) {
        throw new Error('Provider returned an empty or invalid array.');
      }

      currentProviderIndex = cursor % totalProviders;
      return results;
    } catch (err) {
      console.warn(`⚠️ Provider [${provider.name}] failed: ${err.message}`);
      const classification = classifyProviderFailure(err);
      markProviderFailure(provider.name, classification);

      attempts++;

      const nextState = loadFailureState();
      const blockedProviders = providers.filter((candidate) => !isProviderAvailable(candidate, nextState));
      if (blockedProviders.length === totalProviders) {
        nextState.cooldownUntil = Date.now() + FAILURE_RETRY_DELAY_MS;
        saveFailureState(nextState);
        console.log('⏳ All providers are blocked by failures or rate limits. Sleeping 3 minutes before retrying.');
        await sleep(FAILURE_RETRY_DELAY_MS);
      }

      if (attempts < totalProviders) {
        console.log(`🔄 Switching to next provider.`);
      }
    }
  }

  throw new Error('❌ All configured AI providers failed for this batch. Check API balances and network.');
}

// ==========================================
// 3. MODULE EXPORT & STANDALONE TEST RUNNER
// ==========================================

module.exports = {
  processBatchWithAI,
  processPromptWithAI,
  classifyProviderFailure,
};

// Standalone execution test: node helpers/ai-engine/ai-provider.js
if (require.main === module) {
  (async () => {
    console.log('🧪 Testing ai-provider.js with sample lexical data...');

    const sampleBatch = [
      {
        id: 101,
        kata: 'makan',
        lema: 'makan',
        makna: 'memasukkan makanan ke dalam mulut serta mengunyah dan menelannya',
        etimologi: null,
        tags_bahasa: null,
        tags_kelas: 'v',
        tags_bidang: null,
        tags_ragam: null,
      },
      {
        id: 102,
        kata: 'download',
        lema: 'download',
        makna: 'mengunduh data dari internet',
        etimologi: 'ing',
        tags_bahasa: 'ing',
        tags_kelas: null,
        tags_bidang: 'Kom',
        tags_ragam: null,
      },
      {
        id: 103,
        kata: 'air beriak tanda tak dalam',
        lema: 'air',
        makna: 'orang yang banyak bicara biasanya tidak banyak ilmunya',
        etimologi: null,
        tags_bahasa: null,
        tags_kelas: null,
        tags_bidang: null,
        tags_ragam: null,
      }
    ];

    try {
      const results = await processBatchWithAI(sampleBatch);
      console.log('\n✅ Test Success! Received structured AI results:');
      console.dir(results, { depth: null, colors: true });
    } catch (err) {
      console.error('\n💥 Test Failed:', err.message);
    }
  })();
}