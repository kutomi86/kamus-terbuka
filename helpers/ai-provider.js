/**
 * helpers/ai-provider.js - Part 1: Configuration & Prompting
 */

require('dotenv').config();
const { GoogleGenAI  } = require('@google/genai');
const OpenAI = require('openai');

// ==========================================
// 1. SHARED SYSTEM PROMPT & JSON INSTRUCTIONS
// ==========================================

/**
 * Note: The word "JSON" is included explicitly to satisfy Groq's 
 * requirement when response_format: { type: "json_object" } is used.
 */
const SYSTEM_PROMPT = `
You are an expert lexicographer processing entries for the KBBI (Kamus Besar Bahasa Indonesia) database.
Your main focus is accurately determining entry type and standardizing language origin tags. 
Additionally, you must infer missing grammar or domain tags from the definition when confident.
Output the results in a valid JSON format.

Rules:
1. "jenis_entri" (PRIMARY FOCUS):
   - "kata": A single root or affixed word.
   - "frasa": A multi-word phrase without idiomatic/proverb meaning.
   - "peribahasa": Idioms, proverbs, aphorisms, or traditional expressions.
   - "lainnya": Abbreviations, symbols, affixes, or any entry that does not clearly fit the above options. MUST NOT be null or empty.

2. "tags_bahasa" (PRIMARY FOCUS):
   - Normalize messy, 2-letter, or 3-letter language codes into full, proper Indonesian names.
   - Examples: "ing"/"en"/"eng" -> "Inggris", "fr"/"fra" -> "Fransis", "jv"/"jav" -> "Jawa", "nl"/"dut" -> "Belanda", "ar"/"ara" -> "Arab", "sd" -> "Sunda".
   - If missing, unidentifiable, or standard Indonesian without loanword origin, return null.

3. "tags_kelas" (SECONDARY ENRICHMENT):
   - If missing or null, infer primary word class from definition ("makna").
   - Standard KBBI codes: "n" (Nomina), "v" (Verba), "a" (Adjektiva), "adv" (Adverbia), "p" (Pronomina/Preposisi/Partikel).
   - Return null if uncertain or peribahasa.

4. "tags_bidang" (SECONDARY ENRICHMENT):
   - If missing or null, check if definition clearly belongs to a specialized field (e.g., "Huk", "Ked", "Kom", "Mat", "Bio").
   - Return null if general everyday vocabulary.

5. "tags_ragam":
   - Standard register codes (e.g., "cak" for casual, "kas" for coarse, "hor" for formal/honorific). Return null if standard.

6. Critical Requirement:
   - Always preserve the exact integer "id" provided for each entry.
   - RESPOND ONLY WITH VALID JSON.
   - Use the following structure: {"entries": [...array of objects...]}
`;

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
          jenis_entri: { type: 'string', enum: ['kata', 'frasa', 'peribahasa', 'lainnya'] },
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

/**
 * Gemini Registration (Native SDK)
 * We store the API key and model name string to initialize 
 * the model instance fresh during the call.
 */
if (process.env.API_KEY_GEMINI) {
  providers.push({
    name: 'Gemini',
    type: 'gemini',
    // Initialize the new SDK client
    client: new GoogleGenAI ({ apiKey: process.env.API_KEY_GEMINI }),
    modelName: "gemini-3.5-flash-lite", // Use the name from your listModels output
  });
}

/**
 * Helper to register OpenAI-compatible clients safely.
 */
function registerOpenAIProvider(envKey, name, baseURL, model) {
  if (process.env[envKey]) {
    providers.push({
      name,
      type: 'openai-compatible',
      client: new OpenAI({ 
        apiKey: process.env[envKey], 
        baseURL,
        // Some providers like OpenRouter require these headers
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/kamus-terbuka", 
          "X-Title": "Kamus Terbuka AI Pipeline",
        }
      }),
      model,
    });
  }
}

// Registering providers with specific models from your requirements
registerOpenAIProvider('API_KEY_GROQ', 'Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile');
registerOpenAIProvider('API_KEY_CEREBRAS', 'Cerebras', 'https://api.cerebras.ai/v1', 'llama3.3-70b');
registerOpenAIProvider('API_KEY_SAMBANOVA', 'SambaNova', 'https://api.sambanova.ai/v1', 'Meta-Llama-3.3-70B-Instruct');
registerOpenAIProvider('API_KEY_MISTRAL', 'Mistral', 'https://api.mistral.ai/v1', 'mistral-small-latest');
registerOpenAIProvider('API_KEY_OPENROUTER', 'OpenRouter', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct:free');
registerOpenAIProvider('API_KEY_DEEPSEEK', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat');

// Ensure at least one provider is available
if (providers.length === 0) {
  console.error('❌ Error: No API keys detected in .env file!');
  process.exit(1);
}

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
      console.log(`🤖 Requesting batch processing via [${provider.name}] (${provider.model || provider.modelName})...`);
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