const OpenAI = require('openai');
require('dotenv').config();
const { AI_MODEL, AI_MODEL_FAST, getOpenAIClient } = require('../config/aiConfig');
const { safeJsonParse } = require('./aiJson');
const { classifyAiError } = require('./ai/errorClassifier');

const openai = getOpenAIClient();

// See the identical helper in aiEnhancementService.js for the rationale: a
// fallback returned on an AI outage (quota/auth failure) must be marked as
// such, or it's indistinguishable from a real low-confidence prediction.
function aiUnavailableTag(error) {
  const classified = classifyAiError(error);
  return { ai_unavailable: true, ai_error_code: classified.code };
}

class AIModuleService {

  // 🎯 SALES MODULE AI
  async analyzeSalesOpportunity(customerData, orderHistory, marketData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a sales intelligence expert. Analyze customer data to identify sales opportunities, optimal pricing, and engagement strategies. Return JSON with: opportunity_score (0-100), recommended_products (array), optimal_pricing_strategy (string), engagement_timing (IMMEDIATE/SOON/LATER), upsell_potential (0-100), cross_sell_suggestions (array), predicted_order_value (number), best_contact_method (EMAIL/PHONE/MEETING)."
          },
          {
            role: "user",
            content: `Analyze sales opportunity: Customer: ${JSON.stringify(customerData)} Orders: ${JSON.stringify(orderHistory)} Market: ${JSON.stringify(marketData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Sales opportunity analysis error:', error);
      return {
        ...aiUnavailableTag(error),
        opportunity_score: 65,
        recommended_products: ['Related electronics'],
        optimal_pricing_strategy: 'Competitive pricing with 10% margin',
        engagement_timing: 'SOON',
        upsell_potential: 40,
        cross_sell_suggestions: ['Accessories', 'Support services'],
        predicted_order_value: 8500,
        best_contact_method: 'EMAIL'
      };
    }
  }

  async generateQuoteIntelligence(rfqData, competitorData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a quote optimization expert. Analyze RFQ requirements and market data to suggest optimal quotes. Return JSON with: recommended_quote_price (number), win_probability (0-1), competitive_position (AGGRESSIVE/COMPETITIVE/PREMIUM), margin_analysis (object), risk_factors (array), value_proposition (string), negotiation_points (array)."
          },
          {
            role: "user",
            content: `Optimize quote: RFQ: ${JSON.stringify(rfqData)} Competition: ${JSON.stringify(competitorData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Quote intelligence error:', error);
      return {
        ...aiUnavailableTag(error),
        recommended_quote_price: rfqData.estimated_value * 1.15,
        win_probability: 0.6,
        competitive_position: 'COMPETITIVE',
        margin_analysis: { gross_margin: '15%', target_margin: '20%' },
        risk_factors: ['Tight timeline'],
        value_proposition: 'Quality and reliability focus',
        negotiation_points: ['Extended warranty', 'Volume discounts']
      };
    }
  }

  // 🛒 PROCUREMENT MODULE AI
  async optimizePurchaseDecision(prData, supplierOptions, budgetConstraints) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a procurement optimization expert. Analyze purchase requirements and supplier options to recommend optimal procurement decisions. Return JSON with: recommended_supplier (string), optimal_order_quantity (number), best_timing (string), cost_savings_opportunity (number), risk_assessment (object), alternative_options (array), negotiation_strategy (string)."
          },
          {
            role: "user",
            content: `Optimize purchase: PR: ${JSON.stringify(prData)} Suppliers: ${JSON.stringify(supplierOptions)} Budget: ${JSON.stringify(budgetConstraints)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Purchase optimization error:', error);
      return {
        ...aiUnavailableTag(error),
        recommended_supplier: supplierOptions[0]?.name || 'Primary Supplier',
        optimal_order_quantity: prData.requested_quantity || 10,
        best_timing: 'Within 2 weeks for best pricing',
        cost_savings_opportunity: 500,
        risk_assessment: { delivery_risk: 'LOW', quality_risk: 'MEDIUM' },
        alternative_options: ['Consider bulk ordering'],
        negotiation_strategy: 'Volume-based discount negotiation'
      };
    }
  }

  async analyzeSpendPattern(spendData, categoryData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a spend analytics expert. Analyze spending patterns to identify savings opportunities and risks. Return JSON with: spend_health_score (0-100), maverick_spending (array), consolidation_opportunities (array), category_insights (array), cost_reduction_potential (number), risk_categories (array), recommended_actions (array)."
          },
          {
            role: "user",
            content: `Analyze spending: ${JSON.stringify({spend: spendData, categories: categoryData})}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Spend analysis error:', error);
      return {
        ...aiUnavailableTag(error),
        spend_health_score: 72,
        maverick_spending: ['Off-contract purchases'],
        consolidation_opportunities: ['IT equipment suppliers'],
        category_insights: ['Electronics showing 15% price increase'],
        cost_reduction_potential: 12000,
        risk_categories: ['Single source categories'],
        recommended_actions: ['Negotiate master agreements']
      };
    }
  }

  // 📦 INVENTORY MODULE AI
  async optimizeInventoryStrategy(inventoryData, usageHistory, seasonalData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an inventory optimization expert. Analyze inventory levels, usage patterns, and seasonal trends to recommend optimal inventory strategies. Return JSON with: optimal_stock_levels (object), reorder_recommendations (array), slow_moving_items (array), excess_inventory_alerts (array), stockout_risks (array), inventory_turnover_analysis (object), cost_optimization_suggestions (array)."
          },
          {
            role: "user",
            content: `Optimize inventory: Current: ${JSON.stringify(inventoryData)} Usage: ${JSON.stringify(usageHistory)} Seasonal: ${JSON.stringify(seasonalData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Inventory optimization error:', error);
      return {
        ...aiUnavailableTag(error),
        optimal_stock_levels: { min: 10, max: 50, reorder_point: 15 },
        reorder_recommendations: ['Order iPhone 15 Pro Max - 20 units'],
        slow_moving_items: ['Legacy models'],
        excess_inventory_alerts: [],
        stockout_risks: ['High-demand electronics'],
        inventory_turnover_analysis: { current_ratio: 4.2, target_ratio: 6.0 },
        cost_optimization_suggestions: ['Reduce slow-moving stock by 30%']
      };
    }
  }

  async predictStockMovement(itemData, marketTrends, businessCycle) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a demand forecasting expert. Predict stock movement patterns and optimal stocking strategies. Return JSON with: predicted_monthly_usage (array), seasonal_factors (object), demand_drivers (array), stockout_probability (0-1), optimal_safety_stock (number), inventory_classification (A/B/C), suggested_ordering_frequency (string)."
          },
          {
            role: "user",
            content: `Predict stock movement: Item: ${JSON.stringify(itemData)} Trends: ${JSON.stringify(marketTrends)} Cycle: ${JSON.stringify(businessCycle)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Stock prediction error:', error);
      return {
        ...aiUnavailableTag(error),
        predicted_monthly_usage: [10, 12, 15, 18, 20, 16],
        seasonal_factors: { q4_boost: 1.3, summer_dip: 0.8 },
        demand_drivers: ['Back-to-school season', 'Holiday shopping'],
        stockout_probability: 0.15,
        optimal_safety_stock: 8,
        inventory_classification: 'A',
        suggested_ordering_frequency: 'Bi-weekly'
      };
    }
  }

  // 🏭 WAREHOUSE MODULE AI
  async optimizeWarehouseOperations(warehouseData, pickingPatterns, layoutData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a warehouse optimization expert. Analyze operations to improve efficiency, reduce costs, and optimize layouts. Return JSON with: efficiency_score (0-100), layout_improvements (array), picking_optimizations (array), capacity_utilization (object), labor_optimization (array), automation_opportunities (array), cost_reduction_potential (number)."
          },
          {
            role: "user",
            content: `Optimize warehouse: Operations: ${JSON.stringify(warehouseData)} Patterns: ${JSON.stringify(pickingPatterns)} Layout: ${JSON.stringify(layoutData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Warehouse optimization error:', error);
      return {
        ...aiUnavailableTag(error),
        efficiency_score: 78,
        layout_improvements: ['Move fast-moving items closer to shipping'],
        picking_optimizations: ['Implement zone picking'],
        capacity_utilization: { current: 0.67, optimal: 0.85 },
        labor_optimization: ['Peak hour staffing adjustments'],
        automation_opportunities: ['Automated sorting'],
        cost_reduction_potential: 3500
      };
    }
  }

  async predictPickingTime(orderData, warehouseLayout, staffingLevels) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a warehouse efficiency expert. Predict picking times and optimize routes. Return JSON with: estimated_picking_time (minutes), optimal_pick_route (array), efficiency_improvements (array), bottleneck_locations (array), staff_recommendations (object), time_savings_potential (minutes)."
          },
          {
            role: "user",
            content: `Predict picking: Order: ${JSON.stringify(orderData)} Layout: ${JSON.stringify(warehouseLayout)} Staff: ${JSON.stringify(staffingLevels)}`
          }
        ],
        reasoning_effort: "medium",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Picking prediction error:', error);
      return {
        ...aiUnavailableTag(error),
        estimated_picking_time: 25,
        optimal_pick_route: ['Zone A', 'Zone C', 'Zone B'],
        efficiency_improvements: ['Batch similar orders'],
        bottleneck_locations: ['Electronics section'],
        staff_recommendations: { optimal_staff: 3, current_staff: 2 },
        time_savings_potential: 8
      };
    }
  }

  // 👥 SUPPLIER MODULE AI  
  async assessSupplierRisk(supplierData, performanceHistory, marketData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a supplier risk management expert. Assess supplier risks across financial, operational, and strategic dimensions. Return JSON with: overall_risk_score (0-100), financial_stability (STRONG/STABLE/CONCERNING/CRITICAL), operational_risks (array), strategic_risks (array), mitigation_strategies (array), alternative_suppliers_needed (boolean), monitoring_recommendations (array)."
          },
          {
            role: "user",
            content: `Assess supplier risk: Supplier: ${JSON.stringify(supplierData)} Performance: ${JSON.stringify(performanceHistory)} Market: ${JSON.stringify(marketData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Supplier risk assessment error:', error);
      return {
        ...aiUnavailableTag(error),
        overall_risk_score: 35,
        financial_stability: 'STABLE',
        operational_risks: ['Geographic concentration'],
        strategic_risks: ['Single source dependency'],
        mitigation_strategies: ['Diversify supplier base'],
        alternative_suppliers_needed: true,
        monitoring_recommendations: ['Monthly performance reviews']
      };
    }
  }

  async optimizeSupplierMix(currentSuppliers, categoryRequirements, performanceData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system", 
            content: "You are a strategic sourcing expert. Optimize supplier portfolio for cost, quality, and risk balance. Return JSON with: optimal_supplier_mix (array), diversification_recommendations (array), consolidation_opportunities (array), new_supplier_requirements (array), cost_impact (object), risk_reduction (object), implementation_plan (array)."
          },
          {
            role: "user",
            content: `Optimize supplier mix: Current: ${JSON.stringify(currentSuppliers)} Requirements: ${JSON.stringify(categoryRequirements)} Performance: ${JSON.stringify(performanceData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Supplier mix optimization error:', error);
      return {
        ...aiUnavailableTag(error),
        optimal_supplier_mix: ['60% primary, 25% secondary, 15% backup'],
        diversification_recommendations: ['Add regional suppliers'],
        consolidation_opportunities: ['Combine office supply vendors'],
        new_supplier_requirements: ['Electronics backup supplier'],
        cost_impact: { potential_savings: 8500 },
        risk_reduction: { risk_score_improvement: 15 },
        implementation_plan: ['Phase 1: Qualify backup suppliers']
      };
    }
  }

  // 👨‍💼 CUSTOMER MODULE AI
  async analyzeCustomerValue(customerProfile, transactionHistory, marketSegment) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a customer analytics expert. Analyze customer value, behavior, and potential. Return JSON with: lifetime_value (number), value_tier (PLATINUM/GOLD/SILVER/BRONZE), churn_risk (0-100), growth_potential (0-100), preferred_communication (array), optimal_engagement_strategy (string), revenue_expansion_opportunities (array), retention_recommendations (array)."
          },
          {
            role: "user",
            content: `Analyze customer value: Profile: ${JSON.stringify(customerProfile)} History: ${JSON.stringify(transactionHistory)} Segment: ${JSON.stringify(marketSegment)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Customer value analysis error:', error);
      return {
        ...aiUnavailableTag(error),
        lifetime_value: 45000,
        value_tier: 'GOLD',
        churn_risk: 25,
        growth_potential: 70,
        preferred_communication: ['Email', 'Phone'],
        optimal_engagement_strategy: 'Regular check-ins with value-added insights',
        revenue_expansion_opportunities: ['Additional product lines'],
        retention_recommendations: ['Loyalty program enrollment']
      };
    }
  }

  async personalizeCustomerExperience(customerData, interactionHistory, preferences) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a customer experience optimization expert. Personalize interactions based on customer data and preferences. Return JSON with: personalization_score (0-100), recommended_products (array), optimal_communication_tone (FORMAL/FRIENDLY/TECHNICAL), preferred_interaction_frequency (string), customized_offers (array), relationship_strategy (string), satisfaction_predictors (array)."
          },
          {
            role: "user",
            content: `Personalize experience: Customer: ${JSON.stringify(customerData)} Interactions: ${JSON.stringify(interactionHistory)} Preferences: ${JSON.stringify(preferences)}`
          }
        ],
        reasoning_effort: "medium",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Customer personalization error:', error);
      return {
        ...aiUnavailableTag(error),
        personalization_score: 80,
        recommended_products: ['Based on purchase history'],
        optimal_communication_tone: 'FRIENDLY',
        preferred_interaction_frequency: 'Monthly',
        customized_offers: ['Volume discounts'],
        relationship_strategy: 'Partnership approach',
        satisfaction_predictors: ['Response time', 'Product quality']
      };
    }
  }

  // 📋 OPERATIONS MODULE AI
  async optimizeBusinessProcess(processData, performanceMetrics, userFeedback) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a business process optimization expert. Analyze processes to identify inefficiencies and improvement opportunities. Return JSON with: process_efficiency_score (0-100), bottleneck_analysis (array), automation_opportunities (array), resource_optimization (object), time_savings_potential (number), cost_reduction_opportunities (array), user_experience_improvements (array)."
          },
          {
            role: "user",
            content: `Optimize process: Process: ${JSON.stringify(processData)} Metrics: ${JSON.stringify(performanceMetrics)} Feedback: ${JSON.stringify(userFeedback)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "medium"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Process optimization error:', error);
      return {
        ...aiUnavailableTag(error),
        process_efficiency_score: 68,
        bottleneck_analysis: ['Manual approval steps'],
        automation_opportunities: ['Email notifications', 'Status updates'],
        resource_optimization: { staff_reallocation: 'Focus on high-value tasks' },
        time_savings_potential: 120,
        cost_reduction_opportunities: ['Reduce manual processing'],
        user_experience_improvements: ['Simplified interfaces']
      };
    }
  }

  async predictMaintenanceSchedule(equipmentData, usagePatterns, environmentalFactors) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a predictive maintenance expert. Analyze equipment data to predict maintenance needs and prevent failures. Return JSON with: next_maintenance_date (ISO date), urgency_level (LOW/MEDIUM/HIGH/CRITICAL), predicted_failure_components (array), maintenance_cost_estimate (number), downtime_risk_hours (number), preventive_actions (array), roi_of_early_maintenance (number)."
          },
          {
            role: "user",
            content: `Predict maintenance: Equipment: ${JSON.stringify(equipmentData)} Usage: ${JSON.stringify(usagePatterns)} Environment: ${JSON.stringify(environmentalFactors)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Maintenance prediction error:', error);
      return {
        ...aiUnavailableTag(error),
        next_maintenance_date: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
        urgency_level: 'MEDIUM',
        predicted_failure_components: ['Bearings', 'Belts'],
        maintenance_cost_estimate: 1200,
        downtime_risk_hours: 4,
        preventive_actions: ['Lubrication check', 'Belt tension adjustment'],
        roi_of_early_maintenance: 2.3
      };
    }
  }

  // 🎯 CROSS-MODULE INTELLIGENT FEATURES
  async generateActionableInsights(moduleData, userRole, businessGoals) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a business intelligence expert. Generate actionable insights tailored to user roles and business goals. Return JSON with: priority_insights (array), recommended_actions (array with priority, effort, impact), performance_gaps (array), opportunity_ranking (array), kpi_recommendations (array), strategic_suggestions (array)."
          },
          {
            role: "user",
            content: `Generate insights for ${userRole}: Data: ${JSON.stringify(moduleData)} Goals: ${JSON.stringify(businessGoals)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "high"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Insights generation error:', error);
      return {
        ...aiUnavailableTag(error),
        priority_insights: ['Revenue growth opportunity detected'],
        recommended_actions: [
          { action: 'Optimize inventory levels', priority: 'HIGH', effort: 'MEDIUM', impact: 'HIGH' }
        ],
        performance_gaps: ['Supplier delivery times'],
        opportunity_ranking: ['Process automation', 'Cost reduction'],
        kpi_recommendations: ['Track supplier performance'],
        strategic_suggestions: ['Focus on high-margin products']
      };
    }
  }

  async intelligentSearch(query, contextModule, userRole) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an intelligent ERP search assistant. Interpret natural language queries and suggest relevant data, actions, or insights. Return JSON with: search_intent (string), suggested_filters (object), relevant_modules (array), recommended_actions (array), related_queries (array), confidence_score (0-100)."
          },
          {
            role: "user",
            content: `Search query: "${query}" Context: ${contextModule} User: ${userRole}`
          }
        ],
        reasoning_effort: "medium",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Intelligent search error:', error);
      return {
        ...aiUnavailableTag(error),
        search_intent: 'Find relevant data',
        suggested_filters: {},
        relevant_modules: [contextModule],
        recommended_actions: ['Review search results'],
        related_queries: [`Show ${contextModule} reports`],
        confidence_score: 60
      };
    }
  }

  // 🎪 ADVANCED AI FEATURES
  async generateSmartNotifications(userData, systemEvents, businessContext) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a smart notification system. Generate contextual, actionable notifications based on user role and business events. Return JSON with: notifications (array with message, priority, action_required, module, urgency), digest_summary (string), trend_alerts (array), opportunity_notifications (array)."
          },
          {
            role: "user",
            content: `Generate notifications: User: ${JSON.stringify(userData)} Events: ${JSON.stringify(systemEvents)} Context: ${JSON.stringify(businessContext)}`
          }
        ],
        reasoning_effort: "medium",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Smart notifications error:', error);
      return {
        ...aiUnavailableTag(error),
        notifications: [
          {
            message: 'Low stock alert: iPhone 15 Pro Max',
            priority: 'HIGH',
            action_required: true,
            module: 'inventory',
            urgency: 'IMMEDIATE'
          }
        ],
        digest_summary: 'No critical issues detected',
        trend_alerts: [],
        opportunity_notifications: []
      };
    }
  }

  async predictBusinessTrends(historicalData, externalFactors, industryData) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a business trend forecasting expert. Predict business trends and their impact on operations. Return JSON with: trend_predictions (array), market_opportunities (array), potential_disruptions (array), strategic_recommendations (array), confidence_levels (object), timeline_predictions (object), business_impact_assessment (object)."
          },
          {
            role: "user",
            content: `Predict business trends: Historical: ${JSON.stringify(historicalData)} External: ${JSON.stringify(externalFactors)} Industry: ${JSON.stringify(industryData)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "high"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Business trend prediction error:', error);
      return {
        ...aiUnavailableTag(error),
        trend_predictions: ['Technology adoption acceleration'],
        market_opportunities: ['Digital transformation services'],
        potential_disruptions: ['Supply chain volatility'],
        strategic_recommendations: ['Invest in automation'],
        confidence_levels: { short_term: 85, long_term: 60 },
        timeline_predictions: { peak_season: 'Q4 2025' },
        business_impact_assessment: { revenue_impact: 'POSITIVE' }
      };
    }
  }

  // 🤖 NATURAL LANGUAGE INTERFACE
  async processNaturalLanguageCommand(command, userContext, systemState) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an ERP natural language processor. Convert user commands into structured actions. Return JSON with: action_type (QUERY/CREATE/UPDATE/ANALYZE/REPORT), target_module (string), parameters (object), sql_query (string if applicable), ui_navigation (array), confidence_score (0-100), clarification_needed (boolean)."
          },
          {
            role: "user",
            content: `Process command: "${command}" User: ${JSON.stringify(userContext)} System: ${JSON.stringify(systemState)}`
          }
        ],
        reasoning_effort: "medium",
        verbosity: "low"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('NLP processing error:', error);
      return {
        ...aiUnavailableTag(error),
        action_type: 'QUERY',
        target_module: 'dashboard',
        parameters: {},
        sql_query: null,
        ui_navigation: ['dashboard'],
        confidence_score: 50,
        clarification_needed: true
      };
    }
  }

  // 📊 INTELLIGENT REPORTING
  async generateExecutiveSummary(allModuleData, timeframe, focusAreas) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are an executive report writer. Generate comprehensive business summaries with key insights and recommendations. Return JSON with: executive_summary (string), key_metrics (object), performance_highlights (array), areas_of_concern (array), strategic_recommendations (array), financial_summary (object), operational_summary (object), outlook (string)."
          },
          {
            role: "user",
            content: `Generate executive summary for ${timeframe}: Data: ${JSON.stringify(allModuleData)} Focus: ${JSON.stringify(focusAreas)}`
          }
        ],
        reasoning_effort: "high",
        verbosity: "high"
      });
      return safeJsonParse(completion.choices[0].message.content);
    } catch (error) {
      console.error('Executive summary error:', error);
      return {
        ...aiUnavailableTag(error),
        executive_summary: 'Business performance remains strong with growth opportunities identified.',
        key_metrics: { revenue_growth: '12%', cost_optimization: '8%' },
        performance_highlights: ['Successful Q3 performance'],
        areas_of_concern: ['Supplier concentration risk'],
        strategic_recommendations: ['Diversify supplier base'],
        financial_summary: { revenue: 50000, profit_margin: '21%' },
        operational_summary: { efficiency: 'High', automation: '35%' },
        outlook: 'Positive with strategic focus on growth and efficiency'
      };
    }
  }
}

module.exports = new AIModuleService();