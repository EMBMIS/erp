const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Web Search Agent for Simeli AI System
 * Handles web searches using Tavily API when database information is insufficient
 */
class WebSearchAgent {
  constructor() {
    this.tavilyApiKey = process.env.TAVILY_API_KEY;
    this.baseUrl = 'https://api.tavily.com';
    this.searchCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Determine if a query requires web search
   */
  shouldUseWebSearch(query, dbResults = null) {
    const webSearchIndicators = [
      // Information seeking
      'what is', 'who is', 'how to', 'why does', 'when did',
      'explain', 'definition', 'meaning', 'benefits', 'advantages',
      'disadvantages', 'best practices', 'tutorial', 'guide',
      
      // Current events and trends
      'latest', 'recent', 'current', 'trending', 'news',
      'market trends', 'industry trends', 'forecast',
      
      // External information
      'company information', 'competitor analysis', 'market research',
      'pricing information', 'supplier information', 'regulations',
      
      // Technology and solutions
      'api', 'integration', 'software', 'platform', 'solution',
      'alternatives', 'comparison', 'reviews'
    ];

    const queryLower = query.toLowerCase();
    const hasWebIndicator = webSearchIndicators.some(indicator => 
      queryLower.includes(indicator)
    );

    // If database returned no results and query seems informational
    const noDbResults = !dbResults || (Array.isArray(dbResults) && dbResults.length === 0);
    const informational = queryLower.includes('what') || queryLower.includes('how') || 
                          queryLower.includes('why') || queryLower.includes('explain');

    return hasWebIndicator || (noDbResults && informational);
  }

  /**
   * Perform web search using Tavily API
   */
  async search(query, options = {}) {
    try {
      console.log('🌐 Performing web search:', query);

      // Check cache first
      const cacheKey = this._generateCacheKey(query, options);
      const cached = this.searchCache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        console.log('📋 Using cached web search results');
        return cached.data;
      }

      // Check if API key is available
      if (!this.tavilyApiKey) {
        console.warn('⚠️ TAVILY_API_KEY not configured, skipping web search');
        return {
          success: false,
          error: 'Web search not configured',
          results: []
        };
      }

      // Default search options
      const searchOptions = {
        api_key: this.tavilyApiKey,
        query: query,
        search_depth: options.searchDepth || 'basic',
        include_answer: true,
        include_raw_content: true,
        include_images: true,
        max_results: options.maxResults || 5,
        include_domains: options.includeDomains || [],
        exclude_domains: options.excludeDomains || []
      };

      // Make request to Tavily API
      const response = await axios.post(`${this.baseUrl}/search`, searchOptions, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data && response.data.results) {
        // Process results with rich metadata
        const processedResults = await Promise.all(
          response.data.results.map(async (result) => {
            const enrichedResult = await this._enrichResult(result);
            return enrichedResult;
          })
        );

        const searchResults = {
          success: true,
          query: query,
          results: processedResults,
          answer: response.data.answer || null,
          images: response.data.images || [],
          searchTime: new Date().toISOString()
        };

        // Cache the results
        this.searchCache.set(cacheKey, {
          data: searchResults,
          timestamp: Date.now()
        });

        console.log(`✅ Web search completed: found ${searchResults.results.length} results`);
        return searchResults;
      }

      throw new Error('Invalid response from Tavily API');

    } catch (error) {
      console.error('❌ Web search failed:', error.message);
      
      // Return structured error response
      return {
        success: false,
        error: error.message,
        query: query,
        results: [],
        searchTime: new Date().toISOString()
      };
    }
  }

  /**
   * Search for business/industry specific information
   */
  async searchBusiness(query, industry = null) {
    const enhancedQuery = industry 
      ? `${query} ${industry} business industry`
      : `${query} business industry`;

    return await this.search(enhancedQuery, {
      searchDepth: 'advanced',
      maxResults: 7,
      includeDomains: [
        'bloomberg.com',
        'reuters.com', 
        'forbes.com',
        'mckinsey.com',
        'deloitte.com',
        'pwc.com'
      ]
    });
  }

  /**
   * Search for technical/ERP related information
   */
  async searchTechnical(query, technology = 'ERP') {
    const enhancedQuery = `${query} ${technology} software system`;

    return await this.search(enhancedQuery, {
      searchDepth: 'advanced',
      maxResults: 6,
      includeDomains: [
        'stackoverflow.com',
        'github.com',
        'docs.microsoft.com',
        'oracle.com',
        'sap.com'
      ]
    });
  }

  /**
   * Get search suggestions based on query
   */
  getSearchSuggestions(query) {
    const suggestions = [];
    const queryLower = query.toLowerCase();

    // Business suggestions
    if (queryLower.includes('erp') || queryLower.includes('business')) {
      suggestions.push({
        type: 'business',
        suggestion: 'Search business/industry information',
        method: 'searchBusiness'
      });
    }

    // Technical suggestions
    if (queryLower.includes('software') || queryLower.includes('system') || queryLower.includes('api')) {
      suggestions.push({
        type: 'technical',
        suggestion: 'Search technical documentation',
        method: 'searchTechnical'
      });
    }

    // General web search
    suggestions.push({
      type: 'general',
      suggestion: 'Perform general web search',
      method: 'search'
    });

    return suggestions;
  }

