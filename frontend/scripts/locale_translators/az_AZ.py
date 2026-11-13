import os
import json
import re

AZ_GLOSSARY = {
    "Debit": "Debet",
    "Credit": "Kredit",
    "Post": "İcra et",
    "Posted": "İcra olundu",
    "Entry": "Müxabirləşmə",
    "Balance": "Balans",
    "Draft": "Qaralama",
    "Item": "Mal-material",
    "Items": "Mal-materiallar",
    "Order": "Sifariş",
    "Orders": "Sifarişlər",
    "Goods receipt": "Malın daxilolma qaiməsi",
    "Goods Receipt": "Malın daxilolma qaiməsi",
    "Aging": "Yaşlanma hesabatı",
    "Period close": "Dövrün bağlanması",
    "Period Close": "Dövrün bağlanması",
    "Requisition": "Satınalma sorğusu",
    "Cost centre": "Məsrəf mərkəzi",
    "Cost Centre": "Məsrəf mərkəzi",
    "Cost Center": "Məsrəf mərkəzi",
    "Fixed assets": "Əsas vəsaitlər",
    "Fixed Assets": "Əsas vəsaitlər",
    "Trial balance": "Sınaq balansı",
    "Trial Balance": "Sınaq balansı",
    "Purchase order": "Satınalma sifarişi",
    "Purchase Order": "Satınalma sifarişi",
    "Purchase Orders": "Satınalma sifarişləri",
    "Sales order": "Satış sifarişi",
    "Sales Order": "Satış sifarişi",
    "Sales Orders": "Satış sifarişləri",
    "Inventory Items": "Stok malları",
    "Create Inventory Item": "Yeni stok malı yarat",
    "No inventory items found.": "Stok malı tapılmadı.",
}

def translate_az_AZ(key, en_text):
    if en_text in AZ_GLOSSARY:
        return AZ_GLOSSARY[en_text]
    
    # Placeholder extraction
    phs = re.findall(r'\{\w+\}', en_text)
    
    # Basic translation rules for Azerbaijani UI
    text = en_text
    
    # Common prefixes/patterns
    if text.startswith("Create "):
        sub = text[7:]
        return f"Yeni {translate_az_AZ(key, sub).lower()} yarat"
    if text.startswith("Edit "):
        sub = text[5:]
        return f"{translate_az_AZ(key, sub)} redaktə et"
    if text.startswith("Delete "):
        sub = text[7:]
        return f"{translate_az_AZ(key, sub)} sil"
    if text.startswith("View "):
        sub = text[5:]
        return f"{translate_az_AZ(key, sub)} bax"
    if text.startswith("Select "):
        sub = text[7:]
        return f"{translate_az_AZ(key, sub)} seç"
    if text.startswith("No ") and text.endswith(" found."):
        sub = text[3:-7]
        return f"{translate_az_AZ(key, sub)} tapılmadı."
    
    # Fallback placeholder-safe formatting
    for ph in phs:
        text = text.replace(ph, ph)
        
    return text
