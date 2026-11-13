const Notification = require('../models/Notification');

class NotificationService {
  // Item Master Notifications
  static async createItemMasterSubmittedNotification(item, submittedByUserId) {
    await Notification.createForManagers({
      type: 'item_master_submitted',
      title: 'New Item Master Submitted for Approval',
      message: `Item "${item.name}" (${item.item_code}) has been submitted for approval.`,
      data: {
        itemId: item.id,
        itemName: item.name,
        itemCode: item.item_code,
        submittedBy: submittedByUserId,
        criticality: item.criticality,
        category: item.item_category,
        type: 'item_master',
        action: 'submitted'
      }
    });
  }

  static async createItemMasterApprovedNotification(item, approvedBy, originalUserId) {
    await Notification.create({
      type: 'item_master_approved',
      title: 'Item Master Approved',
      message: `Your item master "${item.name}" (${item.approved_item_code}) has been approved and is now active.`,
      data: {
        itemId: item.id,
        itemName: item.name,
        itemCode: item.item_code,
        approvedItemCode: item.approved_item_code,
        approvedBy: approvedBy,
        criticality: item.criticality,
        type: 'item_master',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createItemMasterDeclinedNotification(item, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'item_master_declined',
      title: 'Item Master Declined',
      message: `Your item master "${item.name}" (${item.item_code}) has been declined. Reason: ${reason}`,
      data: {
        itemId: item.id,
        itemName: item.name,
        itemCode: item.item_code,
        declinedBy: declinedBy,
        reason: reason,
        criticality: item.criticality,
        type: 'item_master',
        action: 'declined'
      }
    }, originalUserId);
  }

  // Inventory Item Notifications
  static async createInventoryItemSubmittedNotification(inventoryItem, itemDetails, submittedByUserId) {
    await Notification.createForManagers({
      type: 'inventory_item_submitted',
      title: 'New Inventory Item Submitted for Approval',
      message: `Inventory item "${itemDetails.name}" has been submitted for approval with ${inventoryItem.currency} ${inventoryItem.unit_price} unit price.`,
      data: {
        inventoryItemId: inventoryItem.id,
        itemName: itemDetails.name,
        itemCode: itemDetails.approved_item_code,
        unitPrice: inventoryItem.unit_price,
        currency: inventoryItem.currency,
        conditionGrade: inventoryItem.condition_grade,
        submittedBy: submittedByUserId,
        type: 'inventory_item',
        action: 'submitted'
      }
    });
  }

  static async createInventoryItemApprovedNotification(inventoryItem, itemDetails, approvedBy, originalUserId) {
    await Notification.create({
      type: 'inventory_item_approved',
      title: 'Inventory Item Approved',
      message: `Your inventory item "${itemDetails.name}" has been approved and is now available for storage assignment.`,
      data: {
        inventoryItemId: inventoryItem.id,
        itemName: itemDetails.name,
        itemCode: itemDetails.approved_item_code,
        unitPrice: inventoryItem.unit_price,
        currency: inventoryItem.currency,
        approvedBy: approvedBy,
        type: 'inventory_item',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createInventoryItemDeclinedNotification(inventoryItem, itemDetails, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'inventory_item_declined',
      title: 'Inventory Item Declined',
      message: `Your inventory item "${itemDetails.name}" has been declined. Reason: ${reason}`,
      data: {
        inventoryItemId: inventoryItem.id,
        itemName: itemDetails.name,
        itemCode: itemDetails.approved_item_code,
        declinedBy: declinedBy,
        reason: reason,
        type: 'inventory_item',
        action: 'declined'
      }
    }, originalUserId);
  }

  // Storage Assignment Notifications
  static async createStorageAssignmentSubmittedNotification(assignment, assignmentDetails, submittedByUserId) {
    await Notification.createForManagers({
      type: 'storage_assignment_submitted',
      title: 'New Storage Assignment Submitted for Approval',
      message: `Storage assignment for "${assignmentDetails.item_name}" to ${assignmentDetails.storage_name} ${assignmentDetails.bin_code ? `(${assignmentDetails.bin_code})` : ''} has been submitted for approval.`,
      data: {
        assignmentId: assignment.id,
        inventoryItemId: assignment.inventory_item_id,
        itemName: assignmentDetails.item_name,
        itemCode: assignmentDetails.approved_item_code,
        storageLocationName: assignmentDetails.storage_name,
        storageLocationCode: assignmentDetails.storage_code,
        binCode: assignmentDetails.bin_code,
        binDescription: assignmentDetails.bin_description,
        submittedBy: submittedByUserId,
        type: 'storage_assignment',
        action: 'submitted'
      }
    });
  }

  static async createStorageAssignmentApprovedNotification(assignment, assignmentDetails, approvedBy, originalUserId) {
    await Notification.create({
      type: 'storage_assignment_approved',
      title: 'Storage Assignment Approved',
      message: `Your storage assignment for "${assignmentDetails.item_name}" to ${assignmentDetails.storage_name} ${assignmentDetails.bin_code ? `(${assignmentDetails.bin_code})` : ''} has been approved.`,
      data: {
        assignmentId: assignment.id,
        inventoryItemId: assignment.inventory_item_id,
        itemName: assignmentDetails.item_name,
        storageLocationName: assignmentDetails.storage_name,
        binCode: assignmentDetails.bin_code,
        approvedBy: approvedBy,
        type: 'storage_assignment',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createStorageAssignmentDeclinedNotification(assignment, assignmentDetails, declinedBy, originalUserId) {
    await Notification.create({
      type: 'storage_assignment_declined',
      title: 'Storage Assignment Declined',
      message: `Your storage assignment for "${assignmentDetails.item_name}" to ${assignmentDetails.storage_name} has been declined.`,
      data: {
        assignmentId: assignment.id,
        inventoryItemId: assignment.inventory_item_id,
        itemName: assignmentDetails.item_name,
        storageLocationName: assignmentDetails.storage_name,
        binCode: assignmentDetails.bin_code,
        declinedBy: declinedBy,
        type: 'storage_assignment',
        action: 'declined'
      }
    }, originalUserId);
  }

  // Storage Location Notifications
  static async createStorageLocationSubmittedNotification(storageLocation, submittedByUserId) {
    await Notification.createForManagers({
      type: 'storage_location_submitted',
      title: 'New Storage Location Submitted for Approval',
      message: `Storage location "${storageLocation.name}" (${storageLocation.code}) in ${storageLocation.city}, ${storageLocation.country} has been submitted for approval.`,
      data: {
        storageLocationId: storageLocation.id,
        name: storageLocation.name,
        code: storageLocation.code,
        city: storageLocation.city,
        country: storageLocation.country,
        address: storageLocation.address,
        submittedBy: submittedByUserId,
        type: 'storage_location',
        action: 'submitted'
      }
    });
  }

  static async createStorageLocationApprovedNotification(storageLocation, approvedBy, originalUserId) {
    await Notification.create({
      type: 'storage_location_approved',
      title: 'Storage Location Approved',
      message: `Your storage location "${storageLocation.name}" (${storageLocation.code}) has been approved and is now active for inventory storage.`,
      data: {
        storageLocationId: storageLocation.id,
        name: storageLocation.name,
        code: storageLocation.code,
        city: storageLocation.city,
        country: storageLocation.country,
        approvedBy: approvedBy,
        type: 'storage_location',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createStorageLocationDeclinedNotification(storageLocation, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'storage_location_declined',
      title: 'Storage Location Declined',
      message: `Your storage location "${storageLocation.name}" (${storageLocation.code}) has been declined. Reason: ${reason}`,
      data: {
        storageLocationId: storageLocation.id,
        name: storageLocation.name,
        code: storageLocation.code,
        declinedBy: declinedBy,
        reason: reason,
        type: 'storage_location',
        action: 'declined'
      }
    }, originalUserId);
  }

  // Bin Notifications
  static async createBinSubmittedNotification(bin, storageLocationDetails, submittedByUserId) {
    await Notification.createForManagers({
      type: 'bin_submitted',
      title: 'New Bin Submitted for Approval',
      message: `Bin "${bin.code}" in storage location "${storageLocationDetails.name}" has been submitted for approval.`,
      data: {
        binId: bin.id,
        binCode: bin.code,
        binDescription: bin.description,
        storageLocationId: bin.storage_location_id,
        storageLocationName: storageLocationDetails.name,
        storageLocationCode: storageLocationDetails.code,
        maxMassCapacity: bin.max_mass_capacity,
        maxVolumeCapacity: bin.max_volume_capacity,
        submittedBy: submittedByUserId,
        type: 'bin',
        action: 'submitted'
      }
    });
  }

  static async createBinApprovedNotification(bin, storageLocationDetails, approvedBy, originalUserId) {
    await Notification.create({
      type: 'bin_approved',
      title: 'Bin Approved',
      message: `Your bin "${bin.code}" in storage location "${storageLocationDetails.name}" has been approved and is now available for inventory storage.`,
      data: {
        binId: bin.id,
        binCode: bin.code,
        binDescription: bin.description,
        storageLocationName: storageLocationDetails.name,
        approvedBy: approvedBy,
        type: 'bin',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createBinDeclinedNotification(bin, storageLocationDetails, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'bin_declined',
      title: 'Bin Declined',
      message: `Your bin "${bin.code}" in storage location "${storageLocationDetails.name}" has been declined. Reason: ${reason}`,
      data: {
        binId: bin.id,
        binCode: bin.code,
        storageLocationName: storageLocationDetails.name,
        declinedBy: declinedBy,
        reason: reason,
        type: 'bin',
        action: 'declined'
      }
    }, originalUserId);
  }
  // Procurement Notifications
  
  // Supplier Notifications
  static async createSupplierSubmittedNotification(supplier, submittedByUserId) {
    await Notification.createForManagers({
      type: 'supplier_submitted',
      title: 'New Supplier Submitted for Approval',
      message: `Supplier "${supplier.legal_name}" (${supplier.supplier_code}) has been submitted for approval.`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        supplierType: supplier.supplier_type,
        email: supplier.email,
        submittedBy: submittedByUserId,
        type: 'supplier',
        action: 'submitted'
      }
    });
  }

  static async createSupplierApprovedNotification(supplier, approvedBy, originalUserId) {
    await Notification.create({
      type: 'supplier_approved',
      title: 'Supplier Approved - Awaiting Supplier Confirmation',
      message: `Your supplier "${supplier.legal_name}" (${supplier.supplier_code}) has been approved by management. A partnership invitation email has been sent to the supplier for their confirmation.`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        approvedBy: approvedBy,
        type: 'supplier',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createSupplierDeclinedNotification(supplier, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'supplier_declined',
      title: 'Supplier Declined',
      message: `Your supplier "${supplier.legal_name}" (${supplier.supplier_code}) has been declined. Reason: ${reason}`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        declinedBy: declinedBy,
        reason: reason,
        type: 'supplier',
        action: 'declined'
      }
    }, originalUserId);
  }

  // Purchase Requisition Notifications
  static async createPRSubmittedNotification(pr, submittedByUserId) {
    await Notification.createForManagers({
      type: 'pr_submitted',
      title: 'New Purchase Requisition Submitted',
      message: `Purchase requisition ${pr.pr_number} for "${pr.item_description}" has been submitted for approval.`,
      data: {
        prId: pr.id,
        prNumber: pr.pr_number,
        costCenter: pr.cost_center,
        itemDescription: pr.item_description,
        quantity: pr.quantity,
        estimatedValue: pr.estimated_unit_price ? (pr.quantity * pr.estimated_unit_price) : null,
        currency: pr.currency,
        submittedBy: submittedByUserId,
        type: 'purchase_requisition',
        action: 'submitted'
      }
    });
  }

  static async createPRApprovedNotification(pr, approvedBy, originalUserId) {
    await Notification.create({
      type: 'pr_approved',
      title: 'Purchase Requisition Approved',
      message: `Your purchase requisition ${pr.pr_number} has been approved and can now be processed for RFQ or direct purchase.`,
      data: {
        prId: pr.id,
        prNumber: pr.pr_number,
        costCenter: pr.cost_center,
        itemDescription: pr.item_description,
        approvedBy: approvedBy,
        type: 'purchase_requisition',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createPRDeclinedNotification(pr, declinedBy, originalUserId, reason) {
    await Notification.create({
      type: 'pr_declined',
      title: 'Purchase Requisition Declined',
      message: `Your purchase requisition ${pr.pr_number} has been declined. Reason: ${reason}`,
      data: {
        prId: pr.id,
        prNumber: pr.pr_number,
        costCenter: pr.cost_center,
        itemDescription: pr.item_description,
        declinedBy: declinedBy,
        reason: reason,
        type: 'purchase_requisition',
        action: 'declined'
      }
    }, originalUserId);
  }

  // RFQ Notifications
  static async createRFQSentNotification(rfq, suppliers, sentByUserId) {
    // Notify managers about RFQ being sent
    await Notification.createForManagers({
      type: 'rfq_sent',
      title: 'RFQ Sent to Suppliers',
      message: `RFQ ${rfq.rfq_number} "${rfq.title}" has been sent to ${suppliers.length} suppliers.`,
      data: {
        rfqId: rfq.id,
        rfqNumber: rfq.rfq_number,
        title: rfq.title,
        supplierCount: suppliers.length,
        responseDeadline: rfq.response_deadline,
        sentBy: sentByUserId,
        type: 'rfq',
        action: 'sent'
      }
    });
  }

  static async createRFQResponseReceivedNotification(rfq, supplier, responseByUserId) {
    await Notification.createForManagers({
      type: 'rfq_response_received',
      title: 'RFQ Response Received',
      message: `${supplier.legal_name} has submitted a response to RFQ ${rfq.rfq_number} "${rfq.title}".`,
      data: {
        rfqId: rfq.id,
        rfqNumber: rfq.rfq_number,
        title: rfq.title,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        responseBy: responseByUserId,
        type: 'rfq',
        action: 'response_received'
      }
    });
  }

  static async createRFQSupplierSelectedNotification(rfq, winningSupplier, selectedBy) {
    await Notification.createForManagers({
      type: 'rfq_supplier_selected',
      title: 'RFQ Supplier Selected',
      message: `${winningSupplier.legal_name} has been selected as the winning supplier for RFQ ${rfq.rfq_number}.`,
      data: {
        rfqId: rfq.id,
        rfqNumber: rfq.rfq_number,
        title: rfq.title,
        winningSupplier: winningSupplier.legal_name,
        supplierCode: winningSupplier.supplier_code,
        selectionReason: rfq.selection_reason,
        selectedBy: selectedBy,
        type: 'rfq',
        action: 'supplier_selected'
      }
    });
  }

  // Purchase Order Notifications
  static async createPOSubmittedNotification(po, submittedByUserId) {
    await Notification.createForManagers({
      type: 'po_submitted',
      title: 'Purchase Order Submitted for Approval',
      message: `Purchase order ${po.po_number} for ${po.supplier_name || 'supplier'} totaling ${po.currency} ${po.total_amount} has been submitted for approval.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        deliveryDate: po.delivery_date,
        submittedBy: submittedByUserId,
        type: 'purchase_order',
        action: 'submitted'
      }
    });
  }

  static async createPOApprovedNotification(po, approvedBy, originalUserId) {
    await Notification.create({
      type: 'po_approved',
      title: 'Purchase Order Approved',
      message: `Your purchase order ${po.po_number} has been approved and can now be sent to the supplier.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        approvedBy: approvedBy,
        type: 'purchase_order',
        action: 'approved'
      }
    }, originalUserId);
  }

  static async createPOSentToSupplierNotification(po, sentByUserId) {
    await Notification.createForManagers({
      type: 'po_sent_to_supplier',
      title: 'Purchase Order Sent to Supplier',
      message: `Purchase order ${po.po_number} has been sent to ${po.supplier_name}.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        deliveryDate: po.delivery_date,
        sentBy: sentByUserId,
        type: 'purchase_order',
        action: 'sent_to_supplier'
      }
    });
  }

  static async createPOConfirmedNotification(po) {
    await Notification.createForManagers({
      type: 'po_confirmed',
      title: 'Purchase Order Confirmed by Supplier',
      message: `Purchase order ${po.po_number} has been confirmed by ${po.supplier_name}.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        deliveryDate: po.delivery_date,
        type: 'purchase_order',
        action: 'confirmed'
      }
    });
  }

  static async createPOItemsReceivedNotification(po, lineItem, quantityReceived) {
    await Notification.createForManagers({
      type: 'po_items_received',
      title: 'Purchase Order Items Received',
      message: `${quantityReceived} units of "${lineItem.item_description}" have been received for PO ${po.po_number}.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        itemDescription: lineItem.item_description,
        quantityReceived: quantityReceived,
        totalQuantity: lineItem.quantity,
        type: 'purchase_order',
        action: 'items_received'
      }
    });
  }

  // Contract Notifications
  static async createContractCreatedNotification(contract, createdByUserId) {
    await Notification.createForManagers({
      type: 'contract_created',
      title: 'New Contract Created',
      message: `Contract ${contract.contract_number} "${contract.contract_name}" with ${contract.supplier_name} has been created.`,
      data: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        contractName: contract.contract_name,
        supplierName: contract.supplier_name,
        contractType: contract.contract_type,
        startDate: contract.start_date,
        endDate: contract.end_date,
        createdBy: createdByUserId,
        type: 'contract',
        action: 'created'
      }
    });
  }

  static async createContractSentToSupplierNotification(contract, sentByUserId) {
    await Notification.createForManagers({
      type: 'contract_sent_to_supplier',
      title: 'Contract Sent to Supplier',
      message: `Contract ${contract.contract_number} has been sent to ${contract.supplier_name} for review.`,
      data: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        contractName: contract.contract_name,
        supplierName: contract.supplier_name,
        sentBy: sentByUserId,
        type: 'contract',
        action: 'sent_to_supplier'
      }
    });
  }

  static async createContractActivatedNotification(contract, activatedBy) {
    await Notification.createForManagers({
      type: 'contract_activated',
      title: 'Contract Activated',
      message: `Contract ${contract.contract_number} with ${contract.supplier_name} is now active and available for purchase orders.`,
      data: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        contractName: contract.contract_name,
        supplierName: contract.supplier_name,
        startDate: contract.start_date,
        endDate: contract.end_date,
        activatedBy: activatedBy,
        type: 'contract',
        action: 'activated'
      }
    });
  }

  static async createContractExpiringNotification(contract, daysUntilExpiry) {
    await Notification.createForManagers({
      type: 'contract_expiring',
      title: 'Contract Expiring Soon',
      message: `Contract ${contract.contract_number} with ${contract.supplier_name} will expire in ${daysUntilExpiry} days.`,
      data: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        contractName: contract.contract_name,
        supplierName: contract.supplier_name,
        endDate: contract.end_date,
        daysUntilExpiry: daysUntilExpiry,
        type: 'contract',
        action: 'expiring_warning'
      }
    });
  }

  // Supplier Certification Notifications
  static async createSupplierCertifiedNotification(supplier, certifiedBy, originalUserId) {
    await Notification.create({
      type: 'supplier_certified',
      title: 'Supplier Certified',
      message: `Your supplier "${supplier.legal_name}" (${supplier.supplier_code}) has been certified and can now be used for contracts and purchase orders.`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        certifiedBy: certifiedBy,
        type: 'supplier',
        action: 'certified'
      }
    }, originalUserId);
  }

  static async createSupplierDecertifiedNotification(supplier, decertifiedBy, originalUserId, reason) {
    await Notification.create({
      type: 'supplier_decertified',
      title: 'Supplier Certification Revoked',
      message: `Certification for supplier "${supplier.legal_name}" (${supplier.supplier_code}) has been revoked. Reason: ${reason}`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        decertifiedBy: decertifiedBy,
        reason: reason,
        type: 'supplier',
        action: 'decertified'
      }
    }, originalUserId);
  }

  // Supplier Partnership Notifications
  static async createSupplierPartnershipAcceptedNotification(supplier, originalUserId) {
    await Notification.create({
      type: 'supplier_partnership_accepted',
      title: 'Supplier Partnership Accepted - Now Active',
      message: `Supplier "${supplier.legal_name}" (${supplier.supplier_code}) has accepted the partnership invitation and is now fully active for procurement processes.`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        type: 'supplier',
        action: 'partnership_accepted'
      }
    }, originalUserId);
  }

  static async createSupplierPartnershipDeclinedNotification(supplier, originalUserId, reason) {
    await Notification.create({
      type: 'supplier_partnership_declined',
      title: 'Supplier Partnership Declined',
      message: `Supplier "${supplier.legal_name}" (${supplier.supplier_code}) has declined partnership. ${reason ? `Reason: ${reason}` : ''}`,
      data: {
        supplierId: supplier.id,
        supplierName: supplier.legal_name,
        supplierCode: supplier.supplier_code,
        reason: reason,
        type: 'supplier',
        action: 'partnership_declined'
      }
    }, originalUserId);
  }

  // Purchase Order Supplier Response Notifications
  static async createPOSupplierConfirmedNotification(po, originalUserId) {
    await Notification.createForManagers({
      type: 'po_supplier_confirmed',
      title: 'Purchase Order Confirmed by Supplier',
      message: `Purchase Order ${po.po_number} has been confirmed by the supplier and is ready for fulfillment.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        type: 'purchase_order',
        action: 'supplier_confirmed'
      }
    });
  }

  static async createPOSupplierRejectedNotification(po, originalUserId, reason) {
    await Notification.createForManagers({
      type: 'po_supplier_rejected',
      title: 'Purchase Order Rejected by Supplier',
      message: `Purchase Order ${po.po_number} has been rejected by the supplier. Reason: ${reason}`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        reason: reason,
        type: 'purchase_order',
        action: 'supplier_rejected'
      }
    });
  }

  // Create delivery verified notification
  static async createDeliveryVerifiedNotification(po, verifiedBy) {
    await Notification.create({
      type: 'po_delivery_verified',
      title: 'Delivery Verified',
      message: `Purchase order ${po.po_number} delivery has been verified and is ready for goods receipt.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        verifiedBy: verifiedBy,
        type: 'purchase_order',
        action: 'delivery_verified'
      }
    }, po.created_by);
  }

  // Create delivery issue notification  
  static async createDeliveryIssueNotification(po, reportedBy, issue) {
    await Notification.create({
      type: 'po_delivery_issue',
      title: 'Delivery Issue Reported',
      message: `There is an issue with purchase order ${po.po_number} delivery. Issue: ${issue}`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        reportedBy: reportedBy,
        issue: issue,
        type: 'purchase_order',
        action: 'delivery_issue'
      }
    }, po.created_by);
  }

  // Customer delivery notifications
  static async createCustomerDeliveryNotification(po, handoverBy) {
    await Notification.createForManagers({
      type: 'po_delivered_to_customer',
      title: 'Purchase Order Delivered to Customer',
      message: `Purchase order ${po.po_number} has been delivered to the customer. Awaiting customer confirmation.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        handoverBy: handoverBy,
        type: 'purchase_order',
        action: 'delivered_to_customer'
      }
    });
  }

  static async createCustomerConfirmationNotification(po, confirmedBy) {
    await Notification.createForManagers({
      type: 'po_customer_confirmed',
      title: 'Customer Confirmed Delivery',
      message: `Customer has confirmed receipt of purchase order ${po.po_number}. Order is now complete.`,
      data: {
        poId: po.id,
        poNumber: po.po_number,
        supplierName: po.supplier_name,
        totalAmount: po.total_amount,
        currency: po.currency,
        confirmedBy: confirmedBy,
        type: 'purchase_order',
        action: 'customer_confirmed'
      }
    });
  }
}

module.exports = NotificationService;