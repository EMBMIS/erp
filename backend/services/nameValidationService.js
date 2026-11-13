const OpenAI = require('openai');
const { AI_MODEL, AI_MODEL_FAST, getOpenAIClient } = require('../config/aiConfig');

/**
 * Simple Name Validation Service using GPT-5-nano
 * 
 * Only validates and suggests corrections for customer names
 * User can accept suggestion or proceed without changes
 */
class NameValidationService {
  constructor() {
    this.client = getOpenAIClient();
    
    this.isEnabled = !!process.env.OPENAI_API_KEY;
  }

  async validateLegalName(name) {
    if (!this.isEnabled || !name?.trim()) {
      return {
        isValid: true,
        suggestion: null,
        message: 'No suggestion available'
      };
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a legal entity name validation assistant. Check if company/legal entity names are properly formatted and suggest corrections for common issues like: missing legal suffixes (Inc, LLC, Corp, Ltd), incorrect capitalization, misspellings, or formatting issues. Focus on business name conventions. Return JSON only."
          },
          {
            role: "user",
            content: `Check this legal entity name for proper formatting: "${name}"

Return JSON with this structure:
{
  "needs_correction": true/false,
  "suggested_name": "corrected name or null",
  "reason": "why correction is needed or null"
}

Examples:
- "microsoft corporation" → suggest "Microsoft Corporation" (capitalization)
- "Apple inc" → suggest "Apple Inc." (proper suffix format)
- "Google llc" → suggest "Google LLC" (proper suffix format)
- "amazon" → suggest "Amazon Inc." (missing legal suffix)
- "Walmart Inc." → no suggestion needed (already correct)
- "Tesla, Inc." → no suggestion needed (already correct)
- "mcdonalds corp" → suggest "McDonald's Corp." (apostrophe and capitalization)`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const content = completion.choices[0]?.message?.content?.trim();
      
      if (!content) {
        return this.fallbackResponse();
      }
      
      // Extract JSON
      let jsonStr = content;
      if (content.includes('{') && content.includes('}')) {
        const startIdx = content.indexOf('{');
        const endIdx = content.lastIndexOf('}') + 1;
        jsonStr = content.substring(startIdx, endIdx);
      }

      const response = JSON.parse(jsonStr);
      
      return {
        isValid: !response.needs_correction,
        suggestion: response.suggested_name,
        reason: response.reason,
        message: response.needs_correction 
          ? `Suggestion: "${response.suggested_name}" - ${response.reason}`
          : 'Name looks good'
      };

    } catch (error) {
      console.error('Name validation error:', error);
      return this.fallbackResponse();
    }
  }

  async validateCustomerName(name) {
    if (!this.isEnabled || !name?.trim()) {
      return {
        isValid: true,
        suggestion: null,
        message: 'No suggestion available'
      };
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a name validation assistant. Check for spelling errors first, then gender consistency. Give brief, simple reasons. Return JSON only."
          },
          {
            role: "user",
            content: `Check this full customer name for gender consistency between first name and surname endings: "${name}"

Return JSON with this structure:
{
  "needs_correction": true/false,
  "suggested_name": "corrected name or null",
  "reason": "why correction is needed or null"
}

Focus on name/surname ending patterns:
- Slavic/Eastern European: -ov/-ova, -ev/-eva, -in/-ina, -sky/-ska, -enko (masculine), -enko (can be both)
- Russian: -ov/-ova, -ev/-eva, -in/-ina, -sky/-skaya
- Ukrainian: -enko, -uk/-yuk, -sky/-ska
- Polish: -ski/-ska, -cki/-cka
- Czech: -ovy/-ová, -ny/-ná

Examples:
- "Rasd Yusubov" → suggest "Rashad Yusubov", reason "spelling"
- "samir yusubova" → suggest "Samir Yusubov", reason "gender mismatch" 
- "Anna Petrov" → suggest "Anna Petrova", reason "gender mismatch"
- "maria kowalski" → suggest "Maria Kowalska", reason "gender mismatch"
- "Ivan Petrov" → no correction needed
- "John Smith" → no correction needed

IMPORTANT: Always check Slavic surname endings:
- Male name + feminine surname (-ova, -eva, -ina, -ska) = WRONG → change surname to masculine (-ov, -ev, -in, -ski)  
- Female name + masculine surname (-ov, -ev, -in, -ski) = WRONG → change surname to feminine (-ova, -eva, -ina, -ska)

Examples of fixes:
- "Ivan Petrova" → "Ivan Petrov" (remove -a from surname)
- "Anna Petrov" → "Anna Petrova" (add -a to surname)

Keep reasons short: "spelling", "gender mismatch", or null.

Only suggest if there's clear gender mismatch in name endings.`
          }
        ],
        reasoning_effort: "minimal",
        verbosity: "low"
      });

      const content = completion.choices[0]?.message?.content?.trim();
      
      if (!content) {
        return this.fallbackResponse();
      }
      
      // Extract JSON
      let jsonStr = content;
      if (content.includes('{') && content.includes('}')) {
        const startIdx = content.indexOf('{');
        const endIdx = content.lastIndexOf('}') + 1;
        jsonStr = content.substring(startIdx, endIdx);
      }

      const response = JSON.parse(jsonStr);
      
      return {
        isValid: !response.needs_correction,
        suggestion: response.suggested_name,
        reason: response.reason,
        message: response.needs_correction 
          ? `Suggestion: "${response.suggested_name}" - ${response.reason}`
          : 'Name looks good'
      };

    } catch (error) {
      console.error('Customer name validation error:', error);
      return this.fallbackResponse();
    }
  }

  fallbackResponse() {
    return {
      isValid: true,
      suggestion: null,
      reason: null,
      message: 'Name validation temporarily unavailable'
    };
  }

  // Quick validation for common patterns (fallback when AI is unavailable)
  quickValidation(name) {
    if (!name?.trim()) {
      return this.fallbackResponse();
    }

    const cleanName = name.trim();
    
    // Common misspellings map
    const commonCorrections = {
      'rasad': 'Rashad',
      'jhon': 'John',
      'micheal': 'Michael',
      'recieve': 'Receive',
      'seperate': 'Separate',
      'definately': 'Definitely'
    };

    const lowerName = cleanName.toLowerCase();
    if (commonCorrections[lowerName]) {
      return {
        isValid: false,
        suggestion: commonCorrections[lowerName],
        reason: 'Common spelling correction',
        message: `Suggestion: "${commonCorrections[lowerName]}" - Common spelling correction`
      };
    }

    // Check for all lowercase (should be capitalized)
    if (cleanName === cleanName.toLowerCase() && cleanName.length > 2) {
      const capitalized = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      return {
        isValid: false,
        suggestion: capitalized,
        reason: 'Name should be capitalized',
        message: `Suggestion: "${capitalized}" - Name should be capitalized`
      };
    }

    return {
      isValid: true,
      suggestion: null,
      reason: null,
      message: 'Name looks good'
    };
  }
}

// Singleton instance
const nameValidationService = new NameValidationService();

module.exports = nameValidationService;