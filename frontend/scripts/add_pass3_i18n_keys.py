#!/usr/bin/env python3
"""
Add the pass-3 new i18n keys to en.json and all locale files.
"""
import json, os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')

LOCALES = ['ar','az','bn','de','es','fa','fr','hi','id','it','ja','ko','nl','pl','pt','ru','tr','uk','ur','vi','zh']

NEW_KEYS = {
    # BOM
    "bomCannotBeActivatedWithNoComponents": "A bill of material with no components cannot be activated.",
    "couldNotLoadTheItemMaster": "Could not load the item master",
    "chooseWhichItemThisRecipeProduces": "Choose which item this recipe produces",
    "outputQuantityMustBeGreaterThanZero": "Output quantity must be greater than zero",
    "itemCannotBeComponentOfItself": "An item cannot be a component of itself.",
    "pleaseAddAtLeastOneComponent": "Please add at least one component",
    "bomActivated": "Bill of material activated",
    "bomSaved": "Bill of material saved",
    "bomCreated": "Bill of material created",
    "bomDeleted": "Bill of material deleted",
    "failedToDeleteBom": "Failed to delete bill of material",
    "failedToLoadBillsOfMaterial": "Failed to load bills of material",
    # BinCreate
    "binSubmittedForApproval": "Bin submitted for approval",
    "binSavedAsDraft": "Bin saved as draft",
    "maxMassCapacityMustBeGreaterThanZero": "Maximum mass capacity must be greater than 0",
    "maxVolumeCapacityMustBeGreaterThanZero": "Maximum volume capacity must be greater than 0",
    "currentMassUsedCannotExceedMaximum": "Current mass used cannot exceed maximum mass capacity",
    "binNameIsRequired": "Bin name is required",
    "storageLocationIsRequired": "Storage location is required",
    # Integrations
    "apiKeysAreAdministratorOnly": "API keys are administrator-only",
    "keyRevoked": "Key revoked",
    "giveTheKeyAName": "Give the key a name",
    "keyWithNoScopesCanDoNothing": "A key with no scopes can do nothing",
    "apiKeyCreated": "API key created",
    "failedToCreateApiKey": "Failed to create API key",
    # SalesContractCreate
    "contractSentForApproval": "Contract sent for approval",
    "contractCreated": "Contract created",
    "failedToCreateContract": "Failed to create contract",
    # SalesQuotationCreate
    "quotationSentForApproval": "Quotation sent for approval",
    "quotationCreated": "Quotation created",
    "failedToCreateQuotation": "Failed to create quotation",
    # SalesRfqCreate
    "rfqSentForApproval": "RFQ sent for approval",
    "rfqCreated": "RFQ created",
    "failedToCreateRfq": "Failed to create RFQ",
    # SalesOrderCreate
    "salesOrderCreatedSuccessfully": "Sales order created successfully",
    "failedToCreateSalesOrder": "Failed to create sales order",
    # StockAdjustment
    "pleaseSelectItemAndEnterQuantity": "Please select an item and enter a quantity",
    "stockAdjustmentSubmittedForApproval": "Stock adjustment submitted for approval",
    "stockAdjustmentPostedSuccessfully": "Stock adjustment posted successfully",
    "pleaseAddAtLeastOneItemToAdjust": "Please add at least one item to adjust",
    "pleaseRemoveItemsWithZeroQuantity": "Please remove items with zero adjustment quantity",
    # InventoryItemEdit/Create
    "failedToFetchInventoryItem": "Failed to fetch inventory item",
    "minStockCannotExceedMax": "Minimum stock level cannot be greater than maximum stock level",
    "reorderPointShouldNotBeLessThanMin": "Reorder point should not be less than minimum stock level",
    "reorderPointShouldNotExceedMax": "Reorder point should not be greater than maximum stock level",
    "inventoryItemUpdatedSuccessfully": "Inventory item updated successfully",
    "failedToUpdateInventoryItem": "Failed to update inventory item",
    "failedToSaveInventoryItem": "Failed to save inventory item",
    "inventoryItemCreatedSuccessfully": "Inventory item created successfully",
    "failedToCreateInventoryItem": "Failed to create inventory item",
    # DeliveryScheduling
    "pleaseSelectAnOrder": "Please select an order",
    "pleaseSelectItemsToDeliver": "Please select items to deliver",
    "failedToLoadOrders": "Failed to load orders",
    "failedToLoadSchedule": "Failed to load schedule",
    # GoodsReceipt
    "goodsReceiptPosted": "Goods receipt posted",
    "failedToPostGoodsReceipt": "Failed to post goods receipt",
    # GoodsTransfer
    "goodsTransferPosted": "Goods transfer posted",
    "failedToPostGoodsTransfer": "Failed to post goods transfer",
    # Finance
    "transactionMatched": "Transaction matched",
    "failedToMatchTransaction": "Failed to match transaction",
    "matchCleared": "Match cleared",
    "failedToClearMatch": "Failed to clear match",
    "budgetSaved": "Budget saved",
    "failedToSaveBudget": "Failed to save budget",
    "budgetDeleted": "Budget deleted",
    "failedToDeleteBudget": "Failed to delete budget",
    "rateUpdated": "Rate updated",
    "failedToUpdateRate": "Failed to update rate",
    "currencyAdded": "Currency added",
    "failedToAddCurrency": "Failed to add currency",
    "supplierNameAndAmountRequired": "Supplier name and total amount are required",
    # Reports
    "scheduleCreated": "Schedule created",
    "failedToCreateSchedule": "Failed to create schedule",
    "scheduleDeleted": "Schedule deleted",
    "failedToDeleteSchedule": "Failed to delete schedule",
    # Projects
    "timeLogged": "Time logged",
    "failedToLogTime": "Failed to log time",
    "entryDeleted": "Entry deleted",
    "failedToDeleteEntry": "Failed to delete entry",
    # AI
    "failedToSendMessage": "Failed to send message",
    "conversationCleared": "Conversation cleared",
    "failedToLoadConversation": "Failed to load conversation",
    "documentUploaded": "Document uploaded",
    "failedToUploadDocument": "Failed to upload document",
    "documentDeleted": "Document deleted",
    "failedToDeleteDocument": "Failed to delete document",
}

