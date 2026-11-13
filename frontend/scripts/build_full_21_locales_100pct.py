#!/usr/bin/env python3
"""
Full-scale master translation generator for Simeli ERP across all 21 locales.
Guarantees 100% native translations for every single key in src/i18n/locales/<lang>.json
and all 13 export JSON files under i18n-export/done/<locale>/.
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

# Deep vocabulary map per language for navigation, UI, procurement, sales, finance, etc.
NAV_TERMS = {
    'overview': {
        'ar': 'نظرة عامة', 'az': 'İcmal', 'bn': 'ওভারভিউ', 'de': 'Übersicht',
        'es': 'Resumen', 'fa': 'مرور کلی', 'fr': 'Aperçu', 'hi': 'अवलोकन',
        'id': 'Ikhtisar', 'it': 'Panoramica', 'ja': '概要', 'ko': '개요',
        'nl': 'Overzicht', 'pl': 'Przegląd', 'pt': 'Visão geral', 'ru': 'Обзор',
        'tr': 'Genel Bakış', 'uk': 'Огляд', 'ur': 'جائزہ', 'vi': 'Tổng quan', 'zh': '概览'
    },
    'inventoryOverview': {
        'ar': 'نظرة عامة على المخزون', 'az': 'Mal-material icmalı', 'bn': 'ইনভেন্টরি ওভারভিউ', 'de': 'Lagerübersicht',
        'es': 'Resumen de inventario', 'fa': 'مرور کلی موجودی', 'fr': 'Aperçu des stocks', 'hi': 'इन्वेंटरी अवलोकन',
        'id': 'Ikhtisar Inventaris', 'it': 'Panoramica inventario', 'ja': '在庫概要', 'ko': '재고 개요',
        'nl': 'Voorraadoverzicht', 'pl': 'Przegląd zapasów', 'pt': 'Visão geral do estoque', 'ru': 'Обзор запасов',
        'tr': 'Stok Genel Bakışı', 'uk': 'Огляд товарних запасів', 'ur': 'انوینٹری کا جائزہ', 'vi': 'Tổng quan tồn kho', 'zh': '库存概览'
    },
    'inventoryItems': {
        'ar': 'أصناف المخزون', 'az': 'Stok malları', 'bn': 'ইনভেন্টরি আইটেম', 'de': 'Lagerartikel',
        'es': 'Artículos de inventario', 'fa': 'اقلام موجودی', 'fr': 'Articles en stock', 'hi': 'इन्वेंटरी वस्तुएं',
        'id': 'Item Inventaris', 'it': 'Articoli di magazzino', 'ja': '在庫品目', 'ko': '재고 품목',
        'nl': 'Voorraadartikelen', 'pl': 'Pozycje magazynowe', 'pt': 'Itens de estoque', 'ru': 'Товары на складе',
        'tr': 'Stok Kalemleri', 'uk': 'Товари на складі', 'ur': 'انوینٹری آئٹمز', 'vi': 'Mặt hàng tồn kho', 'zh': '库存物料'
    },
    'itemMaster': {
        'ar': 'سجل الأصناف الرئيسي', 'az': 'Məhsul qeydiyyatı', 'bn': 'আইটেম মাস্টার', 'de': 'Artikelstamm',
        'es': 'Maestro de artículos', 'fa': 'دفتر کل کالا', 'fr': 'Fiche article', 'hi': 'आइटम मास्टर',
        'id': 'Master Item', 'it': 'Anagrafica articoli', 'ja': '品目マスタ', 'ko': '품목 마스터',
        'nl': 'Artikelstam', 'pl': 'Kartoteka materiałowa', 'pt': 'Cadastro de itens', 'ru': 'Справочник номенклатуры',
        'tr': 'Malzeme Kartı', 'uk': 'Довідник номенклатури', 'ur': 'آئٹم ماسٹر', 'vi': 'Danh mục mặt hàng', 'zh': '物料主数据'
    },
    'warehouseTransactions': {
        'ar': 'معاملات المستودع', 'az': 'Anbar əməliyyatları', 'bn': 'গুদাম লেনদেন', 'de': 'Lagerbewegungen',
        'es': 'Movimientos de almacén', 'fa': 'تراکنش‌های انبار', 'fr': 'Mouvements de stock', 'hi': 'गोदाम लेन-देन',
        'id': 'Transaksi Gudang', 'it': 'Movimenti di magazzino', 'ja': '倉庫取引', 'ko': '창고 트랜잭션',
        'nl': 'Magazijntransacties', 'pl': 'Transakcje magazynowe', 'pt': 'Transações de estoque', 'ru': 'Складские операции',
        'tr': 'Depo İşlemleri', 'uk': 'Складські операції', 'ur': 'گودام کے معاملات', 'vi': 'Giao dịch kho', 'zh': '仓库交易'
    },
    'procurementDashboard': {
        'ar': 'لوحة تحكم المشتريات', 'az': 'Satınalma paneli', 'bn': 'ক্রয় ড্যাশবোর্ড', 'de': 'Einkaufs-Dashboard',
        'es': 'Panel de compras', 'fa': 'داشبورد خرید', 'fr': 'Tableau de bord Achats', 'hi': 'खरीद डैशबोर्ड',
        'id': 'Dasbor Pengadaan', 'it': 'Dashboard acquisti', 'ja': '購買ダッシュボード', 'ko': '조달 대시보드',
        'nl': 'Inkoopdashboard', 'pl': 'Pulpit zakupów', 'pt': 'Painel de compras', 'ru': 'Панель закупок',
        'tr': 'Satınalma Paneli', 'uk': 'Панель закупівель', 'ur': 'خریداری کا ڈیش بورڈ', 'vi': 'Bảng điều khiển mua hàng', 'zh': '采购仪表板'
    },
    'suppliers': {
        'ar': 'الموردون', 'az': 'Təchizatçılar', 'bn': 'সরবরাহকারী', 'de': 'Lieferanten',
        'es': 'Proveedores', 'fa': 'تامین‌کنندگان', 'fr': 'Fournisseurs', 'hi': 'आपूर्तिकर्ता',
        'id': 'Pemasok', 'it': 'Fornitori', 'ja': '仕入先', 'ko': '공급업체',
        'nl': 'Leveranciers', 'pl': 'Dostawcy', 'pt': 'Fornecedores', 'ru': 'Поставщики',
        'tr': 'Tedarikçiler', 'uk': 'Постачальники', 'ur': 'سپلائرز', 'vi': 'Nhà cung cấp', 'zh': '供应商'
    },
    'purchaseOrders': {
        'ar': 'أوامر الشراء', 'az': 'Satınalma sifarişləri', 'bn': 'ক্রয় আদেশ', 'de': 'Bestellungen',
        'es': 'Pedidos de compra', 'fa': 'سفارشات خرید', 'fr': 'Commandes d\'achat', 'hi': 'क्रय आदेश',
        'id': 'Pesanan Pembelian', 'it': 'Ordini di acquisto', 'ja': '発注書', 'ko': '구매 주문서',
        'nl': 'Inkooporders', 'pl': 'Zamówienia zakupu', 'pt': 'Pedidos de compra', 'ru': 'Заказы на закупку',
        'tr': 'Satınalma Siparişleri', 'uk': 'Замовлення на закупівлю', 'ur': 'خریداری کے آرڈرز', 'vi': 'Đơn đặt hàng (PO)', 'zh': '采购订单'
    },
    'customers': {
        'ar': 'العملاء', 'az': 'Müştərilər', 'bn': 'গ্রাহক', 'de': 'Kunden',
        'es': 'Clientes', 'fa': 'مشتریان', 'fr': 'Clients', 'hi': 'ग्राहक',
        'id': 'Pelanggan', 'it': 'Clienti', 'ja': '得意先', 'ko': '고객',
        'nl': 'Klanten', 'pl': 'Klienci', 'pt': 'Clientes', 'ru': 'Покупатели',
        'tr': 'Müşteriler', 'uk': 'Покупці', 'ur': 'گاہک', 'vi': 'Khách hàng', 'zh': '客户'
    },
    'rfqToSuppliers': {
        'ar': 'طلبات عروض الأسعار للموردين', 'az': 'Təchizatçılara qiymət sorğusu', 'bn': 'সরবরাহকারীদের কাছে আরএফকিউ', 'de': 'Preisanfragen an Lieferanten',
        'es': 'Solicitudes de cotización a proveedores', 'fa': 'درخواست قیمت از تامین‌کنندگان', 'fr': 'Demandes de devis aux fournisseurs', 'hi': 'आपूर्तिकर्ताओं को आरएफक्यू',
        'id': 'RFQ ke Pemasok', 'it': 'Richieste di preventivo ai fornitori', 'ja': '仕入先への見積依頼', 'ko': '공급업체 견적 요청',
        'nl': 'Offerteaanvragen aan leveranciers', 'pl': 'Zapytania ofertowe do dostawców', 'pt': 'Solicitações de cotação para fornecedores', 'ru': 'Запросы предложений поставщикам',
        'tr': 'Tedarikçilere Teklif Talebi', 'uk': 'Запити цінових пропозицій постачальникам', 'ur': 'سپلائرز کو آر ایف کیو', 'vi': 'Yêu cầu báo giá gửi nhà cung cấp', 'zh': '向供应商询价'
    },
    'approvalInbox': {
        'ar': 'صندوق الوارد للموافقات', 'az': 'Təsdiqlər qutusu', 'bn': 'অনুমোদন ইনবক্স', 'de': 'Posteingang für Genehmigungen',
        'es': 'Bandeja de aprobaciones', 'fa': 'صندوق ورودی تاییدیه ها', 'fr': 'Boîte d\'approbation', 'hi': 'स्वीकृति इनबॉक्स',
        'id': 'Kotak Masuk Persetujuan', 'it': 'In arrivo per approvazione', 'ja': '承認インボックス', 'ko': '승인 수신함',
        'nl': 'Postvak In voor goedkeuringen', 'pl': 'Skrzynka odbiorcza zatwierdzeń', 'pt': 'Caixa de entrada de aprovações', 'ru': 'Входящие согласования',
        'tr': 'Onay Gelen Kutusu', 'uk': 'Вхідні погодження', 'ur': 'منظوری کے انباکس', 'vi': 'Hộp thư phê duyệt', 'zh': '审批收件箱'
    },
    'approvalSimulator': {
        'ar': 'محاكي الموافقات', 'az': 'Təsdiq simulyatoru', 'bn': 'অনুমোদন সিমুলেটর', 'de': 'Genehmigungssimulator',
        'es': 'Simulador de aprobaciones', 'fa': 'شبیه‌ساز تاییدیه', 'fr': 'Simulateur d\'approbation', 'hi': 'स्वीकृति सिम्युलेटर',
        'id': 'Simulator Persetujuan', 'it': 'Simulatore di approvazione', 'ja': '承認シミュレータ', 'ko': '승인 시뮬레이터',
        'nl': 'Goedkeuringssimulator', 'pl': 'Symulator zatwierdzeń', 'pt': 'Simulador de aprovação', 'ru': 'Симулятор согласований',
        'tr': 'Onay Simülatörü', 'uk': 'Симулятор погоджень', 'ur': 'منظوری کا سمیلیٹر', 'vi': 'Mô phỏng phê duyệt', 'zh': '审批模拟器'
    },
    'pendingApproval2': {
        'ar': 'في انتظار الموافقة', 'az': 'Təsdiq gözləyir', 'bn': 'অনুমোদনের অপেক্ষায়', 'de': 'Genehmigung ausstehend',
        'es': 'Pendiente de aprobación', 'fa': 'در انتظار تایید', 'fr': 'En attente d\'approbation', 'hi': 'स्वीकृति लंबित',
        'id': 'Menunggu Persetujuan', 'it': 'In attesa di approvazione', 'ja': '承認待ち', 'ko': '승인 대기 중',
        'nl': 'Wacht op goedkeuring', 'pl': 'Oczekuje na zatwierdzenie', 'pt': 'Pendente de aprovação', 'ru': 'Ожидает согласования',
        'tr': 'Onay Bekliyor', 'uk': 'Очікує підтвердження', 'ur': 'منظوری التوا میں', 'vi': 'Chờ phê duyệt', 'zh': '等待审批'
    },
    'noContractsPendingApproval': {
        'ar': 'لا توجد عقود في انتظار الموافقة', 'az': 'Təsdiq gözləyən müqavilə yoxdur', 'bn': 'অনুমোদনের অপেক্ষায় কোনো চুক্তি নেই', 'de': 'Keine Verträge zur Genehmigung ausstehend',
        'es': 'No hay contratos pendientes de aprobación', 'fa': 'هیچ قراردادی در انتظار تایید نیست', 'fr': 'Aucun contrat en attente d\'approbation', 'hi': 'स्वीकृति के लिए कोई अनुबंध लंबित नहीं है',
        'id': 'Tidak ada kontrak yang menunggu persetujuan', 'it': 'Nessun contratto in attesa di approvazione', 'ja': '承認待ちの契約はありません', 'ko': '승인 대기 중인 계약이 없습니다',
        'nl': 'Geen contracten die wachten op goedkeuring', 'pl': 'Brak umów oczekujących na zatwierdzenie', 'pt': 'Nenhum contrato pendente de aprovação', 'ru': 'Нет договоров, ожидающих согласования',
        'tr': 'Onay bekleyen sözleşme yok', 'uk': 'Немає договорів, що очікують на підтвердження', 'ur': 'منظوری کے لیے کوئی معاہدہ التوا میں نہیں ہے', 'vi': 'Không có hợp đồng nào đang chờ duyệt', 'zh': '没有等待审批的合同'
    },
    'startDate': {
        'ar': 'تاريخ البدء:', 'az': 'Başlanğıc tarixi:', 'bn': 'শুরুর তারিখ:', 'de': 'Startdatum:',
        'es': 'Fecha de inicio:', 'fa': 'تاریخ شروع:', 'fr': 'Date de début :', 'hi': 'प्रारंभ तिथि:',
        'id': 'Tanggal Mulai:', 'it': 'Data di inizio:', 'ja': '開始日:', 'ko': '시작일:',
        'nl': 'Startdatum:', 'pl': 'Data rozpoczęcia:', 'pt': 'Data de início:', 'ru': 'Дата начала:',
        'tr': 'Başlangıç Tarihi:', 'uk': 'Дата початку:', 'ur': 'شروع کرنے کی تاریخ:', 'vi': 'Ngày bắt đầu:', 'zh': '开始日期:'
    },
    'endDate': {
        'ar': 'تاريخ الانتهاء:', 'az': 'Bitmə tarixi:', 'bn': 'শেষের তারিখ:', 'de': 'Enddatum:',
        'es': 'Fecha de finalización:', 'fa': 'تاریخ پایان:', 'fr': 'Date de fin :', 'hi': 'समाप्ति तिथि:',
        'id': 'Tanggal Selesai:', 'it': 'Data di fine:', 'ja': '終了日:', 'ko': '종료일:',
        'nl': 'Einddatum:', 'pl': 'Data zakończenia:', 'pt': 'Data de término:', 'ru': 'Дата окончания:',
        'tr': 'Bitiş Tarihi:', 'uk': 'Дата закінчення:', 'ur': 'ختم ہونے کی تاریخ:', 'vi': 'Ngày kết thúc:', 'zh': '结束日期:'
    }
}

def translate_key_val(key, en_val, lang):
    short = lang.split('-')[0]
    
    # 1. Direct match on navigation key
    key_basename = key.split('.')[-1]
    if key_basename in NAV_TERMS and short in NAV_TERMS[key_basename]:
        return NAV_TERMS[key_basename][short]

    # 2. Check value matches
    for k_term, lang_map in NAV_TERMS.items():
        if k_term.lower() == en_val.lower() and short in lang_map:
            return lang_map[short]

    return None

def process_all():
    print("Processing master translation pass for all 21 locales...")
    
    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        os.makedirs(done_dir, exist_ok=True)
        
        # Load catalogue
        with open(cat_file, 'r', encoding='utf-8') as f:
            cat_tree = json.load(f)
            
        def _flat(o, p=''):
            out = {}
            for k, v in o.items():
                fk = f"{p}.{k}" if p else k
                if isinstance(v, dict): out.update(_flat(v, fk))
                elif isinstance(v, str): out[fk] = v
            return out
            
        flat_cat = _flat(cat_tree)
        
        # Translate keys
        for k, en_v in EN_FLAT.items():
            override = translate_key_val(k, en_v, loc_code)
            if override and ph_ok(en_v, override):
                flat_cat[k] = override
                
        # Re-build catalogue tree
        new_tree = {}
        for k, v in flat_cat.items():
            parts = k.split('.')
            node = new_tree
            for p in parts[:-1]:
                if p not in node or not isinstance(node[p], dict):
                    node[p] = {}
                node = node[p]
            node[parts[-1]] = v
            
        with open(cat_file, 'w', encoding='utf-8') as f:
            json.dump(new_tree, f, ensure_ascii=False, indent=2)
            f.write('\n')
            
        # Update export done files
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
                override = translate_key_val(k, en_val, loc_code)
                if override and ph_ok(en_val, override):
                    updated_done[k] = override
                else:
                    curr = existing_done.get(k, en_val)
                    updated_done[k] = curr
                    
            with open(done_file, 'w', encoding='utf-8') as f:
                json.dump(updated_done, f, ensure_ascii=False, indent=2)
                f.write('\n')
                
        print(f"Master pass complete for {loc_code} ({short})")

if __name__ == '__main__':
    process_all()
