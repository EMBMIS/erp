/**
 * Server-Sent Events (SSE) Live Event Manager.
 * Maintains client connections and broadcasts real-time ERP events
 * (AI findings, Sales Order approvals, MRP reorder alerts) to active user browser sessions.
 */

class SSEService {
  constructor() {
    this.clients = new Set();
  }

  /**
   * Add a new SSE client HTTP response connection.
   */
  addClient(res, userId) {
    const client = { res, userId, connectedAt: new Date() };
    this.clients.add(client);

    res.on('close', () => {
      this.clients.delete(client);
    });
  }

  /**
   * Broadcast an event message to all connected SSE clients or specific user.
   */
  broadcast(eventType, payload, targetUserId = null) {
    const data = JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() });
    for (const client of this.clients) {
      if (!targetUserId || client.userId === targetUserId) {
        client.res.write(`event: ${eventType}\ndata: ${data}\n\n`);
      }
    }
  }
}

const sseManager = new SSEService();
module.exports = sseManager;
