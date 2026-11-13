const jwt = require('jsonwebtoken');
const { appBase } = require('../config/appLinks');
const { sendMail, authFrom, businessLabel } = require('../config/sender');

class EmailService {
  constructor() {
    // Sending goes through config/sender.js: Resend when RESEND_API_KEY is
    // set (the only transport that can carry the @embmis.com From-address
    // policy — Gmail SMTP would rewrite those headers), SMTP for local dev.
    this.contactEmail = process.env.COMPANY_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;

    this.jwtSecret = process.env.SUPPLIER_JWT_SECRET;
    if (!this.jwtSecret) {
      throw new Error('SUPPLIER_JWT_SECRET must be set — refusing to sign supplier portal tokens with a default secret.');
    }
    this.baseUrl = appBase();
    this.frontendUrl = appBase();
  }

  // Generate secure token for supplier actions
  generateSupplierToken(data, expiresIn = '7d') {
    return jwt.sign(data, this.jwtSecret, { expiresIn });
  }

  // Verify supplier token
  verifySupplierToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  // Send supplier onboarding confirmation email
  async sendSupplierOnboardingEmail(supplier, createdByUser) {
    const partnershipUrl = `${this.frontendUrl}/supplier-portal/partnership/${supplier.id}`;

    const acceptUrl = partnershipUrl;
    const declineUrl = partnershipUrl;

    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Partnership Invitation - Simeli</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #0066cc;">
        <h1 style="color: #0066cc; margin-bottom: 20px;">Partnership Invitation</h1>
        
        <p>Dear ${supplier.legal_name} Team,</p>
        
        <p>We are pleased to invite you to join our supplier network at <strong>Simeli</strong>. Your company has been selected to participate in our procurement processes.</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Supplier Details:</h3>
            <ul>
                <li><strong>Company:</strong> ${supplier.legal_name}</li>
                <li><strong>Supplier Code:</strong> ${supplier.supplier_code}</li>
                <li><strong>Contact Email:</strong> ${supplier.email}</li>
                <li><strong>Added by:</strong> ${createdByUser}</li>
            </ul>
        </div>
        
        <p><strong>What happens next?</strong></p>
        <ul>
            <li>Review our partnership terms and conditions</li>
            <li>Confirm your interest in working with Simeli</li>
            <li>Access future RFQs and purchase orders</li>
            <li>Participate in our procurement processes</li>
        </ul>
        
        <div style="text-align: center; margin: 30px 0;">
            <a href="${acceptUrl}" style="background-color: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px; display: inline-block;">
                ✅ Accept Partnership
            </a>
            <a href="${declineUrl}" style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px; display: inline-block;">
                ❌ Decline Partnership  
            </a>
        </div>
        
        <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0;"><strong>⏰ Important:</strong> This invitation expires in 7 days. Please respond by clicking one of the buttons above.</p>
        </div>
        
        <hr style="margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
            If you have any questions, please contact our procurement team at 
            <a href="mailto:${this.contactEmail}">${this.contactEmail}</a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">
            This is an automated email from Simeli Procurement System.
            <br>© 2024 Simeli. All rights reserved.
        </p>
    </div>
</body>
</html>
    `;

    const mailOptions = {
      from: businessLabel('info'),
      to: supplier.email,
      subject: `Partnership Invitation - Simeli Supplier Network`,
      html: emailTemplate
    };

    try {
      const result = await sendMail(mailOptions);
      console.log('Supplier onboarding email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending supplier onboarding email:', error);
      throw error;
    }
  }

  // Send RFQ invitation to suppliers
  async sendRFQInvitation(rfq, supplier, lineItems = []) {
    const responseToken = this.generateSupplierToken({
      rfqId: rfq.id,
      supplierId: supplier.supplier_id || supplier.id,
      action: 'rfq_response',
      email: supplier.email
    });

    const responseUrl = `${this.frontendUrl}/supplier-portal/rfq/respond/${responseToken}`;

    const itemsHtml = lineItems.map(item => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${item.item_description}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${item.quantity} ${item.unit_of_measure || ''}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${item.required_date || 'ASAP'}</td>
      </tr>
    `).join('');

    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RFQ Invitation - ${rfq.rfq_number}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #6f42c1;">
        <h1 style="color: #6f42c1; margin-bottom: 20px;">Request for Quotation</h1>
        
