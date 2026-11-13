const { pool } = require('../config/database');
const intelligentSchemaAnalyzer = require('./intelligentSchemaAnalyzer');

/**
 * PostgreSQL Schema Extractor for Simeli SQL Agent
 * Extracts complete database schema with tables, columns, relationships, constraints
 * Now optimized with intelligent table selection
 */
class SchemaExtractor {
  constructor() {
    this.schema = null;
    this.lastUpdated = null;
    this.extractionInProgress = false;
    this.extractionPromise = null;
    this.partialSchemas = new Map(); // Cache partial schemas by table list
  }

  /**
   * Extract complete PostgreSQL schema
   */
  async extractCompleteSchema() {
    // Prevent concurrent extractions
    if (this.extractionInProgress) {
      console.log('⏳ Schema extraction already in progress, waiting...');
      return await this.extractionPromise;
    }
    
    this.extractionInProgress = true;
    this.extractionPromise = this._performExtraction();
    
    try {
      const result = await this.extractionPromise;
      this.extractionInProgress = false;
      this.extractionPromise = null;
      return result;
    } catch (error) {
      this.extractionInProgress = false;
      this.extractionPromise = null;
      throw error;
    }
  }
  
  /**
   * Perform the actual schema extraction
   */
  async _performExtraction() {
    try {
      console.log('🔍 Extracting complete PostgreSQL schema...');
      
      const schema = {
        database_name: 'ERP System Database',
        extracted_at: new Date().toISOString(),
        tables: {},
        relationships: [],
        constraints: [],
        indexes: []
      };

      // Get all tables
      const tablesQuery = `
        SELECT 
          t.table_name,
          t.table_type,
          obj_description(c.oid) as table_comment
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        WHERE t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `;
      
      const tablesResult = await pool.query(tablesQuery);
      console.log(`📋 Found ${tablesResult.rows.length} tables`);

      // Process each table
      for (const table of tablesResult.rows) {
        const tableName = table.table_name;
        console.log(`  🔍 Processing table: ${tableName}`);
        
        // Get columns with detailed information
        const columnsQuery = `
          SELECT 
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.ordinal_position,
            col_description(pgc.oid, c.ordinal_position) as column_comment
          FROM information_schema.columns c
          LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
          WHERE c.table_name = $1 
          AND c.table_schema = 'public'
          ORDER BY c.ordinal_position
        `;
        
        const columnsResult = await pool.query(columnsQuery, [tableName]);
        
        // Get primary keys
        const primaryKeysQuery = `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'PRIMARY KEY'
        `;
        
        const primaryKeysResult = await pool.query(primaryKeysQuery, [tableName]);
        const primaryKeys = primaryKeysResult.rows.map(row => row.column_name);
        
        // Get foreign keys
        const foreignKeysQuery = `
          SELECT 
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu 
            ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'FOREIGN KEY'
        `;
        
        const foreignKeysResult = await pool.query(foreignKeysQuery, [tableName]);
        
        // Get check constraints
        const checkConstraintsQuery = `
          SELECT 
            tc.constraint_name,
            pg_get_constraintdef(pgc.oid) as constraint_definition
          FROM information_schema.table_constraints tc
          JOIN pg_constraint pgc ON pgc.conname = tc.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'CHECK'
        `;
        
        const checkConstraintsResult = await pool.query(checkConstraintsQuery, [tableName]);
        
        // Get unique constraints
        const uniqueConstraintsQuery = `
          SELECT 
            kcu.column_name,
            tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'UNIQUE'
        `;
        
        const uniqueConstraintsResult = await pool.query(uniqueConstraintsQuery, [tableName]);
        
        // Build table schema
        schema.tables[tableName] = {
          table_name: tableName,
          table_type: table.table_type,
          comment: table.table_comment,
          columns: columnsResult.rows.map(col => ({
            name: col.column_name,
            data_type: col.data_type,
            is_nullable: col.is_nullable === 'YES',
            is_primary_key: primaryKeys.includes(col.column_name),
            is_foreign_key: foreignKeysResult.rows.some(fk => fk.column_name === col.column_name),
            column_default: col.column_default,
            character_maximum_length: col.character_maximum_length,
            numeric_precision: col.numeric_precision,
            numeric_scale: col.numeric_scale,
            ordinal_position: col.ordinal_position,
            comment: col.column_comment,
            required: col.is_nullable === 'NO' && !col.column_default && col.column_name !== 'id'
          })),
          primary_keys: primaryKeys,
          foreign_keys: foreignKeysResult.rows,
          check_constraints: checkConstraintsResult.rows,
          unique_constraints: uniqueConstraintsResult.rows.map(uc => ({
            column: uc.column_name,
            constraint_name: uc.constraint_name
          }))
        };
        
        // Add relationships to global list
        foreignKeysResult.rows.forEach(fk => {
          schema.relationships.push({
            from_table: tableName,
            from_column: fk.column_name,
            to_table: fk.foreign_table_name,
            to_column: fk.foreign_column_name,
            constraint_name: fk.constraint_name,
            relationship_type: 'foreign_key'
          });
        });
      }
      
      // Get indexes
      const indexesQuery = `
        SELECT 
          schemaname,
          tablename,
          indexname,
          indexdef
        FROM pg_indexes 
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname
      `;
      
      const indexesResult = await pool.query(indexesQuery);
      schema.indexes = indexesResult.rows;
      
      console.log('✅ Schema extraction complete');
      console.log(`📊 Summary: ${Object.keys(schema.tables).length} tables, ${schema.relationships.length} relationships, ${schema.indexes.length} indexes`);
      
      this.schema = schema;
      this.lastUpdated = Date.now(); // Use timestamp for consistency
      
      return schema;
      
    } catch (error) {
      console.error('❌ Schema extraction failed:', error);
      throw error;
    }
  }

