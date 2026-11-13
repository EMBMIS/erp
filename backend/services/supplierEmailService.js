const crypto = require('crypto');
const { appBase } = require('../config/appLinks');
const { sendMail, businessLabel } = require('../config/sender');

class SupplierEmailService {
  // Sending goes through config/sender.js — Resend when configured (the only
  // transport that can carry the @embmis.com From-address policy), SMTP for
  // local dev.

  // Generate a secure confirmation token
  generateConfirmationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Send item assignment confirmation request to supplier
  async sendItemAssignmentConfirmation(supplier, items, requestedBy, confirmationToken = null) {
    try {
      // Use provided token or generate new one (for backward compatibility)
      const token = confirmationToken || this.generateConfirmationToken();
      
      // Create confirmation URL (will be used by supplier to confirm/reject)
      const baseUrl = appBase();
      const confirmUrl = `${baseUrl}/supplier/confirm-items/${token}`;
      
      // Prepare email content
      const itemsList = items.map(item => 
        `• ${item.item_name} (${item.sku}) - ${item.category}`
      ).join('\n');
      
      const subject = `Item Assignment Confirmation Request - ${supplier.legal_name}`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-bottom: 20px;">Item Assignment Confirmation Request</h2>
          
          <p>Dear ${supplier.legal_name} Team,</p>
          
          <p>We would like to assign the following inventory items to your supplier profile for potential delivery:</p>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #1f2937;">Items to Confirm:</h3>
            <pre style="white-space: pre-wrap; font-family: monospace; margin: 0;">${itemsList}</pre>
          </div>
          
          <p>Please review these items and confirm whether you can supply them. This helps us maintain accurate supplier capabilities in our system.</p>
          
          <div style="margin: 30px 0; text-align: center;">
            <a href="${confirmUrl}" style="display: inline-block; background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">
              Review & Confirm Items
            </a>
          </div>
          
          <p style="color: #6b7280; font-size: 14px;">
            <strong>Note:</strong> This confirmation link will expire in 7 days. If you cannot access the link, please contact us directly.
          </p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
          
          <p style="color: #6b7280; font-size: 12px;">
            This request was initiated by: ${requestedBy.first_name} ${requestedBy.last_name} (${requestedBy.email})<br>
            Company: ${process.env.COMPANY_NAME || 'ERP System'}<br>
            Date: ${new Date().toLocaleDateString()}
          </p>
        </div>
      `;
      
      const textContent = `
Item Assignment Confirmation Request

Dear ${supplier.legal_name} Team,

We would like to assign the following inventory items to your supplier profile for potential delivery:

Items to Confirm:
${itemsList}

Please review these items and confirm whether you can supply them by visiting:
${confirmUrl}

This confirmation link will expire in 7 days.

This request was initiated by: ${requestedBy.first_name} ${requestedBy.last_name} (${requestedBy.email})
Company: ${process.env.COMPANY_NAME || 'ERP System'}
Date: ${new Date().toLocaleDateString()}
      `;

      const mailOptions = {
        from: businessLabel('sales'),
        to: supplier.email,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await sendMail(mailOptions);
      
      console.log('Supplier confirmation email sent:', {
        messageId: result.messageId,
        supplier: supplier.legal_name,
        email: supplier.contact_email,
        itemCount: items.length
      });

      return {
        success: true,
        token,
        messageId: result.messageId,
        confirmUrl
      };
      
    } catch (error) {
      console.error('Error sending supplier confirmation email:', error);
      throw new Error('Failed to send confirmation email to supplier');
    }
  }

  // Send confirmation acknowledgment to internal team
  async sendInternalConfirmationUpdate(supplier, items, action, requestedBy) {
    try {
      const subject = `Supplier Item ${action === 'confirmed' ? 'Confirmation' : 'Rejection'} - ${supplier.legal_name}`;
      
      const itemsList = items.map(item => 
        `• ${item.item_name} (${item.sku}) - ${action === 'confirmed' ? '✅ Confirmed' : '❌ Rejected'}`
      ).join('\n');

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: ${action === 'confirmed' ? '#10b981' : '#ef4444'};">
            Supplier Item ${action === 'confirmed' ? 'Confirmation' : 'Rejection'}
          </h2>
          
          <p><strong>Supplier:</strong> ${supplier.legal_name}</p>
          <p><strong>Contact:</strong> ${supplier.contact_email}</p>
          <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
          
          <h3>Items ${action === 'confirmed' ? 'Confirmed' : 'Rejected'}:</h3>
          <pre style="background-color: #f8f9fa; padding: 15px; border-radius: 5px;">${itemsList}</pre>
          
          <p style="color: #6b7280; font-size: 14px;">
            Original request was initiated by: ${requestedBy.first_name} ${requestedBy.last_name} (${requestedBy.email})
          </p>
        </div>
      `;

      const mailOptions = {
        from: businessLabel('info'),
        to: requestedBy.email,
        subject,
        html: htmlContent
      };

      const result = await sendMail(mailOptions);
      
      return {
        success: true,
        messageId: result.messageId
      };
      
    } catch (error) {
      console.error('Error sending internal confirmation update:', error);
      // Don't throw error for internal notifications - just log it
      return { success: false, error: error.message };
    }
  }

