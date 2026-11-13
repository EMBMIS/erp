// Manufacturing / MRP integration tests.
//
// The load-bearing assertion is that the cost flow balances: material issued
// must land in WIP, production must move it out again, and every journal entry
// produced along the way must balance. A manufacturing module that silently
// loses cost between raw materials and finished goods misstates inventory and
// margin at once, and does so quietly.
//
// Self-cleaning: everything seeded is tracked and removed, and account balances
// touched by the postings are restored.
//
// Run on its own:  npm run test:manufacturing

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const BillOfMaterial = require('../models/BillOfMaterial');
const WorkOrder = require('../models/WorkOrder');
const mrpService = require('../services/mrpService');

let dbAvailable = false;
let userId = null;
let balanceSnapshot = null;

const created = { itemIds: [], inventoryItemIds: [], bomIds: [], workOrderIds: [], journalEntryIds: [] };

async function makeItem(name) {
  const { rows } = await pool.query(
    `INSERT INTO items (item_code, stock_code, name, description, status, unit_of_measure, user_id)
     VALUES ($1, 'ST2', $2, 'manufacturing test', 'APPROVED', 'EA', $3) RETURNING id`,
    [`MFG${Math.random().toString(36).slice(2, 10)}`, name, userId]
  );
  created.itemIds.push(rows[0].id);
  return rows[0].id;
}

