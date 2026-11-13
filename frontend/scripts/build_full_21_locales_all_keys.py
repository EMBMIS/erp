#!/usr/bin/env python3
"""
Complete Translation Dictionary Populator for all 21 Locales.
Replaces all remaining English navigation/UI keys across all 21 languages.
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

def ph_ok(orig, trans):
    return sorted(PH_PATTERN.findall(str(orig))) == sorted(PH_PATTERN.findall(str(trans)))

# Complete translation dictionary for all remaining navigation, finance, sales, procurement, CRM, HR keys
KEY_MAPS = {
    'supplierInvoices': {
        'ar': 'فواتير الموردين', 'az': 'Təchizatçı hesab-fakturaları', 'bn': 'সরবরাহকারী রসিদ', 'de': 'Lieferantenrechnungen',
        'es': 'Facturas de proveedores', 'fa': 'فاکتورهای تامین‌کنندگان', 'fr': 'Factures fournisseurs', 'hi': 'आपूर्तिकर्ता चालान',
        'id': 'Faktur Pemasok', 'it': 'Fatture fornitori', 'ja': '仕入先請求書', 'ko': '공급업체 송장',
        'nl': 'Inkoopfacturen', 'pl': 'Faktury dostawców', 'pt': 'Faturas de fornecedores', 'ru': 'Счета поставщиков',
        'tr': 'Tedarikçi Faturaları', 'uk': 'Рахунки постачальників', 'ur': 'سپلائر انوائس', 'vi': 'Hóa đơn nhà cung cấp', 'zh': '供应商发票'
    },
    'invoiceIntakeAi': {
        'ar': 'معالجة الفواتير بالذكاء الاصطناعي', 'az': 'AI ilə hesab-faktura daxilolması', 'bn': 'এআই দ্বারা ইনভয়েস গ্রহণ', 'de': 'Rechnungseingang (KI)',
        'es': 'Recepción de facturas con IA', 'fa': 'ورودی فاکتور با هوش مصنوعی', 'fr': 'Saisie des factures par IA', 'hi': 'एआई द्वारा चालान प्रविष्टि',
        'id': 'Penerimaan Faktur (AI)', 'it': 'Acquisizione fatture (IA)', 'ja': 'AI請求書取り込み', 'ko': 'AI 송장 접수',
        'nl': 'Factuurverwerking (AI)', 'pl': 'Rejestracja faktur (AI)', 'pt': 'Entrada de faturas com IA', 'ru': 'Ввод счетов (ИИ)',
        'tr': 'AI Fatura Girişi', 'uk': 'Введення рахунків (ШІ)', 'ur': 'اے آئی سے انوائس پروسیسنگ', 'vi': 'Nhập hóa đơn AI', 'zh': 'AI 发票录入'
    },
    'supplierPayments': {
        'ar': 'مدفوعات الموردين', 'az': 'Təchizatçı ödənişləri', 'bn': 'সরবরাহকারীর অর্থ প্রদান', 'de': 'Lieferantenzahlungen',
        'es': 'Pagos a proveedores', 'fa': 'پرداخت‌های تامین‌کنندگان', 'fr': 'Paiements fournisseurs', 'hi': 'आपूर्तिकर्ता भुगतान',
        'id': 'Pembayaran Pemasok', 'it': 'Pagamenti fornitori', 'ja': '仕入先支払', 'ko': '공급업체 지급',
        'nl': 'Leveranciersbetalingen', 'pl': 'Płatności dla dostawców', 'pt': 'Pagamentos a fornecedores', 'ru': 'Оплаты поставщикам',
        'tr': 'Tedarikçi Ödemeleri', 'uk': 'Оплати постачальникам', 'ur': 'سپلائر کی ادائیگیاں', 'vi': 'Thanh toán nhà cung cấp', 'zh': '供应商付款'
    },
    'trialBalance': {
        'ar': 'ميزان المراجعة', 'az': 'Sınaq balansı', 'bn': 'রেওয়ামিল', 'de': 'Summen- und Saldenliste',
        'es': 'Balance de comprobación', 'fa': 'تراز آزمایشی', 'fr': 'Balance de vérification', 'hi': 'तलपट',
        'id': 'Neraca Saldo', 'it': 'Bilancio di verifica', 'ja': '合計試算表', 'ko': '합계잔액시산표',
        'nl': 'Proef- en saldibalans', 'pl': 'Zestawienie obrotów i sald', 'pt': 'Balancete de verificação', 'ru': 'Оборотно-сальдовая ведомость',
        'tr': 'Mizan', 'uk': 'Оборотно-сальдова відомість', 'ur': 'ٹرائل بیلنس', 'vi': 'Bảng cân đối số phát sinh', 'zh': '科目余额表'
    },
    'balanceSheet': {
        'ar': 'الميزانية العمومية', 'az': 'Balans hesabatı', 'bn': 'উদ্বৃত্তপত্র', 'de': 'Bilanz',
        'es': 'Balance general', 'fa': 'ترازنامه', 'fr': 'Bilan comptable', 'hi': 'तुलन पत्र',
        'id': 'Neraca', 'it': 'Stato patrimoniale', 'ja': '貸借対照表', 'ko': '재무상태표',
        'nl': 'Balans', 'pl': 'Bilans', 'pt': 'Balanço patrimonial', 'ru': 'Бухгалтерский баланс',
        'tr': 'Bilanço', 'uk': 'Бухгалтерський баланс', 'ur': 'بیلنس شیٹ', 'vi': 'Bảng cân đối kế toán', 'zh': '资产负债表'
    },
    'customerInvoices': {
        'ar': 'فواتير العملاء', 'az': 'Müştəri hesab-fakturaları', 'bn': 'গ্রাহক রসিদ', 'de': 'Kundenrechnungen',
        'es': 'Facturas de clientes', 'fa': 'فاکتورهای مشتریان', 'fr': 'Factures clients', 'hi': 'ग्राहक चालान',
        'id': 'Faktur Pelanggan', 'it': 'Fatture clienti', 'ja': '得意先請求書', 'ko': '고객 송장',
        'nl': 'Verkoopfacturen', 'pl': 'Faktury dla klientów', 'pt': 'Faturas de clientes', 'ru': 'Счета покупателям',
        'tr': 'Müşteri Faturaları', 'uk': 'Рахунки покупцям', 'ur': 'کسٹمر انوائس', 'vi': 'Hóa đơn khách hàng', 'zh': '客户发票'
    },
    'customerPayments': {
        'ar': 'مدفوعات العملاء', 'az': 'Müştəri ödənişləri', 'bn': 'গ্রাহকের অর্থ প্রদান', 'de': 'Kundenzahlungen',
        'es': 'Pagos de clientes', 'fa': 'پرداخت‌های مشتریان', 'fr': 'Paiements clients', 'hi': 'ग्राहक भुगतान',
        'id': 'Pembayaran Pelanggan', 'it': 'Incassi clienti', 'ja': '得意先入金', 'ko': '고객 수금',
        'nl': 'Klantbetalingen', 'pl': 'Płatności od klientów', 'pt': 'Pagamentos de clientes', 'ru': 'Оплаты от покупателей',
        'tr': 'Müşteri Tahsilatları', 'uk': 'Оплати від покупців', 'ur': 'کسٹمر کی ادائیگیاں', 'vi': 'Thanh toán của khách hàng', 'zh': '客户付款'
    },
    'vatReport': {
        'ar': 'تقرير ضريبة القيمة المضافة', 'az': 'ƏDV hesabatı', 'bn': 'ভ্যাট রিপোর্ট', 'de': 'Umsatzsteuermeldung',
        'es': 'Informe de IVA', 'fa': 'گزارش مالیات بر ارزش افزوده', 'fr': 'Rapport de TVA', 'hi': 'वैट रिपोर्ट',
        'id': 'Laporan PPN', 'it': 'Report IVA', 'ja': '消費税レポート', 'ko': '부가세 보고서',
        'nl': 'Btw-rapportage', 'pl': 'Raport VAT', 'pt': 'Relatório de IVA', 'ru': 'Отчет по НДС',
        'tr': 'KDV Raporu', 'uk': 'Звіт з ПДВ', 'ur': 'ویٹ رپورٹ', 'vi': 'Báo cáo thuế GTGT', 'zh': '增值税报表'
    },
    'fixedAssets': {
        'ar': 'الأصول الثابتة', 'az': 'Əsas vəsaitlər', 'bn': 'স্থায়ী সম্পদ', 'de': 'Anlagevermögen',
        'es': 'Activos fijos', 'fa': 'دارایی‌های ثابت', 'fr': 'Immobilisations', 'hi': 'अचल संपत्ति',
        'id': 'Aset Tetap', 'it': 'Immobilizzazioni', 'ja': '固定資産', 'ko': '고정 자산',
        'nl': 'Vaste activa', 'pl': 'Środki trwałe', 'pt': 'Ativos fixos', 'ru': 'Основные средства',
        'tr': 'Maddi Duran Varlıklar', 'uk': 'Основні засоби', 'ur': 'مستقل اثاثے', 'vi': 'Tài sản cố định', 'zh': '固定资产'
    },
    'costCenters': {
        'ar': 'مراكز التكلفة', 'az': 'Məsrəf mərkəzləri', 'bn': 'খরচ কেন্দ্র', 'de': 'Kostenstellen',
        'es': 'Centros de costes', 'fa': 'مراکز هزینه', 'fr': 'Centres de coûts', 'hi': 'लागत केंद्र',
        'id': 'Pusat Biaya', 'it': 'Centri di costo', 'ja': '原価中心', 'ko': '코스트 센터',
        'nl': 'Kostenplaatsen', 'pl': 'Miejsca powstawania kosztów', 'pt': 'Centros de custo', 'ru': 'Центры затрат',
        'tr': 'Masraf Merkezleri', 'uk': 'Центри витрат', 'ur': 'کاسٹ سینٹرز', 'vi': 'Trung tâm chi phí', 'zh': '成本中心'
    },
    'budgets': {
        'ar': 'الميزانيات التقديرية', 'az': 'Büdcələr', 'bn': 'বাজেট', 'de': 'Budgets',
        'es': 'Presupuestos', 'fa': 'بودجه‌ها', 'fr': 'Budgets', 'hi': 'बजट',
        'id': 'Anggaran', 'it': 'Budget', 'ja': '予算', 'ko': '예산',
        'nl': 'Budgetten', 'pl': 'Budżety', 'pt': 'Orçamentos', 'ru': 'Бюджеты',
        'tr': 'Bütçeler', 'uk': 'Бюджети', 'ur': 'بجٹ', 'vi': 'Ngân sách', 'zh': '预算'
    },
    'accountingPeriods': {
        'ar': 'الفترات المحاسبية', 'az': 'Maliyyə dövrü', 'bn': 'হিসাবরক্ষণ সময়কাল', 'de': 'Buchungsperioden',
        'es': 'Períodos contables', 'fa': 'دوره‌های مالی', 'fr': 'Périodes comptables', 'hi': 'लेखांकन अवधि',
        'id': 'Periode Akuntansi', 'it': 'Periodi contabili', 'ja': '会計期間', 'ko': '회계 기간',
        'nl': 'Boekhoudperioden', 'pl': 'Okresy obrachunkowe', 'pt': 'Períodos contábeis', 'ru': 'Отчетные периоды',
        'tr': 'Muhasebe Dönemleri', 'uk': 'Облікові періоди', 'ur': 'اکاؤنٹنگ ادوار', 'vi': 'Kỳ kế toán', 'zh': '会计期间'
    },
    'quantity': {
        'ar': 'الكمية:', 'az': 'Miqdar:', 'bn': 'পরিমাণ:', 'de': 'Menge:',
        'es': 'Cantidad:', 'fa': 'تعداد:', 'fr': 'Quantité :', 'hi': 'मात्रा:',
        'id': 'Jumlah:', 'it': 'Quantità:', 'ja': '数量:', 'ko': '수량:',
        'nl': 'Aantal:', 'pl': 'Ilość:', 'pt': 'Quantidade:', 'ru': 'Количество:',
        'tr': 'Miktar:', 'uk': 'Кількість:', 'ur': 'مقدار:', 'vi': 'Số lượng:', 'zh': '数量:'
    },
    'unitPrice': {
        'ar': 'سعر الوحدة:', 'az': 'Vahid qiyməti:', 'bn': 'একক মূল্য:', 'de': 'Einzelpreis:',
        'es': 'Precio unitario:', 'fa': 'قیمت واحد:', 'fr': 'Prix unitaire :', 'hi': 'इकाई मूल्य:',
        'id': 'Harga Satuan:', 'it': 'Prezzo unitario:', 'ja': '単価:', 'ko': '단가:',
        'nl': 'Stukprijs:', 'pl': 'Cena jednostkowa:', 'pt': 'Preço unitário:', 'ru': 'Цена за единицу:',
        'tr': 'Birim Fiyat:', 'uk': 'Ціна за одиницю:', 'ur': 'فی اکائی قیمت:', 'vi': 'Đơn giá:', 'zh': '单价:'
    },
    'doaContractApprovalRequired': {
        'ar': 'موافقة تفويض السلطة مطلوبة للعقد', 'az': 'DoA müqavilə təsdiqi tələb olunur', 'bn': 'চুক্তি অনুমোদন প্রয়োজন (DoA)', 'de': 'DoA-Vertragsgenehmigung erforderlich',
        'es': 'Aprobación de contrato DoA requerida', 'fa': 'تایید قرارداد طبق تفویض اختیارات الزامی است', 'fr': 'Approbation de contrat DoA requise', 'hi': 'डीओए अनुबंध स्वीकृति आवश्यक',
        'id': 'Persetujuan Kontrak DoA Diperlukan', 'it': 'Approvazione contratto DoA richiesta', 'ja': 'DoA 契約承認が必要です', 'ko': 'DoA 계약 승인이 필요합니다',
        'nl': 'DoA-contractgoedkeuring vereist', 'pl': 'Wymagane zatwierdzenie umowy zgodnie z DoA', 'pt': 'Aprovação de contrato DoA necessária', 'ru': 'Требуется согласование договора по DoA',
        'tr': 'DoA Sözleşme Onayı Gereklidir', 'uk': 'Потрібне підтвердження договору за DoA', 'ur': 'ڈی او اے معاہدے کی منظوری درکار ہے', 'vi': 'Yêu cầu phê duyệt hợp đồng DoA', 'zh': '需要 DoA 合同审批'
    },
    'doaApprovalRequired': {
        'ar': 'موافقة تفويض السلطة مطلوبة', 'az': 'DoA təsdiqi tələb olunur', 'bn': 'অনুমোদন প্রয়োজন (DoA)', 'de': 'DoA-Genehmigung erforderlich',
        'es': 'Aprobación DoA requerida', 'fa': 'تایید طبق تفویض اختیارات الزامی است', 'fr': 'Approbation DoA requise', 'hi': 'डीओए स्वीकृति आवश्यक',
        'id': 'Persetujuan DoA Diperlukan', 'it': 'Approvazione DoA richiesta', 'ja': 'DoA 承認が必要です', 'ko': 'DoA 승인이 필요합니다',
        'nl': 'DoA-goedkeuring vereist', 'pl': 'Wymagane zatwierdzenie DoA', 'pt': 'Aprovação DoA necessária', 'ru': 'Требуется согласование по DoA',
        'tr': 'DoA Onayı Gereklidir', 'uk': 'Потрібне підтвердження за DoA', 'ur': 'ڈی او اے منظوری درکار ہے', 'vi': 'Yêu cầu phê duyệt DoA', 'zh': '需要 DoA 审批'
    },
    'noLimit': {
        'ar': 'لا يوجد حد', 'az': 'Limit yoxdur', 'bn': 'সীমা নেই', 'de': 'Kein Limit',
        'es': 'Sin límite', 'fa': 'بدون محدودیت', 'fr': 'Sans limite', 'hi': 'कोई सीमा नहीं',
        'id': 'Tanpa Batas', 'it': 'Senza limite', 'ja': '上限なし', 'ko': '제한 없음',
        'nl': 'Geen limiet', 'pl': 'Brak limitu', 'pt': 'Sem limite', 'ru': 'Без ограничений',
        'tr': 'Limit Yok', 'uk': 'Без обмежень', 'ur': 'کوئی حد نہیں', 'vi': 'Không giới hạn', 'zh': '无限制'
    }
}

def apply_full_translations():
    print("Applying full translation coverage across all 21 locales...")

    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        
        # 1. Update catalogue JSON
        if os.path.exists(cat_file):
            with open(cat_file, 'r', encoding='utf-8') as f:
                cat_tree = json.load(f)
                
            def process_node(node, prefix=''):
                if isinstance(node, dict):
                    res = {}
                    for k, v in node.items():
                        fk = f"{prefix}.{k}" if prefix else k
                        if isinstance(v, dict):
                            res[k] = process_node(v, fk)
                        elif isinstance(v, str):
                            k_base = k
                            if k_base in KEY_MAPS and short in KEY_MAPS[k_base]:
                                trans = KEY_MAPS[k_base][short]
                                res[k] = trans if ph_ok(v, trans) else v
                            else:
                                res[k] = v
                    return res
                return node
                
            updated_cat = process_node(cat_tree)
            with open(cat_file, 'w', encoding='utf-8') as f:
                json.dump(updated_cat, f, ensure_ascii=False, indent=2)
                f.write('\n')

        # 2. Update all 13 export files
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
                k_base = k.split('.')[-1]
                if k_base in KEY_MAPS and short in KEY_MAPS[k_base]:
                    trans = KEY_MAPS[k_base][short]
                    updated_done[k] = trans if ph_ok(en_val, trans) else existing_done.get(k, en_val)
                else:
                    updated_done[k] = existing_done.get(k, en_val)
                    
            with open(done_file, 'w', encoding='utf-8') as f:
                json.dump(updated_done, f, ensure_ascii=False, indent=2)
                f.write('\n')

        print(f"Catalogue and export files updated for {loc_code}")

if __name__ == '__main__':
    apply_full_translations()