        <p>Dear ${supplier.legal_name},</p>
        
        <p>We invite you to submit a quotation for the following requirements:</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">RFQ Details:</h3>
            <ul>
                <li><strong>RFQ Number:</strong> ${rfq.rfq_number}</li>
                <li><strong>Title:</strong> ${rfq.title}</li>
                <li><strong>Deadline:</strong> ${new Date(rfq.response_deadline).toLocaleDateString()}</li>
                <li><strong>Currency:</strong> ${rfq.currency}</li>
            </ul>
            
            ${rfq.description ? `
            <div style="margin-top: 15px;">
                <strong>Description:</strong>
                <p style="background-color: #f8f9fa; padding: 10px; border-radius: 5px;">${rfq.description}</p>
            </div>
            ` : ''}
        </div>
        
        ${itemsHtml ? `
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Required Items:</h3>
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background-color: #f8f9fa;">
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Item Description</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Quantity</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Required Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHtml}
                </tbody>
            </table>
        </div>
        ` : ''}
        
        <div style="text-align: center; margin: 30px 0;">
            <a href="${responseUrl}" style="background-color: #6f42c1; color: white; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                📝 Submit Your Quotation
            </a>
        </div>
        
        <div style="background-color: #d1ecf1; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0;"><strong>⏰ Submission Deadline:</strong> ${new Date(rfq.response_deadline).toLocaleString()}</p>
        </div>
        
        <hr style="margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
            For questions about this RFQ, please contact: 
            <a href="mailto:${this.contactEmail}">${this.contactEmail}</a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">
            This is an automated email from Simeli Procurement System.
            <br>© 2024 Simeli. All rights reserved.
        </p>
    </div>
</body>
</html>
    `;

    const mailOptions = {
      from: businessLabel('sales'),
      to: supplier.email,
      subject: `RFQ Invitation: ${rfq.rfq_number} - ${rfq.title}`,
      html: emailTemplate
    };

    try {
      const result = await sendMail(mailOptions);
      console.log('RFQ invitation sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending RFQ invitation:', error);
      throw error;
    }
  }

  // Send Purchase Order confirmation to supplier
  async sendPOConfirmation(po, supplier, lineItems = []) {
    const confirmToken = this.generateSupplierToken({
      poId: po.id,
      supplierId: supplier.id,
      action: 'confirm_po',
      email: supplier.email
    });

    const rejectToken = this.generateSupplierToken({
      poId: po.id,
      supplierId: supplier.id,
      action: 'reject_po',
      email: supplier.email
    });

    const confirmUrl = `${this.baseUrl}/supplier-portal/po/confirm/${confirmToken}`;
    const rejectUrl = `${this.baseUrl}/supplier-portal/po/reject/${rejectToken}`;

    const itemsHtml = lineItems.map(item => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${item.item_description}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${item.quantity} ${item.unit_of_measure}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">$${parseFloat(item.unit_price).toFixed(2)}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">$${(parseFloat(item.quantity) * parseFloat(item.unit_price)).toFixed(2)}</td>
      </tr>
    `).join('');

    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Purchase Order - ${po.po_number}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #28a745;">
        <h1 style="color: #28a745; margin-bottom: 20px;">Purchase Order Confirmation</h1>
        
        <p>Dear ${supplier.legal_name},</p>
        
        <p>We are pleased to send you the following purchase order for confirmation:</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Purchase Order Details:</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div>
                    <strong>PO Number:</strong> ${po.po_number}<br>
                    <strong>Date:</strong> ${new Date(po.created_at).toLocaleDateString()}<br>
                    <strong>Currency:</strong> ${po.currency}
                </div>
                <div>
                    <strong>Total Amount:</strong> $${parseFloat(po.total_amount).toFixed(2)}<br>
                    <strong>Expected Delivery:</strong> ${po.required_date ? new Date(po.required_date).toLocaleDateString() : 'As specified'}<br>
                    <strong>Payment Terms:</strong> ${po.payment_terms || 'Net 30'}
                </div>
            </div>
        </div>
        
        ${itemsHtml ? `
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Order Items:</h3>
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background-color: #f8f9fa;">
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Description</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Quantity</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Unit Price</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHtml}
                </tbody>
            </table>
        </div>
        ` : ''}
        
        <div style="text-align: center; margin: 30px 0;">
            <a href="${confirmUrl}" style="background-color: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px; display: inline-block;">
                ✅ Confirm Order
            </a>
            <a href="${rejectUrl}" style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px; display: inline-block;">
                ❌ Reject Order
            </a>
        </div>
        
        <div style="background-color: #d4edda; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0;"><strong>📋 Next Steps:</strong></p>
            <ul style="margin: 10px 0;">
                <li>Please confirm or reject this order within 48 hours</li>
                <li>Upon confirmation, proceed with order fulfillment</li>
                <li>Contact us for any clarifications needed</li>
            </ul>
        </div>
        
        <hr style="margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
            Questions about this purchase order? Contact: 
            <a href="mailto:${this.contactEmail}">${this.contactEmail}</a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">
            This is an automated email from Simeli Procurement System.
            <br>© 2024 Simeli. All rights reserved.
        </p>
    </div>
