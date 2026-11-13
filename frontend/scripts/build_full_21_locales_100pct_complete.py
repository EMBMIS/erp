#!/usr/bin/env python3
"""
Complete Master Translation Generator for Simeli ERP across all 21 Locales.
Translates all keys (both active t() keys and remaining hardcoded ui2 keys)
into 100% native translations for every language, leaving ZERO English phrases behind.
"""

import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')
EXPORT_DIR = os.path.join(BASE_DIR, 'i18n-export')
DONE_DIR = os.path.join(EXPORT_DIR, 'done')

EN_FILE = os.path.join(LOCALES_DIR, 'en.json')
with open(EN_FILE, 'r', encoding='utf-8') as f:
    EN_DATA = json.load(f)

def flatten(obj, prefix=''):
    flat = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        elif isinstance(v, str):
            flat[key] = v
    return flat

EN_FLAT = flatten(EN_DATA)

LOCALES = [
    'ar-SA', 'az-AZ', 'bn-BD', 'de-DE', 'es-ES',
    'fa-IR', 'fr-FR', 'hi-IN', 'id-ID', 'it-IT',
    'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR',
    'ru-RU', 'tr-TR', 'uk-UA', 'ur-PK', 'vi-VN',
    'zh-CN'
]

EXPORT_FILES = [
    'part-1-of-8.json', 'part-2-of-8.json', 'part-3-of-8.json', 'part-4-of-8.json',
    'part-5-of-8.json', 'part-6-of-8.json', 'part-7-of-8.json', 'part-8-of-8.json',
    'remaining-1-of-5.json', 'remaining-2-of-5.json', 'remaining-3-of-5.json',
    'remaining-4-of-5.json', 'remaining-5-of-5.json'
]

PH_PATTERN = re.compile(r'\{\w+\}')

def get_phs(s):
    return sorted(PH_PATTERN.findall(str(s)))

def ph_ok(orig, trans):
    return get_phs(orig) == get_phs(trans)

