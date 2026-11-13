const fs = require('fs').promises;
const path = require('path');
const { appBase } = require('../config/appLinks');
const { sendMail, businessLabel } = require('../config/sender');

class CustomerEmailService {
  // Sending goes through config/sender.js — Resend when configured (the only
  // transport that can carry the @embmis.com From-address policy), SMTP for
  // local dev.

  // Load email template
  async loadTemplate(templateName) {
    try {
      const templatePath = path.join(__dirname, '../templates/emails', `${templateName}.html`);
      return await fs.readFile(templatePath, 'utf8');
    } catch (error) {
      console.error(`Failed to load email template ${templateName}:`, error);
      return null;
    }
  }

  // Replace placeholders in template
  replacePlaceholders(template, data) {
    let result = template;
    Object.keys(data).forEach(key => {
      const placeholder = new RegExp(`{{${key}}}`, 'g');
      result = result.replace(placeholder, data[key] || '');
    });
    return result;
  }

  // Send quotation to customer
  async sendQuotationEmail(quotation, customer, responseToken = null, attachmentPath = null) {
    try {
      const template = await this.loadTemplate('quotation');
      if (!template) {
        throw new Error('Quotation email template not found');
      }

      const baseUrl = appBase();
      const responseUrl = responseToken ? `${baseUrl}/quotation-response/${responseToken}` : null;

      const emailData = {
        customer_name: customer.customer_name,
        quotation_number: quotation.quotation_number,
        quotation_date: new Date(quotation.quotation_date).toLocaleDateString(),
        valid_until: new Date(quotation.valid_until).toLocaleDateString(),
        total_amount: new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: quotation.currency || 'USD'
        }).format(quotation.total_amount),
        currency: quotation.currency,
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900',
        response_url: responseUrl,
        accept_url: responseUrl ? `${responseUrl}?action=accept` : '',
        reject_url: responseUrl ? `${responseUrl}?action=reject` : '',
        // Add quotation items for display
        items_html: this.formatQuotationItems(quotation.items || []),
        // Dynamic response section based on whether token exists
        response_section: responseUrl ? `
          <div style="background-color: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #0369a1; margin-top: 0;">Respond to This Quotation</h3>
            <p>Click one of the buttons below to respond to this quotation:</p>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${responseUrl}?action=accept" style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✓ Accept Quotation
              </a>
              <a href="${responseUrl}?action=reject" style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✗ Decline Quotation
              </a>
            </div>
            
            <p style="font-size: 12px; color: #64748b; text-align: center; margin: 15px 0 0 0;">
              Or visit: <a href="${responseUrl}" style="color: #0369a1;">${responseUrl}</a>
            </p>
          </div>
        ` : `
          <div style="text-align: center; margin: 20px 0;">
            <a href="mailto:${process.env.COMPANY_EMAIL || 'sales@company.com'}?subject=Quotation ${quotation.quotation_number} - Acceptance" style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Reply to Accept
            </a>
          </div>
        `
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: customer.primary_email,
        cc: customer.secondary_email || undefined,
        subject: `Quotation ${quotation.quotation_number} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent,
        attachments: attachmentPath ? [{
          filename: `Quotation-${quotation.quotation_number}.pdf`,
          path: attachmentPath
        }] : []
      };

      const info = await sendMail(mailOptions);
      console.log('Quotation email sent:', info.messageId);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: customer.primary_email,
        responseToken: responseToken
      };
    } catch (error) {
      console.error('Error sending quotation email:', error);
      throw error;
    }
  }

  // Format quotation items for email display
  formatQuotationItems(items) {
    if (!items || items.length === 0) {
      return '<tr><td colspan="5">No items found</td></tr>';
    }

    return items.map(item => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.item_name}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.unit_of_measure}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">
          ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(item.unit_price)}
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">
          ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(item.line_total)}
        </td>
      </tr>
    `).join('');
  }

  // Format contract items for email display
  formatContractItems(items) {
    if (!items || items.length === 0) {
      return '<tr><td colspan="4">No items found</td></tr>';
    }

    return items.map(item => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">
          <strong>${item.item_name}</strong>
          ${item.item_description ? `<br><small style="color: #666;">${item.item_description}</small>` : ''}
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.unit_of_measure}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">
          ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(item.unit_price)}
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">
          ${item.minimum_quantity && item.maximum_quantity ? 
            `${item.minimum_quantity} - ${item.maximum_quantity}` :
            item.minimum_quantity ? `Min: ${item.minimum_quantity}` :
            item.maximum_quantity ? `Max: ${item.maximum_quantity}` : 'As needed'
          }
        </td>
      </tr>
    `).join('');
  }

  // Send contract to customer
  async sendContractEmail(contract, customer, attachmentPath = null) {
    try {
      const template = await this.loadTemplate('contract');
      if (!template) {
        throw new Error('Contract email template not found');
      }

      const baseUrl = appBase();
      const responseToken = contract.customer_response_token;
      const responseUrl = responseToken ? `${baseUrl}/contract-response/${responseToken}` : null;

      const emailData = {
        customer_name: customer.customer_name,
        contract_name: contract.contract_name,
        contract_number: contract.contract_number || 'N/A',
        start_date: new Date(contract.start_date).toLocaleDateString(),
        end_date: new Date(contract.end_date).toLocaleDateString(),
        contract_value: new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: contract.currency || 'USD'
        }).format(contract.contract_value),
        currency: contract.currency,
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900',
        response_url: responseUrl,
        accept_url: responseUrl ? `${responseUrl}?action=accept` : '',
        reject_url: responseUrl ? `${responseUrl}?action=reject` : '',
        // Add contract items for display
        items_html: this.formatContractItems(contract.items || []),
        // Dynamic response section based on whether token exists
        response_section: responseUrl ? `
          <div style="background-color: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #0369a1; margin-top: 0;">Respond to This Contract</h3>
            <p>Please review the contract terms and conditions below, then click one of the buttons to respond:</p>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${responseUrl}?action=accept" style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✓ Accept & Sign Contract
              </a>
              <a href="${responseUrl}?action=reject" style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✗ Decline Contract
              </a>
            </div>
            
            <p style="font-size: 12px; color: #64748b; text-align: center; margin: 15px 0 0 0;">
              Or visit: <a href="${responseUrl}" style="color: #0369a1;">${responseUrl}</a>
            </p>
          </div>
        ` : `
          <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
            <h3 style="color: #856404; margin-top: 0;">Next Steps</h3>
            <p>Please review this contract and contact our sales team to proceed:</p>
            <div style="text-align: center; margin: 20px 0;">
              <a href="mailto:${process.env.COMPANY_EMAIL || 'sales@company.com'}?subject=Contract ${contract.contract_number} - Response" style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Contact Sales Team
              </a>
            </div>
          </div>
        `
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: customer.primary_email,
        cc: customer.secondary_email || undefined,
        subject: `Contract for Review: ${contract.contract_name} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent,
        attachments: attachmentPath ? [{
          filename: `Contract-${contract.contract_number || contract.id}.pdf`,
          path: attachmentPath
        }] : []
      };

      const info = await sendMail(mailOptions);
      console.log('Contract email sent:', info.messageId);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: customer.primary_email,
        responseToken: responseToken
      };
    } catch (error) {
      console.error('Error sending contract email:', error);
      throw error;
    }
  }

  // Send sales order confirmation to customer
  async sendOrderConfirmationEmail(salesOrder, customer, attachmentPath = null) {
    try {
      const template = await this.loadTemplate('order_confirmation');
      if (!template) {
        throw new Error('Order confirmation email template not found');
      }

      const emailData = {
        customer_name: customer.customer_name,
        so_number: salesOrder.so_number,
        order_date: new Date(salesOrder.order_date).toLocaleDateString(),
        delivery_date: salesOrder.delivery_date ? new Date(salesOrder.delivery_date).toLocaleDateString() : 'TBD',
        total_amount: salesOrder.total_amount,
        currency: salesOrder.currency,
        shipping_method: salesOrder.shipping_method || 'Standard Shipping',
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900'
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: customer.primary_email,
        cc: customer.secondary_email || undefined,
        subject: `Order Confirmation ${salesOrder.so_number} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent,
        attachments: attachmentPath ? [{
          filename: `Order-${salesOrder.so_number}.pdf`,
          path: attachmentPath
        }] : []
      };

      const info = await sendMail(mailOptions);
      console.log('Order confirmation email sent:', info.messageId);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: customer.primary_email
      };
    } catch (error) {
      console.error('Error sending order confirmation email:', error);
      throw error;
    }
  }

  // Send delivery notification to customer
  async sendDeliveryNotificationEmail(salesOrder, customer, deliverySchedule = null) {
    try {
      const template = await this.loadTemplate('delivery_notification');
      if (!template) {
        throw new Error('Delivery notification email template not found');
      }

      const emailData = {
        customer_name: customer.customer_name,
        so_number: salesOrder.so_number,
        delivery_date: deliverySchedule ? new Date(deliverySchedule.scheduled_date).toLocaleDateString() : 'TBD',
        delivery_address: salesOrder.delivery_address || customer.billing_address_line1,
        tracking_number: deliverySchedule?.tracking_number || 'N/A',
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900'
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: customer.primary_email,
        cc: customer.secondary_email || undefined,
        subject: `Delivery Update - Order ${salesOrder.so_number}`,
        html: htmlContent
      };

      const info = await sendMail(mailOptions);
      console.log('Delivery notification email sent:', info.messageId);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: customer.primary_email
      };
    } catch (error) {
      console.error('Error sending delivery notification email:', error);
      throw error;
    }
  }

  // Send general notification to customer
  async sendCustomerNotificationEmail(customer, subject, message, type = 'info') {
    try {
      const template = await this.loadTemplate('general_notification');
      if (!template) {
        throw new Error('General notification email template not found');
      }

      const emailData = {
        customer_name: customer.customer_name,
        subject: subject,
        message: message,
        type: type,
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'support@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900'
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('info'),
        to: customer.primary_email,
        cc: customer.secondary_email || undefined,
        subject: `${subject} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent
      };

      const info = await sendMail(mailOptions);
      console.log('Customer notification email sent:', info.messageId);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: customer.primary_email
      };
    } catch (error) {
      console.error('Error sending customer notification email:', error);
      throw error;
    }
  }

  // Send order confirmation email to customer
  async sendOrderConfirmationEmail(customerEmail, order, responseToken = null) {
    try {
      console.log(`📧 Preparing order confirmation email for ${order.so_number}...`);
      
      const template = await this.loadTemplate('order-confirmation');
      if (!template) {
        throw new Error('Order confirmation email template not found');
      }

      // Get customer details if customerEmail is not provided
      let recipientEmail = customerEmail;
      if (!recipientEmail && order.customer_id) {
        const Customer = require('../models/Customer');
        const customer = await Customer.findById(order.customer_id);
        recipientEmail = customer ? customer.primary_email : null;
      }

      if (!recipientEmail) {
        throw new Error('No customer email address available');
      }

      console.log(`📧 Sending order confirmation to: ${recipientEmail}`);

      // Format order date
      const formatDate = (dateString) => {
        if (!dateString) return 'Not specified';
        try {
          return new Date(dateString).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          });
        } catch (error) {
          return dateString;
        }
      };

      // Create base URL for customer response
      const baseUrl = appBase();
      const responseUrl = responseToken ? `${baseUrl}/order-response/${responseToken}` : null;
      
      console.log(`🔗 Response URL: ${responseUrl || 'Not generated'}`);

      // Format items as HTML table
      const formatItems = (items) => {
        if (!items || items.length === 0) return '<p>No items found</p>';
        
        let itemsHtml = `
          <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
            <thead style="background-color: #495057; color: white;">
              <tr>
                <th style="padding: 10px; text-align: left;">Item</th>
                <th style="padding: 10px; text-align: left;">Description</th>
                <th style="padding: 10px; text-align: left;">Quantity</th>
                <th style="padding: 10px; text-align: right;">Unit Price</th>
                <th style="padding: 10px; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
        `;
        
        items.forEach((item, index) => {
          itemsHtml += `
            <tr style="${index % 2 === 1 ? 'background-color: #f8f9fa;' : ''}">
              <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">
                <strong>${item.item_name || 'N/A'}</strong><br>
                <small style="color: #666;">${item.item_code || ''}</small>
              </td>
              <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">${item.item_description || 'N/A'}</td>
              <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">${item.quantity || 0} ${item.unit_of_measure || ''}</td>
              <td style="padding: 10px; border-bottom: 1px solid #dee2e6; text-align: right;">${Number(item.unit_price || 0).toFixed(2)} ${order.currency}</td>
              <td style="padding: 10px; border-bottom: 1px solid #dee2e6; text-align: right; font-weight: bold;">${Number(item.line_total || 0).toFixed(2)} ${order.currency}</td>
            </tr>
          `;
        });
        
        itemsHtml += '</tbody></table>';
        return itemsHtml;
      };

      const emailData = {
        // Basic order info
        so_number: order.so_number,
        customer_name: order.customer_name_full || order.customer_name || 'Valued Customer',
        order_date: formatDate(order.order_date),
        delivery_date: formatDate(order.delivery_date),
        reference_number: order.reference_number || 'N/A',
        priority: order.priority || 'NORMAL',
        currency: order.currency || 'USD',
        payment_terms: order.payment_terms || 'N/A',
        delivery_terms: order.delivery_terms || 'N/A',
        
        // Financial info
        subtotal: Number(order.subtotal || 0).toFixed(2),
        tax_amount: Number(order.tax_amount || 0).toFixed(2),
        discount_amount: Number(order.discount_amount || 0).toFixed(2),
        total_amount: Number(order.total_amount || 0).toFixed(2),
        
        // Company info
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900',
        
        // Items as formatted HTML
        items_html: formatItems(order.items),
        
        // Conditional content
        discount_html: order.discount_amount > 0 ? `
          <div class="total-row">
            <span>Discount:</span>
            <span>-${Number(order.discount_amount).toFixed(2)} ${order.currency}</span>
          </div>
        ` : '',
        
        tax_html: order.tax_amount > 0 ? `
          <div class="total-row">
            <span>Tax:</span>
            <span>${Number(order.tax_amount).toFixed(2)} ${order.currency}</span>
          </div>
        ` : '',
        
        delivery_info_html: order.delivery_address ? `
          <div class="info-box">
            <h3>🚚 Delivery Information</h3>
            <p><strong>Address:</strong> ${order.delivery_address}</p>
            ${order.delivery_instructions ? `<p><strong>Instructions:</strong> ${order.delivery_instructions}</p>` : ''}
            ${order.shipping_method ? `<p><strong>Shipping Method:</strong> ${order.shipping_method}</p>` : ''}
          </div>
        ` : '',
        
        notes_html: order.notes ? `
          <div class="info-box">
            <h3>📝 Order Notes</h3>
            <p>${order.notes}</p>
          </div>
        ` : '',
        
        // Response URLs
        response_url: responseUrl,
        accept_url: responseUrl ? `${responseUrl}?action=accept` : '',
        reject_url: responseUrl ? `${responseUrl}?action=reject` : '',
        
        // Dynamic response section based on whether token exists
        response_section: responseUrl ? `
          <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #2d6e2d; margin-top: 0;">📝 Digital Signature Required</h3>
            <p><strong>This order has been approved by our team and is ready for your signature.</strong></p>
            <p>Please carefully review all order details above. By clicking "Accept & Sign Order", you confirm that:</p>
            <ul style="text-align: left; margin: 10px 20px;">
              <li>You agree to all terms and conditions</li>
              <li>Order details are correct and complete</li>
              <li>You authorize us to proceed with fulfillment</li>
              <li>This serves as your digital signature</li>
            </ul>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${responseUrl}?action=accept" style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✓ Accept & Sign Order
              </a>
              <a href="${responseUrl}?action=reject" style="background-color: #dc3545; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✗ Decline Order
              </a>
            </div>
            
            <p style="font-size: 11px; color: #666; text-align: center; margin: 15px 0 0 0; font-style: italic;">
              🔒 Secure digital signing • Visit: <a href="${responseUrl}" style="color: #0066cc;">${responseUrl}</a>
            </p>
          </div>
        ` : `
          <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
            <h3 style="color: #856404; margin-top: 0;">Next Steps</h3>
            <p>Please review this order and contact our sales team to confirm:</p>
            <div style="text-align: center; margin: 20px 0;">
              <a href="mailto:${process.env.COMPANY_EMAIL || 'sales@company.com'}?subject=Order ${order.so_number} - Confirmation" style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Contact Sales Team
              </a>
            </div>
          </div>
        `
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: recipientEmail,
        subject: `Order Confirmation Required: ${order.so_number} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent
      };

      console.log(`📤 Sending order confirmation email for ${order.so_number}...`);
      const info = await sendMail(mailOptions);
      console.log(`✅ Order confirmation email sent: ${info.messageId}`);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: recipientEmail,
        responseToken: responseToken
      };
    } catch (error) {
      console.error('❌ Error sending order confirmation email:', error);
      throw error;
    }
  }

  // Send delivery confirmation request to customer
  async sendDeliveryConfirmationRequest(salesOrderId) {
    try {
      console.log(`📧 Preparing delivery confirmation email for sales order ${salesOrderId}...`);
      
      const template = await this.loadTemplate('delivery-confirmation');
      if (!template) {
        throw new Error('Delivery confirmation email template not found');
      }

      // Get sales order and customer details
      const { pool } = require('../config/database');
      const salesOrderQuery = `
        SELECT so.*, c.customer_name, c.primary_email, c.secondary_email,
               c.billing_address_line1, c.billing_city, c.billing_state, c.billing_postal_code
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        WHERE so.id = $1
      `;
      
      const result = await pool.query(salesOrderQuery, [salesOrderId]);
      
      if (result.rows.length === 0) {
        throw new Error('Sales order not found');
      }

      const order = result.rows[0];
      
      if (!order.primary_email) {
        throw new Error('Customer email address not found');
      }

      console.log(`📧 Sending delivery confirmation request to: ${order.primary_email}`);

      // Generate delivery confirmation token
      const crypto = require('crypto');
      const confirmationToken = crypto.randomBytes(32).toString('hex');
      
      // Store token in sales order
      await pool.query(`
        UPDATE sales_orders 
        SET customer_delivery_token = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `, [confirmationToken, salesOrderId]);

      // Create response URL
      const baseUrl = appBase();
      const confirmationUrl = `${baseUrl}/delivery-confirmation/${confirmationToken}`;
      
      console.log(`🔗 Confirmation URL: ${confirmationUrl}`);

      // Format delivery date
      const formatDate = (dateString) => {
        if (!dateString) return 'Recently';
        try {
          return new Date(dateString).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          });
        } catch (error) {
          return 'Recently';
        }
      };

      const emailData = {
        // Basic order info
        so_number: order.so_number,
        customer_name: order.customer_name || 'Valued Customer',
        order_date: formatDate(order.order_date),
        delivery_date: 'Today',
        
        // Company info
        company_name: process.env.COMPANY_NAME || 'Your Company',
        company_email: process.env.COMPANY_EMAIL || 'sales@company.com',
        company_phone: process.env.COMPANY_PHONE || '+1-234-567-8900',
        
        // Delivery address
        delivery_address: order.billing_address_line1 ?
          [order.billing_address_line1, order.billing_city, order.billing_state, order.billing_postal_code]
            .filter(part => part && String(part).trim() !== '')
            .join(', ') :
          'Your registered address',
        
        // Confirmation URLs
        confirmation_url: confirmationUrl,
        confirm_url: `${confirmationUrl}?action=confirm`,
        issue_url: `${confirmationUrl}?action=issue`,
        
        // Response section
        response_section: `
          <div style="background-color: #e8f5e8; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #2d6e2d; margin-top: 0;">📦 Delivery Confirmation Required</h3>
            <p><strong>Your order has been delivered to your location.</strong></p>
            <p>Please confirm receipt of your order by clicking one of the buttons below:</p>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${confirmationUrl}?action=confirm" style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ✓ Confirm Delivery Received
              </a>
              <a href="${confirmationUrl}?action=issue" style="background-color: #ffc107; color: #212529; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">
                ⚠️ Report Delivery Issues
              </a>
            </div>
            
            <p style="font-size: 11px; color: #666; text-align: center; margin: 15px 0 0 0; font-style: italic;">
              🔒 Secure confirmation • Visit: <a href="${confirmationUrl}" style="color: #0066cc;">${confirmationUrl}</a>
            </p>
          </div>
        `
      };

      const htmlContent = this.replacePlaceholders(template, emailData);

      const mailOptions = {
        from: businessLabel('sales'),
        to: order.primary_email,
        cc: order.secondary_email || undefined,
        subject: `Delivery Confirmation Required: Order ${order.so_number} - ${process.env.COMPANY_NAME || 'Your Company'}`,
        html: htmlContent
      };

      console.log(`📤 Sending delivery confirmation request for ${order.so_number}...`);
      const info = await sendMail(mailOptions);
      console.log(`✅ Delivery confirmation email sent: ${info.messageId}`);
      
      return {
        success: true,
        messageId: info.messageId,
        recipient: order.primary_email,
        confirmationToken: confirmationToken
      };
    } catch (error) {
      console.error('❌ Error sending delivery confirmation request:', error);
      throw error;
    }
  }

  // Test email configuration
  async testEmailConfiguration() {
    try {
      if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
        throw new Error('Neither RESEND_API_KEY nor SMTP_HOST is configured');
      }
      console.log('Email service is ready to send messages');
      return { success: true, message: 'Email configuration is valid' };
    } catch (error) {
      console.error('Email configuration test failed:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new CustomerEmailService();