async function stockItem(itemId, qty, unitCost) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_items
       (item_master_id, current_stock_quantity, unit_price, currency, user_id, status)
     VALUES ($1,$2,$3,'USD',$4,'APPROVED') RETURNING id`,
    [itemId, qty, unitCost, userId]
  );
  created.inventoryItemIds.push(rows[0].id);
  return rows[0].id;
}

async function accountBalance(code) {
  const { rows } = await pool.query(
    'SELECT current_balance::float AS b FROM chart_of_accounts WHERE account_code = $1', [code]
  );
  return rows[0]?.b ?? 0;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (users.rows.length) {
      userId = users.rows[0].id;
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.workOrderIds) {
      await pool.query('DELETE FROM work_order_components WHERE work_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM work_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.bomIds) {
      await pool.query('DELETE FROM bom_components WHERE bom_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM bills_of_material WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query(
      `DELETE FROM journal_entry_items WHERE journal_entry_id IN (
         SELECT id FROM journal_entries WHERE source_type LIKE 'WORK_ORDER%')`).catch(() => {});
    await pool.query(`DELETE FROM journal_entries WHERE source_type LIKE 'WORK_ORDER%'`).catch(() => {});
    await pool.query(`DELETE FROM mrp_planned_orders WHERE item_id = ANY($1)`, [created.itemIds]).catch(() => {});
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
    // Restore every account balance the postings moved.
    if (balanceSnapshot) {
      for (const row of balanceSnapshot) {
        await pool.query('UPDATE chart_of_accounts SET current_balance = $2 WHERE id = $1',
          [row.id, row.current_balance]).catch(() => {});
      }
    }
  }
  await pool.end();
});

test('a bill of material explodes to the right component quantities, including scrap', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const widget = await makeItem('Test Widget');
  const bolt = await makeItem('Test Bolt');
  const plate = await makeItem('Test Plate');

  const bom = await BillOfMaterial.create({
    item_id: widget,
    description: 'Widget recipe',
    output_quantity: 10,               // recipe yields 10
    components: [
      { component_item_id: bolt, quantity_per: 40 },                    // 4 per unit
      { component_item_id: plate, quantity_per: 10, scrap_percent: 10 }, // 1 per unit +10% scrap
    ],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const exploded = await BillOfMaterial.explode(widget, 100);
  const byItem = new Map(exploded.total_requirements.map((r) => [r.item_id, r.quantity]));

  // 100 widgets = 10x the recipe.
  assert.equal(byItem.get(bolt), 400, 'bolts should scale by the recipe output quantity');
  assert.equal(byItem.get(plate), 110, 'plates should be grossed up by the 10% scrap rate');
});

test('a circular bill of material is rejected rather than exploding forever', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const a = await makeItem('Circular A');
  const b = await makeItem('Circular B');

  const bomA = await BillOfMaterial.create({ item_id: a, components: [{ component_item_id: b, quantity_per: 1 }] }, userId);
  created.bomIds.push(bomA.id);
  await BillOfMaterial.activate(bomA.id);

  // B containing A would close the loop.
  await assert.rejects(
    () => BillOfMaterial.create({ item_id: b, components: [{ component_item_id: a, quantity_per: 1 }] }, userId),
    /circular/i,
    'a cycle must be refused at write time, not discovered during MRP'
  );

  await assert.rejects(
    () => BillOfMaterial.create({ item_id: a, components: [{ component_item_id: a, quantity_per: 1 }] }, userId),
    /cannot be a component of itself/i
  );
});

test('the full production cycle moves cost through WIP and balances the ledger', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const chair = await makeItem('Test Chair');
  const leg = await makeItem('Test Leg');
  const seat = await makeItem('Test Seat');

  // 4 legs @ 5.00 and 1 seat @ 20.00 per chair = 40.00 material cost per chair.
  await stockItem(leg, 1000, 5);
  await stockItem(seat, 1000, 20);

  const bom = await BillOfMaterial.create({
    item_id: chair,
    output_quantity: 1,
    components: [
      { component_item_id: leg, quantity_per: 4 },
      { component_item_id: seat, quantity_per: 1 },
    ],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const wipBefore = await accountBalance('1135');
  const invBefore = await accountBalance('1130');

  const wo = await WorkOrder.create({ item_id: chair, quantity: 10 }, userId);
  created.workOrderIds.push(wo.id);
  assert.equal(wo.status, 'DRAFT');
  assert.equal(wo.components.length, 2);
  assert.equal(Number(wo.components.find((c) => c.component_item_id === leg).quantity_required), 40);

  await WorkOrder.release(wo.id, userId);

  // --- Issue materials: Dr WIP / Cr Inventory --------------------------------
  const issue = await WorkOrder.issueMaterials(wo.id, null, userId);
  assert.equal(issue.total_value, 400, '40 legs @5 + 10 seats @20 = 400');

  assert.equal(await accountBalance('1135'), wipBefore + 400, 'WIP should rise by the material cost');
  assert.equal(await accountBalance('1130'), invBefore - 400, 'Inventory should fall by the same amount');

  // Component stock must actually have moved.
  const legStock = await pool.query(
    'SELECT current_stock_quantity::float AS q FROM inventory_items WHERE item_master_id = $1', [leg]);
  assert.equal(legStock.rows[0].q, 960, '40 legs should have left stock');

  // --- Confirm production: Dr Inventory / Cr WIP -----------------------------
  const confirm = await WorkOrder.confirmProduction(wo.id, { quantity_produced: 10 }, userId);
  assert.equal(confirm.status, 'COMPLETED');
  assert.equal(confirm.value_capitalised, 400, 'all WIP should land in finished goods when nothing is scrapped');
  assert.equal(confirm.scrap_variance, 0);

  // WIP must be fully relieved — cost neither stranded nor duplicated.
  assert.equal(await accountBalance('1135'), wipBefore, 'WIP should return to its opening balance');
  assert.equal(await accountBalance('1130'), invBefore, 'inventory value should be conserved through the build');

  // Finished goods exist at the right unit cost.
  const chairStock = await pool.query(
    'SELECT current_stock_quantity::float AS q, unit_price::float AS c FROM inventory_items WHERE item_master_id = $1',
    [chair]);
  assert.equal(chairStock.rows[0].q, 10);
  assert.equal(chairStock.rows[0].c, 40, 'unit cost should be the 400 total over 10 units');

  // Every journal entry raised must balance.
  const entries = await pool.query(`
    SELECT je.journal_number,
           ROUND(SUM(jei.debit_amount),2)::float AS d,
           ROUND(SUM(jei.credit_amount),2)::float AS c
      FROM journal_entries je
      JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
     WHERE je.source_id = $1 AND je.source_type LIKE 'WORK_ORDER%'
     GROUP BY je.id, je.journal_number`, [wo.id]);
  assert.ok(entries.rows.length >= 2, 'issue and completion should each post an entry');
  entries.rows.forEach((e) => assert.equal(e.d, e.c, `${e.journal_number} is unbalanced`));
});

test('scrapped units take their cost to variance instead of into finished goods', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const gadget = await makeItem('Test Gadget');
  const part = await makeItem('Test Part');
  await stockItem(part, 500, 10);

  const bom = await BillOfMaterial.create({
    item_id: gadget, output_quantity: 1,
    components: [{ component_item_id: part, quantity_per: 1 }],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const wo = await WorkOrder.create({ item_id: gadget, quantity: 10 }, userId);
  created.workOrderIds.push(wo.id);
  await WorkOrder.release(wo.id, userId);

  const issue = await WorkOrder.issueMaterials(wo.id, null, userId);
  assert.equal(issue.total_value, 100, '10 parts @ 10');

  const varianceBefore = await accountBalance('5150');

  // 8 good, 2 scrapped: the scrapped units consumed material, so 20 of the 100
  // must go to variance rather than be capitalised into stock.
  const confirm = await WorkOrder.confirmProduction(wo.id, { quantity_produced: 8, quantity_scrapped: 2 }, userId);
  assert.equal(confirm.value_capitalised, 80);
  assert.equal(confirm.scrap_variance, 20);
  assert.equal(confirm.status, 'COMPLETED');

  assert.equal(await accountBalance('5150'), varianceBefore + 20, 'scrap cost should hit the variance account');
});

test('materials cannot be issued beyond available stock', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const thing = await makeItem('Test Thing');
  const scarce = await makeItem('Test Scarce Part');
  await stockItem(scarce, 5, 1); // only 5 on hand

  const bom = await BillOfMaterial.create({
    item_id: thing, output_quantity: 1,
    components: [{ component_item_id: scarce, quantity_per: 1 }],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const wo = await WorkOrder.create({ item_id: thing, quantity: 100 }, userId);
  created.workOrderIds.push(wo.id);
  await WorkOrder.release(wo.id, userId);

  await assert.rejects(
    () => WorkOrder.issueMaterials(wo.id, null, userId),
    /Insufficient stock/,
    'issuing must be blocked rather than driving stock negative'
  );

  // The failed issue must have rolled back cleanly — no partial consumption.
  const stock = await pool.query(
    'SELECT current_stock_quantity::float AS q FROM inventory_items WHERE item_master_id = $1', [scarce]);
  assert.equal(stock.rows[0].q, 5, 'a rejected issue must not consume any stock');
});

test('production cannot be confirmed before materials are issued, or beyond the ordered quantity', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const product = await makeItem('Test Product');
  const material = await makeItem('Test Material');
  await stockItem(material, 100, 2);

  const bom = await BillOfMaterial.create({
    item_id: product, output_quantity: 1,
    components: [{ component_item_id: material, quantity_per: 1 }],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const wo = await WorkOrder.create({ item_id: product, quantity: 5 }, userId);
  created.workOrderIds.push(wo.id);
  await WorkOrder.release(wo.id, userId);

  // Nothing issued yet, so there is no WIP to convert.
  await assert.rejects(
    () => WorkOrder.confirmProduction(wo.id, { quantity_produced: 5 }, userId),
    /IN_PROGRESS/,
    'confirming before issuing would create finished goods from no cost at all'
  );

  await WorkOrder.issueMaterials(wo.id, null, userId);

  await assert.rejects(
    () => WorkOrder.confirmProduction(wo.id, { quantity_produced: 99 }, userId),
    /exceed the ordered quantity/
  );
});

test('a work order cannot be created for an item with no active BOM', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const orphan = await makeItem('Test Orphan');
  await assert.rejects(
    () => WorkOrder.create({ item_id: orphan, quantity: 1 }, userId),
    /No active bill of material/
  );
});

test('MRP nets demand against stock and explodes MAKE orders into component demand', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const assembly = await makeItem('MRP Assembly');
  const component = await makeItem('MRP Component');

  // Assembly is below its reorder point, so it generates replenishment demand.
  const { rows: invRows } = await pool.query(
    `INSERT INTO inventory_items
       (item_master_id, current_stock_quantity, reorder_point, maximum_stock_level, unit_price, currency, user_id, status)
     VALUES ($1, 0, 10, 50, 100, 'USD', $2, 'APPROVED') RETURNING id`,
    [assembly, userId]);
  created.inventoryItemIds.push(invRows[0].id);

  // Component has plenty in stock — it must NOT be planned.
  await stockItem(component, 10000, 1);

  const bom = await BillOfMaterial.create({
    item_id: assembly, output_quantity: 1,
    components: [{ component_item_id: component, quantity_per: 2 }],
  }, userId);
  created.bomIds.push(bom.id);
  await BillOfMaterial.activate(bom.id);

  const result = await mrpService.runMrp({ persist: false });

  const assemblyPlan = result.planned_orders.find((p) => p.item_id === assembly);
  assert.ok(assemblyPlan, 'the below-reorder assembly should be planned');
  assert.equal(assemblyPlan.order_type, 'MAKE', 'an item with an active BOM is made, not bought');
  assert.equal(assemblyPlan.quantity, 50, 'should plan up to the maximum stock level');
  assert.equal(assemblyPlan.bom_level, 0);

  // The MAKE order creates dependent demand one level down, which is then netted
  // against the component's ample stock and needs no order.
  const componentPlan = result.planned_orders.find((p) => p.item_id === component);
  assert.ok(componentPlan, 'component demand should be derived from the parent MAKE order');
  assert.equal(componentPlan.bom_level, 1);
  assert.equal(componentPlan.gross_requirement, 100, '50 assemblies x 2 components');
  assert.equal(componentPlan.net_requirement, 0, 'ample stock means nothing to order');
  assert.match(componentPlan.rationale, /already covered/);
});
