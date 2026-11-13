// Smart UNSPSC Classification System
// Uses AI-powered classification with common industrial categories

// Top-level UNSPSC segments for industrial/business use
const unspscSegments = {
  '10': 'Live Plant and Animal Material and Accessories',
  '11': 'Mining and Well Drilling Machinery and Accessories',
  '12': 'Oil and Gas Extraction and Refining',
  '13': 'Nuclear and Renewable Energy',
  '14': 'Medical Equipment and Supplies',
  '15': 'Industrial and Manufacturing Chemicals',
  '20': 'Mining Machinery and Equipment',
  '21': 'Farm and Garden Machinery',
  '22': 'Building and Construction Machinery',
  '23': 'Material Handling and Transport Equipment',
  '24': 'Commercial and Industrial Machinery',
  '25': 'Vehicles and Transport Equipment',
  '26': 'Power Generation and Distribution Equipment',
  '27': 'Tools and General Machinery',
  '30': 'Structures and Building Materials',
  '31': 'Manufacturing Components and Supplies',
  '32': 'Electronic Components and Supplies',
  '39': 'Electrical Systems and Components',
  '40': 'Industrial Equipment',
  '41': 'Laboratory and Scientific Equipment',
  '42': 'Medical Equipment',
  '43': 'Information Technology Equipment',
  '44': 'Office Equipment and Accessories',
  '46': 'Safety and Security Equipment',
  '50': 'Food Beverage and Tobacco Products',
  '53': 'Apparel and Luggage',
  '56': 'Furniture and Furnishings',
  '60': 'Musical Instruments',
  '70': 'Farming and Fishing',
  '72': 'Industrial and Technical Services',
  '73': 'Building and Facility Services',
  '76': 'Financial and Insurance Services',
  '80': 'Management and Business Services',
  '81': 'Engineering and Research Services',
  '82': 'Training Services',
  '83': 'Transportation and Storage Services',
  '84': 'Cleaning Services',
  '85': 'Travel and Food Services',
  '86': 'Security and Safety Services',
  '90': 'Personal Care Services',
  '91': 'Health and Social Services',
  '92': 'Education and Training Services',
  '93': 'Politics and Civil Services',
  '94': 'Organizations and Clubs',
  '95': 'Utilities and Public Services'
};

// Common families for frequently used categories
const commonFamilies = {
  // Fasteners (31-16)
  '31161501': 'Bolts',
  '31161502': 'Nuts',
  '31161503': 'Screws',
  '31161504': 'Washers',
  '31161505': 'Rivets',
  
  // Bearings (40-16)
  '40161500': 'Bearings',
  '40161600': 'Ball bearings',
  '40161700': 'Roller bearings',
  
  // Pumps (40-10)
  '40101500': 'Pumps and pumping equipment',
  '40101600': 'Heating equipment',
  '40101700': 'Compressors',
  
  // Motors (40-12)
  '40121500': 'Motors and generators',
  '40121600': 'Motor parts',
  
  // Electrical (39-12)
  '39121400': 'Electrical cables and wires',
  '39121500': 'Electrical connectors',
  '39121600': 'Switches',
  
  // Electronics (32-14)
  '32141600': 'Semiconductors',
  '32141700': 'Electronic components',
  
  // Tools (27-11)
  '27112100': 'Hand tools',
  '27112200': 'Power tools',
  '27112300': 'Measuring tools',
  
  // Safety (46-18)
  '46181500': 'Personal protective equipment',
  '46181600': 'Safety equipment',
  
  // Materials - Steel (30-10)
  '30102500': 'Steel products',
  '30102600': 'Aluminum products',
  '30102700': 'Metal products',
  
  // Chemicals (15-12)
  '15121800': 'Lubricants and oils',
  '15121900': 'Industrial fluids',
  
  // IT Equipment (43-21)
  '43211500': 'Computers and accessories',
  '43212000': 'Printers and peripherals',
  
  // Office (44-12)
  '44121500': 'Office supplies',
  
  // Vehicles (25-10)
  '25101500': 'Passenger vehicles',
  '25101600': 'Commercial vehicles',
  
  // Vehicle parts (25-17)
  '25172100': 'Tires and wheels',
  '25172400': 'Engine components',
  
  // Services (72-14)
  '72141501': 'Maintenance and repair services',
  '81101500': 'Engineering services',
  '82101500': 'Training services'
};

// Smart classification function using AI-friendly prompts
function classifyItemSmart(itemName, description = '') {
  const searchText = `${itemName} ${description}`.toLowerCase();
  
  // Quick keyword matching for common items
  const quickMatches = {
    'bolt': '31161501',
    'nut': '31161502', 
    'screw': '31161503',
    'washer': '31161504',
    'bearing': '40161500',
    'pump': '40101500',
    'motor': '40121500',
    'cable': '39121400',
    'wire': '39121400',
    'tool': '27112100',
    'computer': '43211500',
    'steel': '30102500',
    'aluminum': '30102600',
    'oil': '15121800',
    'lubricant': '15121800',
    'service': '72141501',
    'safety': '46181500',
    'electronic': '32141600',
    'vehicle': '25101500',
    'tire': '25172100'
  };
  
  // Check for exact keyword matches first
  for (const [keyword, code] of Object.entries(quickMatches)) {
    if (searchText.includes(keyword)) {
      return {
        code: code,
        description: commonFamilies[code] || 'Industrial item',
        confidence: 'high'
      };
    }
  }
  
  // Fallback to segment classification
  if (searchText.includes('service')) return { code: '72141501', description: 'Professional services', confidence: 'medium' };
  if (searchText.includes('equipment')) return { code: '40101500', description: 'Industrial equipment', confidence: 'medium' };
  if (searchText.includes('part') || searchText.includes('component')) return { code: '31161501', description: 'Manufacturing components', confidence: 'medium' };
  if (searchText.includes('chemical')) return { code: '15121800', description: 'Industrial chemicals', confidence: 'medium' };
  if (searchText.includes('material')) return { code: '30102500', description: 'Construction materials', confidence: 'medium' };
  
  // Default industrial equipment
  return { code: '40101500', description: 'Industrial equipment and supplies', confidence: 'low' };
}

// Generate UNSPSC-informed prompt for AI
function generateUnspscPrompt(itemName, description = '') {
  const classification = classifyItemSmart(itemName, description);
  
  return {
    suggestedCode: classification.code,
    suggestedDescription: classification.description,
    confidence: classification.confidence,
    segment: classification.code.substring(0, 2),
    segmentName: unspscSegments[classification.code.substring(0, 2)] || 'Industrial Products'
  };
}

// Validate UNSPSC code format
function validateUnspscCode(code) {
  return /^\d{8}$/.test(code);
}

// Get segment info
function getSegmentInfo(code) {
  if (!validateUnspscCode(code)) return null;
  
  const segment = code.substring(0, 2);
  return {
    segment: segment,
    segmentName: unspscSegments[segment] || 'Unknown Segment'
  };
}

module.exports = {
  unspscSegments,
  commonFamilies,
  classifyItemSmart,
  generateUnspscPrompt,
  validateUnspscCode,
  getSegmentInfo
};