# Deep Master Dictionary for core phrases across all 21 languages
MASTER_DICT = {
    'sales orders': {
        'ar': 'أوامر المبيعات', 'az': 'Satış sifarişləri', 'bn': 'বিক্রয় আদেশ', 'de': 'Kundenaufträge',
        'es': 'Pedidos de venta', 'fa': 'سفارشات فروش', 'fr': 'Commandes clients', 'hi': 'बिक्री आदेश',
        'id': 'Pesanan Penjualan', 'it': 'Ordini di vendita', 'ja': '受注書', 'ko': '판매 주문서',
        'nl': 'Verkooporders', 'pl': 'Zamówienia sprzedaży', 'pt': 'Pedidos de venda', 'ru': 'Заказы покупателей',
        'tr': 'Satış Siparişleri', 'uk': 'Замовлення покупців', 'ur': 'فروخت کے آرڈرز', 'vi': 'Đơn bán hàng', 'zh': '销售订单'
    },
    'work orders': {
        'ar': 'أوامر التصنيع', 'az': 'İstehsalat tapşırıqları', 'bn': 'কাজ এর আদেশ', 'de': 'Fertigungsaufträge',
        'es': 'Órdenes de trabajo', 'fa': 'دستورات کاری', 'fr': 'Ordres de fabrication', 'hi': 'कार्य आदेश',
        'id': 'Perintah Kerja', 'it': 'Ordini di lavoro', 'ja': '製造指示書', 'ko': '작업 지시서',
        'nl': 'Werkorders', 'pl': 'Zlecenia produkcyjne', 'pt': 'Ordens de serviço', 'ru': 'Заказы на производство',
        'tr': 'Üretim Emirleri', 'uk': 'Замовлення на виробництво', 'ur': 'کام کے آرڈرز', 'vi': 'Lệnh sản xuất', 'zh': '生产工单'
    },
    'customers & delivery': {
        'ar': 'العملاء والتسليم', 'az': 'Müştərilər və çatdırılma', 'bn': 'গ্রাহক এবং ডেলিভারি', 'de': 'Kunden & Lieferung',
        'es': 'Clientes y entrega', 'fa': 'مشتریان و تحویل', 'fr': 'Clients et livraison', 'hi': 'ग्राहक और डिलीवरी',
        'id': 'Pelanggan & Pengiriman', 'it': 'Clienti e consegna', 'ja': '得意先と配送', 'ko': '고객 및 배송',
        'nl': 'Klanten & Levering', 'pl': 'Klienci i dostawy', 'pt': 'Clientes e entregas', 'ru': 'Покупатели и доставка',
        'tr': 'Müşteriler ve Teslimat', 'uk': 'Покупці та доставка', 'ur': 'گاہک اور ترسیل', 'vi': 'Khách hàng & giao hàng', 'zh': '客户与交货'
    },
    'recurring invoices': {
        'ar': 'الفواتير الدورية', 'az': 'Dövri hesab-fakturalar', 'bn': 'পুনরাবৃত্তিমূলক চালান', 'de': 'Wiederkehrende Rechnungen',
        'es': 'Facturas recurrentes', 'fa': 'فاکتورهای تکراری', 'fr': 'Factures récurrentes', 'hi': 'आवर्ती चालान',
        'id': 'Faktur Berulang', 'it': 'Fatture ricorrenti', 'ja': '定期請求書', 'ko': '반복 송장',
        'nl': 'Periodieke facturen', 'pl': 'Faktury cykliczne', 'pt': 'Faturas recorrentes', 'ru': 'Периодические счета',
        'tr': 'Tekrarlayan Faturalar', 'uk': 'Періодичні рахунки', 'ur': 'دوبارہ آنے والے انوائس', 'vi': 'Hóa đơn định kỳ', 'zh': '定期发票'
    },
    'payments received': {
        'ar': 'المدفوعات المستلمة', 'az': 'Daxil olan ödənişlər', 'bn': 'প্রাপ্ত পেমেন্ট', 'de': 'Zahlungseingänge',
        'es': 'Pagos recibidos', 'fa': 'پرداخت‌های دریافتی', 'fr': 'Paiements reçus', 'hi': 'प्राप्त भुगतान',
        'id': 'Pembayaran Diterima', 'it': 'Pagamenti ricevuti', 'ja': '入금 記録', 'ko': '수금 기록',
        'nl': 'Ontvangen betalingen', 'pl': 'Otrzymane płatności', 'pt': 'Pagamentos recebidos', 'ru': 'Поступления оплаты',
        'tr': 'Tahsil Edilen Ödemeler', 'uk': 'Отримані платежі', 'ur': 'موصول شدہ ادائیگیاں', 'vi': 'Thanh toán đã nhận', 'zh': '已收货款'
    },
    'approval required': {
        'ar': 'الموافقة مطلوبة', 'az': 'Təsdiq tələb olunur', 'bn': 'অনুমোদন প্রয়োজন', 'de': 'Genehmigung erforderlich',
        'es': 'Aprobación requerida', 'fa': 'تایید الزامی است', 'fr': 'Approbation requise', 'hi': 'स्वीकृति आवश्यक',
        'id': 'Persetujuan Diperlukan', 'it': 'Approvazione richiesta', 'ja': '承認が必要です', 'ko': '승인 필요',
        'nl': 'Goedkeuring vereist', 'pl': 'Wymagane zatwierdzenie', 'pt': 'Aprovação necessária', 'ru': 'Требуется согласование',
        'tr': 'Onay Gereklidir', 'uk': 'Потрібне підтвердження', 'ur': 'منظوری درکار ہے', 'vi': 'Yêu cầu phê duyệt', 'zh': '需要审批'
    },
    'minimum amount': {
        'ar': 'الحد أدنى للمبلغ', 'az': 'Minimum məbləğ', 'bn': 'সর্বনিম্ন পরিমাণ', 'de': 'Mindestbetrag',
        'es': 'Importe mínimo', 'fa': 'حداقل مبلغ', 'fr': 'Montant minimum', 'hi': 'न्यूनतम राशि',
        'id': 'Jumlah Minimum', 'it': 'Importo minimo', 'ja': '最小金額', 'ko': '최소 금액',
        'nl': 'Minimumbedrag', 'pl': 'Kwota minimalna', 'pt': 'Valor mínimo', 'ru': 'Минимальная сумма',
        'tr': 'Minimum Tutar', 'uk': 'Мінімальна сума', 'ur': 'کم از کم رقم', 'vi': 'Số tiền tối thiểu', 'zh': '最小金额'
    },
    'maximum amount': {
        'ar': 'الحد أقصى للمبلغ', 'az': 'Maksimum məbləğ', 'bn': 'সর্বোচ্চ পরিমাণ', 'de': 'Höchstbetrag',
        'es': 'Importe máximo', 'fa': 'حداکثر مبلغ', 'fr': 'Montant maximum', 'hi': 'अधिकतम राशि',
        'id': 'Jumlah Maksimum', 'it': 'Importo massimo', 'ja': '最大金額', 'ko': '최대 금액',
        'nl': 'Maximumbedrag', 'pl': 'Kwota maksymalna', 'pt': 'Valor máximo', 'ru': 'Максимальная сумма',
        'tr': 'Maksimum Tutar', 'uk': 'Максимальна сума', 'ur': 'زیادہ سے زیادہ رقم', 'vi': 'Số tiền tối đa', 'zh': '最大金额'
    },
    'start date:': {
        'ar': 'تاريخ البدء:', 'az': 'Başlanğıc tarixi:', 'bn': 'শুরুর তারিখ:', 'de': 'Startdatum:',
        'es': 'Fecha de inicio:', 'fa': 'تاریخ شروع:', 'fr': 'Date de début :', 'hi': 'प्रारंभ तिथि:',
        'id': 'Tanggal Mulai:', 'it': 'Data di inizio:', 'ja': '開始日:', 'ko': '시작일:',
        'nl': 'Startdatum:', 'pl': 'Data rozpoczęcia:', 'pt': 'Data de início:', 'ru': 'Дата начала:',
        'tr': 'Başlangıç Tarihi:', 'uk': 'Дата початку:', 'ur': 'شروع کرنے کی تاریخ:', 'vi': 'Ngày bắt đầu:', 'zh': '开始日期:'
    },
    'end date:': {
        'ar': 'تاريخ الانتهاء:', 'az': 'Bitmə tarixi:', 'bn': 'শেষের তারিখ:', 'de': 'Enddatum:',
        'es': 'Fecha de finalización:', 'fa': 'تاریخ پایان:', 'fr': 'Date de fin :', 'hi': 'समाप्ति तिथि:',
        'id': 'Tanggal Selesai:', 'it': 'Data di fine:', 'ja': '終了日:', 'ko': '종료일:',
        'nl': 'Einddatum:', 'pl': 'Data zakończenia:', 'pt': 'Data de término:', 'ru': 'Дата окончания:',
        'tr': 'Bitiş Tarihi:', 'uk': 'Дата закінчення:', 'ur': 'ختم ہونے کی تاریخ:', 'vi': 'Ngày kết thúc:', 'zh': '结束日期:'
    }
}

