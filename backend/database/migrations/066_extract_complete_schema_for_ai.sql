-- Migration: Extract complete database schema for AI configuration
-- This migration will query the actual database structure and generate 
-- a perfect schema configuration file for AI SQL generation

DO $$
DECLARE
    schema_output TEXT := '';
    table_record RECORD;
    column_record RECORD;
    constraint_record RECORD;
BEGIN
    -- Build complete schema output
    schema_output := 'const PERFECT_DATABASE_SCHEMA = `' || CHR(10);
    schema_output := schema_output || 'DATABASE SCHEMA (ERP System - PostgreSQL):' || CHR(10) || CHR(10);
    
    schema_output := schema_output || 'CRITICAL RULES FOR AI SQL GENERATION:' || CHR(10);
    schema_output := schema_output || '1. Always check this schema before generating SQL queries' || CHR(10);
    schema_output := schema_output || '2. Use soft deletes with ''deleted_at IS NULL'' conditions' || CHR(10);
    schema_output := schema_output || '3. All IDs are UUIDs unless specified otherwise' || CHR(10);
    schema_output := schema_output || '4. Use proper JOINs based on foreign key relationships' || CHR(10);
    schema_output := schema_output || '5. NEVER use columns that don''t exist in this schema' || CHR(10);
    schema_output := schema_output || '6. For items table: use user_id column for user assignment' || CHR(10);
    schema_output := schema_output || '7. Fill ALL available fields with comprehensive, realistic data' || CHR(10) || CHR(10);
    
    -- Loop through all tables
    FOR table_record IN 
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
    LOOP
        schema_output := schema_output || 'TABLE: ' || table_record.table_name || CHR(10);
        schema_output := schema_output || 'COLUMNS:' || CHR(10);
        
        -- Loop through columns for this table
        FOR column_record IN
            SELECT 
                c.column_name,
                c.data_type,
                c.character_maximum_length,
                c.is_nullable,
                c.column_default,
                CASE 
                    WHEN pk.column_name IS NOT NULL THEN 'YES'
                    ELSE 'NO'
                END as is_primary_key,
                CASE 
                    WHEN fk.column_name IS NOT NULL THEN 'YES'
                    ELSE 'NO'
                END as is_foreign_key
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT ku.table_name, ku.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
            LEFT JOIN (
                SELECT ku.table_name, ku.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
            ) fk ON c.table_name = fk.table_name AND c.column_name = fk.column_name
            WHERE c.table_name = table_record.table_name
            ORDER BY c.ordinal_position
        LOOP
            schema_output := schema_output || '  - ' || column_record.column_name || ': ' || column_record.data_type;
            
            IF column_record.character_maximum_length IS NOT NULL THEN
                schema_output := schema_output || '(' || column_record.character_maximum_length || ')';
            END IF;
            
            IF column_record.is_nullable = 'NO' THEN
                schema_output := schema_output || ' (NOT NULL)';
            END IF;
            
            IF column_record.is_primary_key = 'YES' THEN
                schema_output := schema_output || ' (PRIMARY KEY)';
            END IF;
            
            IF column_record.is_foreign_key = 'YES' THEN
                schema_output := schema_output || ' (FOREIGN KEY)';
            END IF;
            
            IF column_record.column_default IS NOT NULL THEN
                schema_output := schema_output || ' (DEFAULT: ' || column_record.column_default || ')';
            END IF;
            
            schema_output := schema_output || CHR(10);
        END LOOP;
        
        schema_output := schema_output || CHR(10);
    END LOOP;
    
    -- Add specific constraints and rules
    schema_output := schema_output || 'IMPORTANT CONSTRAINTS:' || CHR(10);
    schema_output := schema_output || '- items.stock_code: CHECK (stock_code IN (''ST1'', ''ST2'', ''NS3''))' || CHR(10);
    schema_output := schema_output || '- items.status: CHECK (status IN (''DRAFT'', ''PENDING_REVIEW'', ''APPROVED''))' || CHR(10);
    schema_output := schema_output || '- items.criticality: CHECK (criticality IN (''LOW'', ''MEDIUM'', ''HIGH''))' || CHR(10);
    schema_output := schema_output || '- items.user_id: NOT NULL (use for user assignment)' || CHR(10);
    schema_output := schema_output || '- All UUIDs generated with gen_random_uuid() or uuid_generate_v4()' || CHR(10) || CHR(10);
    
    schema_output := schema_output || 'USER ASSIGNMENT RULES:' || CHR(10);
    schema_output := schema_output || '- items table: use user_id column' || CHR(10);
    schema_output := schema_output || '- sales_orders table: use created_by column' || CHR(10);
    schema_output := schema_output || '- customers table: use created_by column' || CHR(10);
    schema_output := schema_output || '- suppliers table: use created_by column' || CHR(10) || CHR(10);
    
    schema_output := schema_output || 'COMPREHENSIVE DATA REQUIREMENTS:' || CHR(10);
    schema_output := schema_output || '- For Samsung S24 Ultra: include manufacturer=''Samsung'', proper pricing, technical specs' || CHR(10);
    schema_output := schema_output || '- Fill manufacturer, manufacturer_part_number, unspsc_code, unit_price when available' || CHR(10);
    schema_output := schema_output || '- Use realistic values: phones $800-1200, laptops $1000-3000, etc.' || CHR(10);
    schema_output := schema_output || '- Include proper descriptions, technical specifications' || CHR(10);
    schema_output := schema_output || '`;' || CHR(10) || CHR(10);
    
    schema_output := schema_output || 'module.exports = { PERFECT_DATABASE_SCHEMA };';
    
    -- Write the schema to a temporary table for extraction
    DROP TABLE IF EXISTS temp_ai_schema;
    CREATE TEMP TABLE temp_ai_schema (schema_content TEXT);
    INSERT INTO temp_ai_schema (schema_content) VALUES (schema_output);
    
    -- Log completion
    RAISE NOTICE 'Perfect database schema generated! Extract with: SELECT schema_content FROM temp_ai_schema;';
END $$;