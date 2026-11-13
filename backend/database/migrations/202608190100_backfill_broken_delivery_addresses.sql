-- Backfill sales_orders/sales_quotations rows whose delivery_address was
-- written by the old '+'-concatenation bug (fixed in commits 9ba0006 and
-- 153bfbe) before those fixes landed. Those rows persisted a literal string
-- like "123 Main St, null, null" or just "null, null" whenever the customer
-- had no city/state/country on file, and the client-side fix only prevents
-- *new* bad writes — it doesn't repair rows already in the database.
--
-- Reconstructs delivery_address from the linked customer's billing address
-- using the same "join the non-empty parts" logic as SalesOrderCreate.jsx /
-- SalesOrderEdit.jsx / SalesQuotationCreate.jsx / SalesQuotationEdit.jsx, so
-- the backfilled value matches what a fresh create/edit would produce today.
-- Only touches rows that actually contain the literal "null" token, so
-- legitimate addresses (including ones that happen to contain other text)
-- are left untouched.

UPDATE sales_orders so
   SET delivery_address = NULLIF(TRIM(BOTH ', ' FROM CONCAT_WS(', ',
         NULLIF(TRIM(c.billing_address_line1), ''),
         NULLIF(TRIM(c.billing_address_line2), ''),
         NULLIF(TRIM(c.billing_city), ''),
         NULLIF(TRIM(c.billing_state), ''),
         NULLIF(TRIM(c.billing_country), '')
       )), '')
  FROM customers c
 WHERE so.customer_id = c.id
   AND so.delivery_address ~* '(^|,\s*)null(\s*,|$)';

UPDATE sales_quotations sq
   SET delivery_address = NULLIF(TRIM(BOTH ', ' FROM CONCAT_WS(', ',
         NULLIF(TRIM(c.billing_address_line1), ''),
         NULLIF(TRIM(c.billing_address_line2), ''),
         NULLIF(TRIM(c.billing_city), ''),
         NULLIF(TRIM(c.billing_state), ''),
         NULLIF(TRIM(c.billing_country), '')
       )), '')
  FROM customers c
 WHERE sq.customer_id = c.id
   AND sq.delivery_address ~* '(^|,\s*)null(\s*,|$)';