</body>
</html>
    `;

    const mailOptions = {
      from: businessLabel('sales'),
      to: supplier.email,
      subject: `Purchase Order Confirmation Required: ${po.po_number}`,
      html: emailTemplate
    };

    try {
      const result = await sendMail(mailOptions);
      console.log('PO confirmation email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending PO confirmation email:', error);
      throw error;
    }
  }

  // Send purchase order delivery confirmation request to supplier
  async sendPODeliveryConfirmation(po, supplier, deliveryToken) {
    const deliveryUrl = `${this.frontendUrl}/supplier-portal/delivery/${deliveryToken}`;

    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Delivery Confirmation Required - ${po.po_number}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #28a745;">
        <h1 style="color: #28a745; margin-bottom: 20px;">Purchase Order - Delivery Confirmation Required</h1>
        
        <p>Dear ${supplier.legal_name},</p>
        
        <p>Congratulations! Your purchase order has been approved and is ready for delivery preparation.</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Purchase Order Details:</h3>
            <ul>
                <li><strong>PO Number:</strong> ${po.po_number}</li>
                <li><strong>Total Amount:</strong> ${po.currency} ${parseFloat(po.total_amount || 0).toFixed(2)}</li>
                <li><strong>Expected Delivery:</strong> ${new Date(po.delivery_date).toLocaleDateString()}</li>
                <li><strong>Payment Terms:</strong> ${po.payment_terms || 'As agreed'}</li>
            </ul>
            
            ${po.delivery_address ? `
            <div style="margin-top: 15px;">
                <strong>Delivery Address:</strong>
                <p style="background-color: #f8f9fa; padding: 10px; border-radius: 5px; margin: 5px 0;">${po.delivery_address}</p>
            </div>
            ` : ''}
        </div>
        
        <div style="background-color: #d1ecf1; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: #0c5460;">📋 Required Actions:</h4>
            <ol style="margin: 10px 0; color: #0c5460;">
                <li><strong>Confirm Delivery Capability:</strong> Review the PO details and confirm you can deliver on time</li>
                <li><strong>Update Delivery Status:</strong> Use the portal below to update your delivery progress</li>
                <li><strong>Coordinate Delivery:</strong> Contact our procurement team for any delivery coordination needs</li>
                <li><strong>Complete Delivery:</strong> Mark delivery as completed when goods are delivered</li>
            </ol>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
            <a href="${deliveryUrl}" style="background-color: #28a745; color: white; padding: 15px 40px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                📦 Access Delivery Portal
            </a>
        </div>
        
        <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;"><strong>⚠️ Important:</strong> Please confirm your delivery capability within 48 hours. This link will remain active throughout the delivery process.</p>
        </div>
        
        <hr style="margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
            For delivery coordination and questions, contact: 
            <a href="mailto:${this.contactEmail}">${this.contactEmail}</a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">
            This is an automated email from Simeli Procurement System.
            <br>© 2024 Simeli. All rights reserved.
        </p>
    </div>
</body>
</html>
    `;

    const mailOptions = {
      from: businessLabel('sales'),
      to: supplier.email,
      subject: `Delivery Confirmation Required: ${po.po_number} - Total: ${po.currency} ${parseFloat(po.total_amount || 0).toFixed(2)}`,
      html: emailTemplate
    };

    try {
      const result = await sendMail(mailOptions);
      console.log('PO delivery confirmation email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending PO delivery confirmation email:', error);
      throw error;
    }
  }

  // Send delivery verification notification to supplier
  async sendDeliveryVerificationNotification(po, supplier, verified, verificationNotes, verifiedByUser) {
    let subject, headerColor, headerMessage;
    
    if (verified === true) {
      subject = `Delivery Verified - ${po.po_number}`;
      headerColor = '#28a745';
      headerMessage = '✅ Delivery Verified Successfully';
    } else if (verified === 'accept_with_issues') {
      subject = `Delivery Accepted with Issues - ${po.po_number}`;
      headerColor = '#ffc107';
      headerMessage = '⚠️ Delivery Accepted with Issues';
    } else {
      subject = `Delivery Rejected - ${po.po_number}`;
      headerColor = '#dc3545';
      headerMessage = '❌ Delivery Rejected - Action Required';
    }

    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${subject}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid ${headerColor};">
        <h1 style="color: ${headerColor}; margin-bottom: 20px;">
            ${headerMessage}
        </h1>
        
        <p>Dear ${supplier.legal_name},</p>
        
        <p>${verified === true 
          ? 'We are pleased to confirm that your delivery has been successfully verified and accepted.'
          : verified === 'accept_with_issues'
          ? 'We have received your delivery and are accepting it to maintain our schedule. However, there are some issues that need to be addressed for future deliveries.'
          : 'We need to reject your delivery due to significant issues that prevent us from accepting the goods. Please review the details below and arrange for re-delivery.'
        }</p>
        
        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Purchase Order Details:</h3>
            <ul>
                <li><strong>PO Number:</strong> ${po.po_number}</li>
                <li><strong>Total Amount:</strong> ${po.currency} ${parseFloat(po.total_amount || 0).toFixed(2)}</li>
                <li><strong>Original Delivery Date:</strong> ${new Date(po.delivery_date).toLocaleDateString()}</li>
                <li><strong>Verification Date:</strong> ${new Date().toLocaleDateString()}</li>
                <li><strong>Verified By:</strong> ${verifiedByUser}</li>
            </ul>
        </div>
        
        ${verificationNotes ? `
        <div style="background-color: ${verified === true ? '#d4edda' : verified === 'accept_with_issues' ? '#fff3cd' : '#f8d7da'}; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: ${verified === true ? '#155724' : verified === 'accept_with_issues' ? '#856404' : '#721c24'};">
                ${verified === true ? '📋 Verification Notes:' : verified === 'accept_with_issues' ? '⚠️ Issues Noted:' : '🚨 Rejection Details:'}
            </h4>
            <p style="margin: 0; color: ${verified === true ? '#155724' : verified === 'accept_with_issues' ? '#856404' : '#721c24'};">${verificationNotes}</p>
        </div>
        ` : ''}
        
        <div style="background-color: ${verified === true ? '#d1ecf1' : verified === 'accept_with_issues' ? '#fff3cd' : '#f8d7da'}; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: ${verified === true ? '#0c5460' : verified === 'accept_with_issues' ? '#856404' : '#721c24'};">
                ${verified === true ? '🎉 Next Steps:' : verified === 'accept_with_issues' ? '⚠️ Important Notice:' : '📞 Required Actions:'}
            </h4>
            ${verified === true ? `
            <ul style="margin: 10px 0; color: #0c5460;">
                <li>Your delivery has been accepted and processed</li>
                <li>Payment processing will proceed as per contract terms</li>
                <li>Performance metrics have been updated positively</li>
                <li>Thank you for your reliable service</li>
            </ul>
            ` : verified === 'accept_with_issues' ? `
            <ul style="margin: 10px 0; color: #856404;">
                <li>We are accepting this delivery to maintain our operations</li>
                <li>Payment will proceed as per contract terms</li>
                <li>Please review the issues noted above carefully</li>
                <li>Implement corrective measures for future deliveries</li>
                <li>Contact our team to discuss quality improvement</li>
            </ul>
            ` : `
            <ul style="margin: 10px 0; color: #721c24;">
                <li>Arrange for immediate pickup of rejected goods</li>
                <li>Review and address all issues mentioned above</li>
                <li>Contact our procurement team within 24 hours</li>
                <li>Submit a corrective action plan</li>
                <li>Schedule re-delivery only after approval</li>
            </ul>
            `}
        </div>
        
        <hr style="margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
            For questions about this ${verified ? 'verification' : 'issue'}, contact: 
            <a href="mailto:${this.contactEmail}">${this.contactEmail}</a>
        </p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">
            This is an automated email from Simeli Procurement System.
            <br>© 2024 Simeli. All rights reserved.
        </p>
    </div>
</body>
</html>
    `;

    const mailOptions = {
      from: businessLabel('sales'),
      to: supplier.email,
      subject: subject,
      html: emailTemplate
    };

    try {
      const result = await sendMail(mailOptions);
      console.log('Delivery verification notification sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('Error sending delivery verification notification:', error);
      throw error;
    }
  }

  // Test email connection
  /**
   * Send an arbitrary email.
   *
   * Every other method here builds one specific templated message. Scheduled
   * reports need a generic path — the subject and body come from a report
   * definition, not from a template — so this is that path, rather than each
   * caller reaching into the service and re-deriving the From address.
   */
  async sendEmail({ to, subject, html, text, attachments, from }) {
    if (!to) throw new Error('An email needs a recipient.');
    // Default From is the account/security address (noreply@embmis.com) —
    // this method carries verification, reset, and invite mail. Business
    // senders pass an explicit from: businessLabel('sales'|'info').
    return sendMail({
      from: from || authFrom(),
      to,
      subject: subject || '(no subject)',
      html,
      text,
      attachments,
    });
  }

  async testConnection() {
    try {
      if (process.env.RESEND_API_KEY) {
        // Resend has no SMTP-style verify(); a configured key plus the
        // mailbox path already exercising it is the working signal.
        return true;
      }
      const nodemailer = require('nodemailer');
      const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.verify();
      console.log('✅ Email service connection successful');
      return true;
    } catch (error) {
      console.error('❌ Email service connection failed:', error);
      throw error;
    }
  }

  // Send contract for supplier acceptance
  async sendContractForAcceptance({ to, supplierName, contractNumber, contractTitle, responseUrl, dueDate, attachmentPath = null }) {
    try {
      const formattedDueDate = new Date(dueDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const subject = `Contract for Review and Acceptance - ${contractNumber}`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #2563eb; margin: 0; font-size: 24px;">Simeli ERP</h1>
              <p style="color: #6b7280; margin: 5px 0 0 0; font-size: 14px;">Contract Management System</p>
            </div>

            <!-- Main Content -->
            <div style="margin-bottom: 30px;">
              <h2 style="color: #1f2937; margin-bottom: 20px;">Contract Review Required</h2>
              
              <p style="color: #374151; line-height: 1.6; margin-bottom: 15px;">
                Dear ${supplierName},
              </p>
              
              <p style="color: #374151; line-height: 1.6; margin-bottom: 20px;">
                We have prepared a contract for your review and acceptance. Please find the contract details below:
              </p>

              <!-- Contract Details -->
              <div style="background-color: #f3f4f6; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-weight: 600; width: 40%;">Contract Number:</td>
                    <td style="padding: 8px 0; color: #1f2937; font-weight: 600;">${contractNumber}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-weight: 600;">Contract Title:</td>
                    <td style="padding: 8px 0; color: #1f2937;">${contractTitle}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-weight: 600;">Response Due:</td>
                    <td style="padding: 8px 0; color: #dc2626; font-weight: 600;">${formattedDueDate}</td>
                  </tr>
                </table>
              </div>

              <!-- Action Required -->
              <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin-bottom: 25px;">
                <h3 style="color: #92400e; margin: 0 0 10px 0; font-size: 16px;">Action Required</h3>
                <p style="color: #92400e; margin: 0; line-height: 1.5;">
                  Please review the contract and respond within <strong>7 days</strong> by clicking the link below.
                </p>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 30px 0;">
                <a href="${responseUrl}" 
                   style="display: inline-block; background-color: #2563eb; color: white; padding: 12px 30px; 
                          text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
                  Review Contract
                </a>
              </div>

              <!-- Alternative Link -->
              <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
                <p style="color: #6b7280; margin: 0; font-size: 12px; line-height: 1.4;">
                  If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="${responseUrl}" style="color: #2563eb; word-break: break-all;">${responseUrl}</a>
                </p>
              </div>

              <!-- Important Notes -->
              <div style="border-top: 1px solid #e5e7eb; padding-top: 20px;">
                <h3 style="color: #1f2937; margin: 0 0 15px 0; font-size: 16px;">Important Notes:</h3>
                <ul style="color: #374151; line-height: 1.6; margin: 0; padding-left: 20px;">
                  <li style="margin-bottom: 8px;">Please review all contract terms and conditions carefully</li>
                  <li style="margin-bottom: 8px;">You can accept or decline the contract through the provided link</li>
                  <li style="margin-bottom: 8px;">This request will expire after 7 days if no response is received</li>
                  <li>For questions, please contact our procurement team</li>
                </ul>
              </div>
            </div>

            <!-- Footer -->
            <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; text-align: center;">
              <p style="color: #6b7280; font-size: 12px; margin: 0;">
                This is an automated message from Simeli ERP Contract Management System.<br>
                Please do not reply directly to this email.
              </p>
            </div>
          </div>
        </div>
      `;

      const textContent = `
        Simeli ERP - Contract Review Required

        Dear ${supplierName},

        We have prepared a contract for your review and acceptance.

        Contract Details:
        - Contract Number: ${contractNumber}
        - Contract Title: ${contractTitle}
        - Response Due: ${formattedDueDate}

        Please review the contract by visiting: ${responseUrl}

        Important:
        - Please respond within 7 days
        - This link will expire if not used within the deadline
        - Contact our procurement team for any questions

        This is an automated message from Simeli ERP Contract Management System.
      `;

      const mailOptions = {
        from: businessLabel('sales', 'Simeli ERP Contract System'),
        to: to,
        subject: subject,
        text: textContent,
        html: htmlContent
      };

      // Add attachment if provided
      if (attachmentPath) {
        mailOptions.attachments = [{
          path: attachmentPath
        }];
      }

      const result = await sendMail(mailOptions);
      console.log('Contract acceptance email sent successfully:', result.messageId);
      return { success: true, messageId: result.messageId };

    } catch (error) {
      console.error('Error sending contract acceptance email:', error);
      throw error;
    }
  }
}

module.exports = new EmailService();