  // Send Sales RFQ to supplier
  async sendSalesRFQEmail(rfq, responseToken = null) {
    try {
      // Generate response token if not provided
      const token = responseToken || this.generateConfirmationToken();
      
      // Create response URL for supplier to respond
      const baseUrl = appBase();
      const responseUrl = `${baseUrl}/supplier/sales-rfq-response/${token}`;
      
      // Format RFQ items
      const itemsList = rfq.items ? rfq.items.map(item => 
        `• ${item.item_name} - Qty: ${item.requested_quantity} ${item.unit_of_measure}\n  ${item.item_description ? `Description: ${item.item_description}\n` : ''}  ${item.item_specification ? `Spec: ${item.item_specification}` : ''}`
      ).join('\n\n') : 'No items specified';
      
      const subject = `Sales RFQ Request: ${rfq.rfq_number} - ${process.env.COMPANY_NAME || 'ERP System'}`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; margin: -20px -20px 20px -20px;">
            <h1 style="margin: 0; font-size: 28px;">🔄 Sales RFQ Request</h1>
            <p style="margin: 5px 0 0 0; font-size: 16px;">Request for Quotation: ${rfq.rfq_number}</p>
          </div>
          
          <p>Dear ${rfq.supplier_name || 'Supplier'} Team,</p>
          
          <p>We are requesting a quotation for the following items for a potential customer order. This RFQ has been approved by both our sales and procurement teams.</p>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #495057; margin-top: 0;">📋 RFQ Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">RFQ Number:</td><td style="padding: 8px 0;">${rfq.rfq_number}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">Title:</td><td style="padding: 8px 0;">${rfq.rfq_title}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">Request Type:</td><td style="padding: 8px 0;">${rfq.request_type || 'TRADING'}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">Priority:</td><td style="padding: 8px 0;">${rfq.priority || 'MEDIUM'}</td></tr>
              <tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">Response Deadline:</td><td style="padding: 8px 0; color: #e74c3c; font-weight: bold;">${new Date(rfq.response_deadline).toLocaleDateString()}</td></tr>
              ${rfq.required_delivery_date ? `<tr><td style="padding: 8px 0; font-weight: bold; color: #495057;">Required Delivery:</td><td style="padding: 8px 0;">${new Date(rfq.required_delivery_date).toLocaleDateString()}</td></tr>` : ''}
            </table>
          </div>
          
          <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #2d6e2d; margin-top: 0;">📦 Requested Items</h3>
            <pre style="white-space: pre-wrap; font-family: 'Courier New', monospace; background-color: white; padding: 15px; border-radius: 5px; border-left: 4px solid #28a745;">${itemsList}</pre>
          </div>
          
          ${rfq.delivery_location ? `
          <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #856404; margin-top: 0;">🚚 Delivery & Terms</h3>
            <table style="width: 100%; border-collapse: collapse;">
              ${rfq.delivery_location ? `<tr><td style="padding: 5px 0; font-weight: bold; color: #856404;">Delivery Location:</td><td style="padding: 5px 0;">${rfq.delivery_location}</td></tr>` : ''}
              ${rfq.delivery_terms ? `<tr><td style="padding: 5px 0; font-weight: bold; color: #856404;">Delivery Terms:</td><td style="padding: 5px 0;">${rfq.delivery_terms}</td></tr>` : ''}
              ${rfq.payment_terms ? `<tr><td style="padding: 5px 0; font-weight: bold; color: #856404;">Payment Terms:</td><td style="padding: 5px 0;">${rfq.payment_terms}</td></tr>` : ''}
            </table>
          </div>
          ` : ''}
          
          ${rfq.special_requirements ? `
          <div style="background-color: #e1ecf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #0c5aa6; margin-top: 0;">⚠️ Special Requirements</h3>
            <p style="margin: 0; line-height: 1.6;">${rfq.special_requirements}</p>
          </div>
          ` : ''}
          
          ${rfq.terms_and_conditions ? `
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #495057; margin-top: 0;">📜 Terms and Conditions</h3>
            <p style="margin: 0; line-height: 1.6;">${rfq.terms_and_conditions}</p>
          </div>
          ` : ''}
          
          <div style="background-color: #d4edda; padding: 25px; border-radius: 8px; margin: 30px 0; text-align: center; border: 2px solid #c3e6cb;">
            <h3 style="color: #155724; margin-top: 0;">🎯 Please Provide Your Quotation</h3>
            <p style="color: #155724; margin: 15px 0;">Click the button below to access our supplier portal and submit your detailed quotation:</p>
            
            <a href="${responseUrl}" style="display: inline-block; background-color: #28a745; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; margin: 10px;">
              📝 Submit Quotation
            </a>
            
            <p style="font-size: 13px; color: #6c757d; margin: 15px 0 0 0; font-style: italic;">
              🔗 Direct link: <a href="${responseUrl}" style="color: #007bff;">${responseUrl}</a>
            </p>
          </div>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
          
          <div style="color: #6b7280; font-size: 14px;">
            <h4 style="color: #374151;">📞 Contact Information</h4>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 3px 0;"><strong>Company:</strong></td><td style="padding: 3px 0;">${process.env.COMPANY_NAME || 'ERP System'}</td></tr>
              <tr><td style="padding: 3px 0;"><strong>Email:</strong></td><td style="padding: 3px 0;">${process.env.SMTP_FROM || 'procurement@company.com'}</td></tr>
              <tr><td style="padding: 3px 0;"><strong>RFQ Created:</strong></td><td style="padding: 3px 0;">${new Date(rfq.created_at).toLocaleDateString()}</td></tr>
            </table>
          </div>
        </div>
      `;
      
      const textContent = `
Sales RFQ Request: ${rfq.rfq_number}

Dear ${rfq.supplier_name || 'Supplier'} Team,

We are requesting a quotation for the following items for a potential customer order.

RFQ Details:
- RFQ Number: ${rfq.rfq_number}
- Title: ${rfq.rfq_title}
- Request Type: ${rfq.request_type || 'TRADING'}
- Priority: ${rfq.priority || 'MEDIUM'}
- Response Deadline: ${new Date(rfq.response_deadline).toLocaleDateString()}
${rfq.required_delivery_date ? `- Required Delivery: ${new Date(rfq.required_delivery_date).toLocaleDateString()}` : ''}

Requested Items:
${itemsList}

${rfq.delivery_location ? `Delivery Location: ${rfq.delivery_location}` : ''}
${rfq.delivery_terms ? `Delivery Terms: ${rfq.delivery_terms}` : ''}
${rfq.payment_terms ? `Payment Terms: ${rfq.payment_terms}` : ''}

${rfq.special_requirements ? `Special Requirements: ${rfq.special_requirements}` : ''}

Please submit your quotation by visiting: ${responseUrl}

Contact Information:
Company: ${process.env.COMPANY_NAME || 'ERP System'}
Email: ${process.env.SMTP_FROM || 'procurement@company.com'}
RFQ Created: ${new Date(rfq.created_at).toLocaleDateString()}
      `;

      const mailOptions = {
        from: businessLabel('sales'),
        to: rfq.supplier_email,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await sendMail(mailOptions);
      
      console.log('Sales RFQ email sent:', {
        messageId: result.messageId,
        supplier: rfq.supplier_name,
        email: rfq.supplier_email,
        rfqNumber: rfq.rfq_number
      });

      return {
        success: true,
        token,
        messageId: result.messageId,
        responseUrl
      };
      
    } catch (error) {
      console.error('Error sending Sales RFQ email:', error);
      throw new Error('Failed to send Sales RFQ email to supplier');
    }
  }

  // Send RFQ response acknowledgment
  async sendRFQResponseAcknowledgment(rfq, supplierResponse, internal_recipients) {
    try {
      const subject = `Supplier Response Received - RFQ ${rfq.rfq_number}`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #28a745;">✅ Supplier Response Received</h2>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr><td style="padding: 8px 0; font-weight: bold;">RFQ Number:</td><td style="padding: 8px 0;">${rfq.rfq_number}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Supplier:</td><td style="padding: 8px 0;">${rfq.supplier_name}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Response Date:</td><td style="padding: 8px 0;">${new Date().toLocaleString()}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Total Quoted:</td><td style="padding: 8px 0; color: #28a745; font-weight: bold;">${supplierResponse.supplier_total_amount ? `${supplierResponse.supplier_total_amount} ${supplierResponse.supplier_currency || 'USD'}` : 'Not specified'}</td></tr>
          </table>
          
          ${supplierResponse.supplier_comments ? `
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h4 style="margin-top: 0;">💬 Supplier Comments:</h4>
            <p style="margin: 0;">${supplierResponse.supplier_comments}</p>
          </div>
          ` : ''}
          
          <p style="color: #6b7280; font-size: 14px;">
            You can view the full response details in the ERP system.
          </p>
        </div>
      `;

      for (const recipient of internal_recipients) {
        const mailOptions = {
          from: businessLabel('info'),
          to: recipient.email,
          subject,
          html: htmlContent
        };

        await sendMail(mailOptions);
      }
      
      return { success: true };
      
    } catch (error) {
      console.error('Error sending RFQ response acknowledgment:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new SupplierEmailService();