  /**
   * Enrich search result with metadata, favicon, and preview
   */
  async _enrichResult(result) {
    try {
      const enriched = {
        title: result.title,
        url: result.url,
        content: result.content,
        // The full page text, not just the matched snippet. Kept because some
        // callers need to read the page rather than rank it — MCP discovery
        // digs the actual server endpoint and setup instructions out of it
        // (services/ai/mcpEndpoint.js). Capped so one enormous page cannot
        // dominate memory or a downstream prompt.
        rawContent: result.raw_content ? String(result.raw_content).slice(0, 40000) : null,
        score: result.score || 0,
        domain: this._extractDomain(result.url),
        favicon: this._generateFaviconUrl(result.url),
        publishedDate: result.published_date || null,
        metadata: {
          description: result.content ? result.content.substring(0, 200) + '...' : '',
          wordCount: result.content ? result.content.split(' ').length : 0,
          readingTime: result.content ? Math.ceil(result.content.split(' ').length / 200) : 1
        }
      };

      // Try to extract additional metadata if raw content is available
      if (result.raw_content) {
        const additionalMeta = await this._extractMetadataFromContent(result.raw_content, result.url);
        enriched.metadata = { ...enriched.metadata, ...additionalMeta };
      }

      return enriched;
    } catch (error) {
      console.warn('Failed to enrich result:', error.message);
      return {
        title: result.title,
        url: result.url,
        content: result.content,
        score: result.score || 0,
        domain: this._extractDomain(result.url),
        favicon: this._generateFaviconUrl(result.url),
        metadata: { description: result.content ? result.content.substring(0, 200) + '...' : '' }
      };
    }
  }

  /**
   * Extract metadata from HTML content
   */
  async _extractMetadataFromContent(rawContent, url) {
    try {
      const $ = cheerio.load(rawContent);
      
      const metadata = {
        ogTitle: $('meta[property="og:title"]').attr('content'),
        ogDescription: $('meta[property="og:description"]').attr('content'),
        ogImage: $('meta[property="og:image"]').attr('content'),
        twitterImage: $('meta[name="twitter:image"]').attr('content'),
        author: $('meta[name="author"]').attr('content') || 
                $('meta[property="article:author"]').attr('content'),
        siteName: $('meta[property="og:site_name"]').attr('content'),
        articleSection: $('meta[property="article:section"]').attr('content'),
        keywords: $('meta[name="keywords"]').attr('content'),
        canonical: $('link[rel="canonical"]').attr('href')
      };

      // Clean up and resolve relative URLs
      if (metadata.ogImage && !metadata.ogImage.startsWith('http')) {
        metadata.ogImage = new URL(metadata.ogImage, url).href;
      }
      if (metadata.twitterImage && !metadata.twitterImage.startsWith('http')) {
        metadata.twitterImage = new URL(metadata.twitterImage, url).href;
      }

      // Remove empty values
      Object.keys(metadata).forEach(key => {
        if (!metadata[key]) delete metadata[key];
      });

      return metadata;
    } catch (error) {
      console.warn('Failed to extract metadata:', error.message);
      return {};
    }
  }

  /**
   * Extract domain from URL
   */
  _extractDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'unknown';
    }
  }

  /**
   * Generate favicon URL
   */
  _generateFaviconUrl(url) {
    try {
      const domain = new URL(url).origin;
      // Try multiple favicon sources
      return `${domain}/favicon.ico`;
    } catch {
      return null;
    }
  }

  /**
   * Generate cache key for search results
   */
  _generateCacheKey(query, options) {
    const optionsString = JSON.stringify(options);
    return `${query}_${optionsString}`.replace(/\s+/g, '_').toLowerCase();
  }

  /**
   * Clear search cache
   */
  clearCache() {
    this.searchCache.clear();
    console.log('🧹 Web search cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.searchCache.size,
      keys: Array.from(this.searchCache.keys()).slice(0, 5) // Show first 5 keys
    };
  }

  /**
   * Test connectivity to Tavily API
   */
  async testConnection() {
    try {
      if (!this.tavilyApiKey) {
        return {
          success: false,
          error: 'TAVILY_API_KEY not configured'
        };
      }

      const testResult = await this.search('test connectivity', {
        maxResults: 1,
        searchDepth: 'basic'
      });

      return {
        success: testResult.success,
        message: testResult.success ? 'Tavily API connection successful' : 'Tavily API connection failed',
        error: testResult.error || null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to test Tavily API connection'
      };
    }
  }
}

module.exports = WebSearchAgent;