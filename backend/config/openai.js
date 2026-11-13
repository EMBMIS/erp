const { generateUnspscPrompt, validateUnspscCode, getSegmentInfo } = require('../data/unspsc-smart');
require('dotenv').config();
const { AI_MODEL, AI_MODEL_FAST, getOpenAIClient } = require('./aiConfig');

// Item enrichment used to build its own OpenAI client straight from
// process.env.OPENAI_API_KEY — correct only for the "openai" provider, and
// silently ignored AI_PROVIDER=openrouter entirely (this would keep trying
// to call OpenAI, or fail outright with no key set, even with a working
// OpenRouter key configured). Routed through aiConfig's shared client
// instead, so this picks up whichever OpenAI-compatible provider
// (openai/openrouter) the rest of the app is configured for — one place
// decides the provider, not each AI call site individually.
//
// getOpenAIClient() already defers real construction to first property
// access rather than throwing at require time — see its own comment in
// aiConfig.js — and the SDK itself throws a clear "missing API key" error at
// that point, which every method below already catches via its existing
// try/catch fallback. No separate guard needed here.
const openai = getOpenAIClient();

class AIService {
  async generateItemDescription(itemName) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an expert in industrial inventory management. Generate concise, professional descriptions for inventory items. Keep descriptions under 100 characters and focus on key specifications and usage."
          },
          {
            role: "user",
            content: `Generate a professional description for this inventory item: ${itemName}`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('OpenAI API error:', error);
      return null;
    }
  }

  async suggestStockSettings(itemName, description) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an inventory classification expert. Based on item names and descriptions, determine stock settings. Return JSON with: is_stock_item (boolean), planned_stock (boolean). Rules: is_stock_item=false for services/non-physical items. planned_stock=true for items needing min/max stock levels (consumables, high-volume items). planned_stock=false for critical items or long lead time items that should be kept in stock without formal planning."
          },
          {
            role: "user",
            content: `Item: ${itemName}\nDescription: ${description}\nSuggest stock settings:`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const content = completion.choices[0].message.content.trim();
      
      try {
        const parsed = JSON.parse(content);
        return {
          is_stock_item: parsed.is_stock_item || true,
          planned_stock: parsed.planned_stock || false
        };
      } catch (parseError) {
        // Fallback parsing
        const isService = itemName.toLowerCase().includes('service') || 
                         description.toLowerCase().includes('service');
        return {
          is_stock_item: !isService,
          planned_stock: false
        };
      }
    } catch (error) {
      console.error('OpenAI API error:', error);
      return {
        is_stock_item: true,
        planned_stock: false
      };
    }
  }

  async predictCriticality(itemName, description) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an inventory management expert. Based on item names and descriptions, predict criticality level: HIGH (critical machinery parts, safety items), MEDIUM (important components), LOW (general supplies, non-critical items). Reply with only: HIGH, MEDIUM, or LOW."
          },
          {
            role: "user",
            content: `Item: ${itemName}\nDescription: ${description}\nPredict criticality:`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const prediction = completion.choices[0].message.content.trim();
      return ['HIGH', 'MEDIUM', 'LOW'].includes(prediction) ? prediction : 'MEDIUM';
    } catch (error) {
      console.error('OpenAI API error:', error);
      return 'MEDIUM'; // Default fallback
    }
  }

  async generateComprehensiveData(itemName, description = '') {
    try {
      // Get smart UNSPSC classification
      const unspscInfo = generateUnspscPrompt(itemName, description);
      
      console.log(`Smart UNSPSC classification for "${itemName}":`, unspscInfo);
      
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: `You are an expert in industrial inventory management and UNSPSC classification. Generate comprehensive inventory item data with accurate UNSPSC codes.

Return ONLY valid JSON with ALL these fields: name, description, is_stock_item (boolean), planned_stock (boolean), criticality (HIGH/MEDIUM/LOW), unit_of_measure, unspsc_code (8-digit), manufacturer (realistic company), manufacturer_part_number, item_category, serial_number (format: XXX-###-YYYY), equipment_tag (if applicable), has_contract (boolean), contract_number (if has_contract=true), has_barcode (boolean), barcode (if has_barcode=true, 13 digits), mass_per_uom (number, kg per unit), volume_per_uom (number, cubic meters per unit).

Classification Context:
- Suggested UNSPSC: ${unspscInfo.suggestedCode} (${unspscInfo.suggestedDescription})
- Segment: ${unspscInfo.segment} - ${unspscInfo.segmentName}
- Classification confidence: ${unspscInfo.confidence}

Rules: 
- Use 8-digit UNSPSC codes only
- is_stock_item=false for services
- planned_stock=true for consumables/high-volume items, false for critical/specialized items
- Generate realistic manufacturers based on item type
- Make item_category descriptive and industry-appropriate
- mass_per_uom: realistic weight per unit (e.g., 0.5 for 500g bolt, 2.5 for 2.5kg pump part)
- volume_per_uom: realistic volume per unit (e.g., 0.000125 for small bolt = 125 cm³, 0.008 for box = 8 liters)`
          },
          {
            role: "user",
            content: `Generate comprehensive data for: "${itemName}" ${description ? `Description: ${description}` : ''}

Please use appropriate UNSPSC classification. Suggested code: ${unspscInfo.suggestedCode} - ${unspscInfo.suggestedDescription}`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const content = completion.choices[0]?.message?.content?.trim();
      console.log('AI Comprehensive Response:', content);
      
      if (!content) {
        console.log('Empty comprehensive response, using fallback');
        throw new Error('Empty response from AI');
      }
      
      // Try to extract JSON if response contains extra text
      let jsonStr = content;
      if (content.includes('{') && content.includes('}')) {
        const startIdx = content.indexOf('{');
        const endIdx = content.lastIndexOf('}') + 1;
        jsonStr = content.substring(startIdx, endIdx);
      } else {
        console.log('No JSON found in comprehensive response, using fallback');
        throw new Error('No valid JSON found in AI response');
      }

      try {
        const parsed = JSON.parse(jsonStr);
        console.log('Parsed Comprehensive JSON:', parsed);
        
        // Validate that we have essential fields
        if (!parsed.name && !parsed.description) {
          console.log('Missing essential fields in AI response');
          throw new Error('AI response missing essential fields');
        }
        
        // Validate and ensure proper UNSPSC code
        if (!validateUnspscCode(parsed.unspsc_code)) {
          console.log(`Invalid UNSPSC code from AI: ${parsed.unspsc_code}, using suggested: ${unspscInfo.suggestedCode}`);
          parsed.unspsc_code = unspscInfo.suggestedCode;
        }
        
        // Ensure item_category is descriptive
        if (!parsed.item_category || parsed.item_category === 'General') {
          parsed.item_category = unspscInfo.suggestedDescription;
        }
        
        console.log('Final data with accurate UNSPSC:', parsed);
        return parsed;
      } catch (jsonError) {
        console.log('Comprehensive JSON parse error:', jsonError.message);
        throw new Error('Invalid JSON format in comprehensive AI response');
      }
    } catch (error) {
      console.error('OpenAI comprehensive generation error:', error);
      
      // Return comprehensive fallback with smart UNSPSC classification
      const isService = itemName.toLowerCase().includes('service');
      const unspscInfo = generateUnspscPrompt(itemName, description);
      
      const fallback = {
        name: itemName,
        description: description || `Professional ${itemName}`,
        is_stock_item: !isService,
        planned_stock: false,
        criticality: 'MEDIUM',
        unit_of_measure: isService ? 'hrs' : 'pcs',
        unspsc_code: unspscInfo.suggestedCode,
        manufacturer: isService ? 'Service Provider' : 'Generic Manufacturer',
        manufacturer_part_number: isService ? 'SVC-001' : 'GEN-001',
        item_category: unspscInfo.suggestedDescription,
        serial_number: isService ? '' : 'ITM-001-2025',
        equipment_tag: '',
        has_contract: false,
        contract_number: '',
        has_barcode: !isService,
        barcode: !isService ? '1234567890123' : ''
      };
      
      console.log('Using comprehensive fallback:', fallback);
      return fallback;
    }
  }

  async parseNLInput(input) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "Parse inventory item input and extract structured data. Return ONLY valid JSON with these fields: name, description, suggested_stock_code (ST1/ST2/NS3), criticality (HIGH/MEDIUM/LOW), unit_of_measure. Example: {\"name\":\"Steel Bolt\",\"description\":\"10mm steel bolt\",\"suggested_stock_code\":\"ST1\",\"criticality\":\"MEDIUM\",\"unit_of_measure\":\"pcs\"}"
          },
          {
            role: "user",
            content: `Parse this inventory item request: "${input}"`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const content = completion.choices[0]?.message?.content?.trim();
      console.log('AI Response:', content); // Debug log
      
      if (!content) {
        console.log('Empty AI response, using fallback');
        throw new Error('Empty response from AI');
      }
      
      // Try to extract JSON if response contains extra text
      let jsonStr = content;
      if (content.includes('{') && content.includes('}')) {
        const startIdx = content.indexOf('{');
        const endIdx = content.lastIndexOf('}') + 1;
        jsonStr = content.substring(startIdx, endIdx);
      } else {
        console.log('No JSON found in response, using fallback');
        throw new Error('No valid JSON found in AI response');
      }

      try {
        const parsed = JSON.parse(jsonStr);
        console.log('Parsed JSON:', parsed); // Debug log
        return parsed;
      } catch (jsonError) {
        console.log('JSON parse error:', jsonError.message);
        console.log('Attempting to parse as simple text...');
        throw new Error('Invalid JSON format in AI response');
      }
    } catch (error) {
      console.error('OpenAI parsing error:', error);
      
      // Return fallback structure based on input analysis
      const fallback = {
        name: input.length > 50 ? input.substring(0, 50) + '...' : input,
        description: `Item parsed from: "${input}"`,
        suggested_stock_code: 'ST1',
        criticality: 'MEDIUM',
        unit_of_measure: 'pcs'
      };
      
      console.log('Using fallback:', fallback);
      return fallback;
    }
  }
}

module.exports = new AIService();