  /**
   * Get cached schema or extract fresh
   */
  async getSchema(forceRefresh = false) {
    // Double-check locking pattern to prevent race conditions
    const now = Date.now();
    const cacheAge = this.lastUpdated ? now - this.lastUpdated : Infinity;
    const isCacheValid = this.schema && this.lastUpdated && cacheAge < 300000; // 5 minutes cache
    
    console.log(`🔍 Schema cache check - Last updated: ${this.lastUpdated ? new Date(this.lastUpdated).toISOString() : 'Never'}`);
    console.log(`🔍 Cache age: ${Math.round(cacheAge/1000)}s, Valid: ${isCacheValid}`);
    
    // If extraction is in progress, wait for it
    if (this.extractionInProgress) {
      console.log('⏳ Schema extraction in progress, waiting for completion...');
      return await this.extractionPromise;
    }
    
    if (!isCacheValid || forceRefresh) {
      console.log(`🔄 Schema cache ${forceRefresh ? 'forced refresh' : 'expired'} - extracting fresh schema`);
      return await this.extractCompleteSchema();
    } else {
      console.log(`✅ Using cached schema (age: ${Math.round(cacheAge/1000)}s)`);
    }
    
    return this.schema;
  }

  /**
   * Get schema optimized for SQL Agent (intelligent selection)
   */
  async getSchemaForSQLAgent(naturalLanguageQuery = '', intentType = 'database_query') {
    // If no query provided, return cached full schema
    if (!naturalLanguageQuery.trim()) {
      const fullSchema = await this.getSchema();
      return this._compressSchema(fullSchema);
    }

    // Use intelligent analysis to select relevant tables
    const analysis = intelligentSchemaAnalyzer.analyzeQueryIntent(naturalLanguageQuery, intentType);
    const relevantTables = analysis.relevantTables;
    
    // Check if we have cached partial schema for these tables
    const cacheKey = relevantTables.sort().join(',');
    if (this.partialSchemas.has(cacheKey)) {
      const cachedSchema = this.partialSchemas.get(cacheKey);
      if (cachedSchema.timestamp && (Date.now() - cachedSchema.timestamp < 300000)) { // 5 minutes
        console.log(`✅ Using cached partial schema for ${relevantTables.length} tables`);
        return cachedSchema.data;
      }
    }

    // Extract schema for only relevant tables
    console.log(`🎯 Extracting optimized schema for ${relevantTables.length} relevant tables`);
    const partialSchema = await this._extractPartialSchema(relevantTables);
    const compressedSchema = this._compressSchema(partialSchema);

    // Cache the result
    this.partialSchemas.set(cacheKey, {
      data: compressedSchema,
      timestamp: Date.now()
    });

    return compressedSchema;
  }

