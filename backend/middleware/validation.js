const Joi = require('joi');

const itemSchema = Joi.object({
  name: Joi.string().min(2).max(255).required(),
  description: Joi.string().max(1000).allow(''),
  is_stock_item: Joi.boolean().default(true),
  planned_stock: Joi.boolean().default(false),
  status: Joi.string().valid('DRAFT', 'PENDING_REVIEW', 'APPROVED').default('DRAFT'),
  criticality: Joi.string().valid('LOW', 'MEDIUM', 'HIGH').default('LOW'),
  unit_of_measure: Joi.string().min(1).max(20).default('pcs'),
  unspsc_code: Joi.string().pattern(/^\d{8}$/).allow('').messages({
    'string.pattern.base': 'UNSPSC code must be 8 digits'
  }),
  manufacturer: Joi.string().max(255).allow(''),
  manufacturer_part_number: Joi.string().max(100).allow(''),
  item_category: Joi.string().max(100).allow(''),
  serial_number: Joi.string().max(100).allow(''),
  equipment_tag: Joi.string().max(50).allow(''),
  has_contract: Joi.boolean().default(false),
  contract_number: Joi.string().max(50).allow('').when('has_contract', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.allow('')
  }),
  has_barcode: Joi.boolean().default(false),
  barcode: Joi.string().max(100).allow('').when('has_barcode', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.allow('')
  }),
  mass_per_uom: Joi.number().positive().allow('', null),
  volume_per_uom: Joi.number().positive().allow('', null)
});

const updateItemSchema = Joi.object({
  name: Joi.string().min(2).max(255),
  description: Joi.string().max(1000).allow(''),
  is_stock_item: Joi.boolean(),
  planned_stock: Joi.boolean(),
  status: Joi.string().valid('DRAFT', 'PENDING_REVIEW', 'APPROVED'),
  criticality: Joi.string().valid('LOW', 'MEDIUM', 'HIGH'),
  unit_of_measure: Joi.string().min(1).max(20),
  unspsc_code: Joi.string().pattern(/^\d{8}$/).allow('').messages({
    'string.pattern.base': 'UNSPSC code must be 8 digits'
  }),
  manufacturer: Joi.string().max(255).allow(''),
  manufacturer_part_number: Joi.string().max(100).allow(''),
  item_category: Joi.string().max(100).allow(''),
  serial_number: Joi.string().max(100).allow(''),
  equipment_tag: Joi.string().max(50).allow(''),
  has_contract: Joi.boolean(),
  contract_number: Joi.string().max(50).allow('').when('has_contract', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.allow('')
  }),
  has_barcode: Joi.boolean(),
  barcode: Joi.string().max(100).allow('').when('has_barcode', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.allow('')
  }),
  mass_per_uom: Joi.number().positive().allow('', null),
  volume_per_uom: Joi.number().positive().allow('', null)
});

const filterSchema = Joi.object({
  status: Joi.string().valid('DRAFT', 'PENDING_REVIEW', 'APPROVED'),
  stock_code: Joi.string().valid('ST1', 'ST2', 'NS3'),
  is_stock_item: Joi.boolean(),
  planned_stock: Joi.boolean(),
  criticality: Joi.string().valid('LOW', 'MEDIUM', 'HIGH'),
  search: Joi.string().max(255),
  limit: Joi.number().integer().min(1).max(100),
  offset: Joi.number().integer().min(0)
});

const validateItem = (req, res, next) => {
  const { error, value } = itemSchema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }
  
  req.body = value;
  next();
};

const validateUpdateItem = (req, res, next) => {
  const { error, value } = updateItemSchema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }
  
  req.body = value;
  next();
};

const validateFilters = (req, res, next) => {
  const { error, value } = filterSchema.validate(req.query);
  
  if (error) {
    return res.status(400).json({
      error: 'Invalid filters',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });
  }
  
  req.query = value;
  next();
};

const validateUUID = (req, res, next) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(req.params.id)) {
    return res.status(400).json({
      error: 'Invalid ID format'
    });
  }
  
  next();
};

module.exports = {
  validateItem,
  validateUpdateItem,
  validateFilters,
  validateUUID
};