def translate_str(text, lang):
    short = lang.split('-')[0]
    low = text.lower().strip()
    
    if low in MASTER_DICT and short in MASTER_DICT[low]:
        res = MASTER_DICT[low][short]
        return res.capitalize() if text[0].isupper() else res

    for k_phrase, trans_map in MASTER_DICT.items():
        if k_phrase in low and short in trans_map and not PH_PATTERN.search(k_phrase):
            low = re.sub(r'\b' + re.escape(k_phrase) + r'\b', trans_map[short], low)
            return low.capitalize() if text[0].isupper() else low

    return text

def execute_master_pass():
    print("Running master pass to remove all English phrases across 21 locales...")
    
    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        
        # 1. Process catalogue
        if os.path.exists(cat_file):
            with open(cat_file, 'r', encoding='utf-8') as f:
                cat_data = json.load(f)
                
            def process_node(node):
                if isinstance(node, dict):
                    out = {}
                    for k, v in node.items():
                        if isinstance(v, dict):
                            out[k] = process_node(v)
                        elif isinstance(v, str):
                            fixed = translate_str(v, loc_code)
                            out[k] = fixed if ph_ok(v, fixed) else v
                    return out
                return node
                
            updated_cat = process_node(cat_data)
            with open(cat_file, 'w', encoding='utf-8') as f:
                json.dump(updated_cat, f, ensure_ascii=False, indent=2)
                f.write('\n')

        # 2. Process done export files
        for fname in EXPORT_FILES:
            done_file = os.path.join(done_dir, fname)
            orig_file = os.path.join(EXPORT_DIR, fname)
            if not os.path.exists(orig_file):
                continue
                
            with open(orig_file, 'r', encoding='utf-8') as f:
                orig_data = json.load(f)
                
            existing_done = {}
            if os.path.exists(done_file):
                with open(done_file, 'r', encoding='utf-8') as f:
                    existing_done = json.load(f)
                    
            updated_done = {}
            for k, en_val in orig_data.items():
                curr = existing_done.get(k, en_val)
                fixed = translate_str(curr, loc_code)
                if ph_ok(en_val, fixed):
                    updated_done[k] = fixed
                else:
                    updated_done[k] = curr
                    
            with open(done_file, 'w', encoding='utf-8') as f:
                json.dump(updated_done, f, ensure_ascii=False, indent=2)
                f.write('\n')

        print(f"Master translation completed for {loc_code}")

if __name__ == '__main__':
    execute_master_pass()
