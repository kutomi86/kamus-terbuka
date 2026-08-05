/**
 * helpers/ai-provider.js - Part 1: Configuration & Prompting
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

// Define the path to your prompt file (relative to this helper)
const PROMPT_PATH = path.join(__dirname, 'datasets', 'system_prompt.txt');

let SYSTEM_PROMPT = '';

try {
  // Read the system prompt from the external file
  SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  console.log('📄 System prompt loaded successfully from dataset.');
} catch (err) {
  console.error(`❌ Critical Error: Could not read system prompt file at ${PROMPT_PATH}`);
  console.error(err.message);
  process.exit(1); // Exit if the core instructions are missing
}

// Schema definition for Gemini native responseSchema
// We wrap it in an object with an "entries" key to match OpenAI-compatible behavior
// Schema structure for the NEW SDK
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          jenis_entri: { 
            type: 'string', 
            enum: ['kata', 'frasa', 'peribahasa', 'lainnya'],
            nullable: false // Add this to be explicit
          },
          tags_bahasa: { type: 'string', nullable: true },
          tags_kelas: { type: 'string', nullable: true },
          tags_bidang: { type: 'string', nullable: true },
          tags_ragam: { type: 'string', nullable: true },
        },
        required: ['id', 'jenis_entri'],
      },
    }
  },
  required: ['entries'],
};

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
  OPENROUTER: { url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  DEEPSEEK: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

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
// BLOCKER GUARD: Prevents the rest of the script from executing if counts mismatch
// ---------------------------------------------------------------------------
const totalExpectedKeys = Object.keys(process.env)
  .filter(key => key.startsWith('API_KEY_') && process.env[key]).length;

// Ensure at least one provider is available
if (providers.length === 0) {
  console.error('❌ Error: No API keys detected in .env file!');
  process.exit(1);
}

if (providers.length !== totalExpectedKeys) {
  throw new Error(`[BLOCKER] Provider initialization failed! Expected ${totalExpectedKeys} keys from .env, but only registered ${providers.length}. Execution halted.`);
}

console.log(`Successfully registered all ${providers.length}/${totalExpectedKeys} providers.`);

// Track provider index across batch calls for round-robin rotation
let currentProviderIndex = 0;

/**
 * helpers/ai-provider.js - Part 3: Logic & Communication
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
async function callProvider(provider, rows) {
  const userPayload = `Process the following entries and return the JSON object with the "entries" key:\n${JSON.stringify(rows)}`;

  // --- GOOGLE GEN AI SDK (Fixed for JS CamelCase) ---
  if (provider.type === 'gemini') {
    // In the JS SDK, methods remain camelCase: generateContent
    // Alternatively, use interactions.create for the stateful 2026 approach
    const response = await provider.client.models.generateContent({
      model: provider.modelName,
      contents: [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT + "\n\n" + userPayload }] }
      ],
      config: {
        // Ensure this is inside 'config' or 'generationConfig' depending on exact v2 sub-version
        response_mime_type: 'application/json',
        response_schema: GEMINI_RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    /**
     * Logic check: In the new SDK, 'response.text' is a getter that 
     * handles the candidate selection for you automatically.
     */
    let rawText = "";
    try {
      // Try the helper first
      rawText = response.text; 
    } catch (e) {
      // Fallback to manual path if getter fails
      rawText = response.candidates[0].content.parts[0].text;
    }

    const parsed = JSON.parse(cleanJsonResponse(rawText));
    return parsed.entries || parsed;
  }

  // --- OPENAI-COMPATIBLE PROVIDERS ---
  if (provider.type === 'openai-compatible') {
    const completion = await provider.client.chat.completions.create({
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPayload },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const rawContent = completion.choices[0].message.content;
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

/**
 * Rotates through available providers until a batch is successfully processed.
 * The currentProviderIndex is global, so successful providers are "sticky" 
 * for the duration of the process until they hit a rate limit.
 */
async function processBatchWithAI(rows) {
  const totalProviders = providers.length;
  let attempts = 0;

  while (attempts < totalProviders) {
    const provider = providers[currentProviderIndex];

    try {
      console.log(`\n🤖 Requesting batch processing via [${provider.name}] (${provider.model || provider.modelName})...`);
      const results = await callProvider(provider, rows);
      
      // Basic validation to ensure the AI didn't return an empty or malformed set
      if (!results || !Array.isArray(results) || results.length === 0) {
        throw new Error('Provider returned an empty or invalid array.');
      }

      return results;
    } catch (err) {
      // Log the specific error for debugging (e.g., 429 Rate Limit, 400 JSON error)
      console.warn(`⚠️ Provider [${provider.name}] failed: ${err.message}`);
      
      // Advance to next provider in the matrix
      currentProviderIndex = (currentProviderIndex + 1) % totalProviders;
      attempts++;

      if (attempts < totalProviders) {
        console.log(`🔄 Switching to next provider: [${providers[currentProviderIndex].name}]`);
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
};

// Standalone execution test: node helpers/ai-provider.js
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