// list-models.js
require('dotenv').config();

async function listModels() {
  const apiKey = process.env.API_KEY_GEMINI;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    
    console.log("--- Available Models for your Key ---");
    data.models.forEach(m => {
      // Filter for models that support 'generateContent'
      if (m.supportedGenerationMethods.includes('generateContent')) {
        console.log(`- Model: ${m.name} (ID: ${m.name.split('/')[1]})`);
      }
    });
  } catch (err) {
    console.error("Failed to fetch models:", err.message);
  }
}

listModels();