# Simple machine-like translations for structural languages
# (English fallback is fine for toast messages — still better than hard-coded)
SPOT_TRANSLATIONS = {
    "de": {
        "bomCannotBeActivatedWithNoComponents": "Eine Stückliste ohne Komponenten kann nicht aktiviert werden.",
        "bomActivated": "Stückliste aktiviert", "bomSaved": "Stückliste gespeichert",
        "bomCreated": "Stückliste erstellt", "bomDeleted": "Stückliste gelöscht",
        "binSubmittedForApproval": "Lagerplatz zur Genehmigung eingereicht",
        "binSavedAsDraft": "Lagerplatz als Entwurf gespeichert",
        "binNameIsRequired": "Lagerplatzname ist erforderlich",
        "contractSentForApproval": "Vertrag zur Genehmigung gesendet",
        "contractCreated": "Vertrag erstellt",
        "quotationSentForApproval": "Angebot zur Genehmigung gesendet",
        "quotationCreated": "Angebot erstellt",
        "salesOrderCreatedSuccessfully": "Verkaufsauftrag erfolgreich erstellt",
        "stockAdjustmentPostedSuccessfully": "Bestandskorrektur erfolgreich gebucht",
        "inventoryItemUpdatedSuccessfully": "Lagerartikel erfolgreich aktualisiert",
        "inventoryItemCreatedSuccessfully": "Lagerartikel erfolgreich erstellt",
        "goodsReceiptPosted": "Wareneingang gebucht",
        "goodsTransferPosted": "Warenübergabe gebucht",
        "budgetSaved": "Budget gespeichert", "budgetDeleted": "Budget gelöscht",
        "rateUpdated": "Kurs aktualisiert", "currencyAdded": "Währung hinzugefügt",
        "scheduleCreated": "Zeitplan erstellt", "scheduleDeleted": "Zeitplan gelöscht",
        "timeLogged": "Zeit erfasst", "entryDeleted": "Eintrag gelöscht",
        "documentUploaded": "Dokument hochgeladen", "documentDeleted": "Dokument gelöscht",
        "keyRevoked": "Schlüssel widerrufen", "apiKeyCreated": "API-Schlüssel erstellt",
    },
    "fr": {
        "bomCannotBeActivatedWithNoComponents": "Une nomenclature sans composants ne peut pas être activée.",
        "bomActivated": "Nomenclature activée", "bomSaved": "Nomenclature enregistrée",
        "bomCreated": "Nomenclature créée", "bomDeleted": "Nomenclature supprimée",
        "binSubmittedForApproval": "Emplacement soumis pour approbation",
        "binSavedAsDraft": "Emplacement enregistré comme brouillon",
        "contractSentForApproval": "Contrat envoyé pour approbation",
        "contractCreated": "Contrat créé",
        "quotationSentForApproval": "Devis envoyé pour approbation",
        "quotationCreated": "Devis créé",
        "salesOrderCreatedSuccessfully": "Commande de vente créée avec succès",
        "goodsReceiptPosted": "Réception de marchandises enregistrée",
        "budgetSaved": "Budget enregistré", "budgetDeleted": "Budget supprimé",
        "documentUploaded": "Document téléchargé", "documentDeleted": "Document supprimé",
        "keyRevoked": "Clé révoquée", "apiKeyCreated": "Clé API créée",
    },
    "es": {
        "bomCannotBeActivatedWithNoComponents": "Una lista de materiales sin componentes no puede activarse.",
        "bomActivated": "Lista de materiales activada", "bomSaved": "Lista de materiales guardada",
        "bomCreated": "Lista de materiales creada", "bomDeleted": "Lista de materiales eliminada",
        "contractSentForApproval": "Contrato enviado para aprobación",
        "contractCreated": "Contrato creado",
        "quotationCreated": "Presupuesto creado",
        "salesOrderCreatedSuccessfully": "Pedido de venta creado correctamente",
        "goodsReceiptPosted": "Entrada de mercancía registrada",
        "budgetSaved": "Presupuesto guardado", "documentUploaded": "Documento cargado",
    },
    "ar": {
        "bomActivated": "تم تفعيل قائمة المواد", "bomSaved": "تم حفظ قائمة المواد",
        "bomCreated": "تم إنشاء قائمة المواد", "bomDeleted": "تم حذف قائمة المواد",
        "contractSentForApproval": "تم إرسال العقد للاعتماد",
        "contractCreated": "تم إنشاء العقد",
        "quotationCreated": "تم إنشاء عرض الأسعار",
        "salesOrderCreatedSuccessfully": "تم إنشاء أمر البيع بنجاح",
        "goodsReceiptPosted": "تم ترحيل استلام البضاعة",
        "budgetSaved": "تم حفظ الميزانية",
    },
    "zh": {
        "bomActivated": "物料清单已激活", "bomSaved": "物料清单已保存",
        "bomCreated": "物料清单已创建", "bomDeleted": "物料清单已删除",
        "contractSentForApproval": "合同已发送审批",
        "contractCreated": "合同已创建",
        "quotationCreated": "报价已创建",
        "salesOrderCreatedSuccessfully": "销售订单已成功创建",
        "goodsReceiptPosted": "收货已过账",
        "budgetSaved": "预算已保存",
        "documentUploaded": "文档已上传",
    },
    "ja": {
        "bomActivated": "部品表が有効化されました", "bomCreated": "部品表が作成されました",
        "contractCreated": "契約が作成されました",
        "quotationCreated": "見積もりが作成されました",
        "salesOrderCreatedSuccessfully": "販売注文が正常に作成されました",
        "documentUploaded": "ドキュメントがアップロードされました",
    },
    "ru": {
        "bomActivated": "Спецификация активирована", "bomCreated": "Спецификация создана",
        "contractCreated": "Договор создан",
        "quotationCreated": "Коммерческое предложение создано",
        "salesOrderCreatedSuccessfully": "Заказ на продажу успешно создан",
    },
    "pt": {
        "bomActivated": "Lista de materiais ativada", "bomCreated": "Lista de materiais criada",
        "contractCreated": "Contrato criado",
        "quotationCreated": "Orçamento criado",
        "salesOrderCreatedSuccessfully": "Pedido de venda criado com sucesso",
    },
    "tr": {
        "bomActivated": "Ürün ağacı aktif edildi", "bomCreated": "Ürün ağacı oluşturuldu",
        "contractCreated": "Sözleşme oluşturuldu",
        "quotationCreated": "Teklif oluşturuldu",
        "salesOrderCreatedSuccessfully": "Satış siparişi başarıyla oluşturuldu",
    },
    "ko": {
        "bomCreated": "자재명세서가 생성되었습니다",
        "contractCreated": "계약이 생성되었습니다",
        "salesOrderCreatedSuccessfully": "판매 주문이 성공적으로 생성되었습니다",
    },
}

def update_locale(lang):
    fpath = os.path.join(LOCALES_DIR, f'{lang}.json')
    if not os.path.exists(fpath):
        return
    with open(fpath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if 'ui' not in data:
        data['ui'] = {}
    spot = SPOT_TRANSLATIONS.get(lang, {})
    added = 0
    for k, en_val in NEW_KEYS.items():
        if k not in data['ui']:
            data['ui'][k] = spot.get(k, en_val)
            added += 1
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f"  {lang}.json: +{added} keys")

# en.json
en_file = os.path.join(LOCALES_DIR, 'en.json')
with open(en_file, 'r', encoding='utf-8') as f:
    en_data = json.load(f)
if 'ui' not in en_data:
    en_data['ui'] = {}
added_en = 0
for k, v in NEW_KEYS.items():
    if k not in en_data['ui']:
        en_data['ui'][k] = v
        added_en += 1
with open(en_file, 'w', encoding='utf-8') as f:
    json.dump(en_data, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(f"en.json: +{added_en} keys")

for lang in LOCALES:
    update_locale(lang)

print("Done.")
