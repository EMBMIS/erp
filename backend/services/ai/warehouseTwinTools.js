/**
 * "A rack that is short is short on the screen — and Simeli already knows
 * which order that puts at risk" — as a tool.
 *
 * The model lives in services/warehouseTwin.js so the Warehouse screens,
 * applications built in Sandbox and Simeli read the same answer. It answers as
 * the person asking: the customer orders it names are only the ones their role
 * can see.
 *
 * It is a READ tool. Its proposals are proposals; expediting, re-planning or
 * counting a bay goes through the ordinary draft-and-approve path, and an
 * order's recovery plan is approved by a manager on the order.
 */

const { assessWarehouse } = require('../warehouseTwin');

const warehouseTwinTools = [
  {
    name: 'read_warehouse_twin',
    description:
      'The warehouse as it stands, bay by bay — from this company\'s storage locations, bins, the stock placed in them, '
      + 'goods issues and the delivery trace. For each bay: what is on it, how many days it lasts at the item\'s pace '
      + '(goods issued over 90 days, or the orders due if faster), its fill, and whether it is SHORT (the company\'s stock '
      + 'of an item it holds cannot cover an order line due in the horizon — the orders are named), LOW (under 7 days or at '
      + 'the reorder point), OK, IDLE or EMPTY. Per location: bays short and low, orders and value at risk, transfers in '
      + 'transit. Also stock on the item record that no bay holds. Returns a CHAIN bay -> dependency -> order, and '
      + 'proposals.\n\n'
      + 'Use it for "show me the warehouse", "which bays are short", "what is in bay 00010014", "what does Rotterdam hold", '
      + '"which order does that shortage put at risk", "where is item X stored". Lead with the short bays and the orders '
      + 'they reach, then low cover. Name bays by code and location. Offer the proposals as proposals; a fix for a late '
      + 'order is approved by a manager on the order (plan_delivery_recovery shows it). Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'One storage location, by code, name, city or id. Omit for all.' },
        bin: { type: 'string', description: 'One bay, by bin code. Optional.' },
        horizon_days: { type: 'integer', description: 'How far ahead orders count, in days. Default 21.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const r = await assessWarehouse({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        location: args.location,
        bin: args.bin,
        horizonDays: args.horizon_days,
      });
      if (r.error) return r;
      // The answer, not the whole floor: bays with something to say first,
      // and a bounded number of quiet ones.
      const loud = r.bays.filter((b) => b.status === 'short' || b.status === 'low');
      const quiet = r.bays.filter((b) => b.status !== 'short' && b.status !== 'low').slice(0, args.bin ? 10 : 8);
      return {
        ...r,
        bays: [...loud.slice(0, 25), ...quiet].map((b) => ({
          ...b,
          items: b.items.slice(0, 6).map(({ orders, ...i }) => ({ ...i, orders: orders.map((o) => o.so_number) })),
        })),
        bays_not_listed: Math.max(0, r.bays.length - loud.slice(0, 25).length - quiet.length),
      };
    },
  },
];

module.exports = { warehouseTwinTools };