  /**
   * Extract schema for specific tables only
   */
  async _extractPartialSchema(tableNames) {
    try {
      console.log(`🔍 Extracting partial schema for tables:`, tableNames);
      
      const schema = {
        database_name: 'ERP System Database (Partial)',
        extracted_at: new Date().toISOString(),
        tables: {},
        relationships: [],
        constraints: [],
        indexes: []
      };

      // Get table information for specified tables only
      const placeholders = tableNames.map((_, i) => `$${i + 1}`).join(', ');
      const tablesQuery = `
        SELECT 
          t.table_name,
          t.table_type,
          obj_description(c.oid) as table_comment
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.relname = t.table_name
        WHERE t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
        AND t.table_name = ANY($1)
        ORDER BY t.table_name
      `;
      
      const tablesResult = await pool.query(tablesQuery, [tableNames]);
      console.log(`📋 Found ${tablesResult.rows.length}/${tableNames.length} requested tables`);

      // Process each table (same as before but for selected tables only)
      for (const table of tablesResult.rows) {
        const tableName = table.table_name;
        console.log(`  🔍 Processing table: ${tableName}`);
        
        // Get columns, primary keys, foreign keys, etc. (same queries as before)
        const columnsResult = await pool.query(`
          SELECT 
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.ordinal_position,
            col_description(pgc.oid, c.ordinal_position) as column_comment
          FROM information_schema.columns c
          LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
          WHERE c.table_name = $1 
          AND c.table_schema = 'public'
          ORDER BY c.ordinal_position
        `, [tableName]);
        
        const primaryKeysResult = await pool.query(`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'PRIMARY KEY'
        `, [tableName]);
        
        const foreignKeysResult = await pool.query(`
          SELECT 
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu 
            ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = $1 
          AND tc.constraint_type = 'FOREIGN KEY'
        `, [tableName]);

        const primaryKeys = primaryKeysResult.rows.map(row => row.column_name);

        // Build table schema
        schema.tables[tableName] = {
          table_name: tableName,
          table_type: table.table_type,
          comment: table.table_comment,
          columns: columnsResult.rows.map(col => ({
            name: col.column_name,
            data_type: col.data_type,
            is_nullable: col.is_nullable === 'YES',
            is_primary_key: primaryKeys.includes(col.column_name),
            is_foreign_key: foreignKeysResult.rows.some(fk => fk.column_name === col.column_name),
            column_default: col.column_default,
            character_maximum_length: col.character_maximum_length,
            numeric_precision: col.numeric_precision,
            numeric_scale: col.numeric_scale,
            ordinal_position: col.ordinal_position,
            comment: col.column_comment,
            required: col.is_nullable === 'NO' && !col.column_default && col.column_name !== 'id'
          })),
          primary_keys: primaryKeys,
          foreign_keys: foreignKeysResult.rows,
          check_constraints: [],
          unique_constraints: []
        };

        // Add relationships to global list
        foreignKeysResult.rows.forEach(fk => {
          schema.relationships.push({
            from_table: tableName,
            from_column: fk.column_name,
            to_table: fk.foreign_table_name,
            to_column: fk.foreign_column_name,
            constraint_name: fk.constraint_name,
            relationship_type: 'foreign_key'
          });
        });
      }
      
      console.log(`✅ Partial schema extraction complete: ${Object.keys(schema.tables).length} tables`);
      return schema;
      
    } catch (error) {
      console.error('❌ Partial schema extraction failed:', error);
      throw error;
    }
  }

  /**
   * Compress schema for AI consumption
   */
  _compressSchema(fullSchema) {
    const compressedSchema = {
      database: 'ERP System',
      tables: {}
    };
    
    Object.entries(fullSchema.tables).forEach(([tableName, tableInfo]) => {
      // Add table description from intelligent analyzer
      const descriptions = intelligentSchemaAnalyzer.getTableDescriptions([tableName]);
      
      compressedSchema.tables[tableName] = {
        description: descriptions[tableName] || `${tableName} table`,
        columns: tableInfo.columns.map(col => ({
          name: col.name,
          type: col.data_type,
          nullable: col.is_nullable,
          pk: col.is_primary_key,
          fk: col.is_foreign_key,
          required: col.required,
          default: col.column_default ? true : false
        })),
        relationships: tableInfo.foreign_keys?.map(fk => ({
          column: fk.column_name,
          references: `${fk.foreign_table_name}.${fk.foreign_column_name}`
        })) || [],
        constraints: tableInfo.check_constraints?.map(cc => cc.constraint_definition) || [],
        user_filtered: intelligentSchemaAnalyzer.requiresUserFiltering(tableName),
        user_column: intelligentSchemaAnalyzer.getUserFilterColumn(tableName)
      };
    });
    
    return compressedSchema;
  }

  /**
   * Get table information for specific table
   */
  async getTableInfo(tableName) {
    const schema = await this.getSchema();
    return schema.tables[tableName] || null;
  }

  /**
   * Get relationships for knowledge graph
   */
  async getRelationships() {
    const schema = await this.getSchema();
    return schema.relationships;
  }
}

module.exports = new SchemaExtractor();