#!/usr/bin/env python3
"""
Comprehensive Sidebar Navigation & Dashboard Translator for Simeli ERP across all 21 Locales.
Populates all 106 nav.* keys and Dashboard ui.* keys in src/i18n/locales/<lang>.json
and in i18n-export/done/<locale>/ files.
"""

import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')
EXPORT_DIR = os.path.join(BASE_DIR, 'i18n-export')
DONE_DIR = os.path.join(EXPORT_DIR, 'done')

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

# Complete translations for all 106 Sidebar Navigation items across all 21 languages
NAV_MAP = {
    'overview': {
        'ar': 'نظرة عامة', 'az': 'İcmal', 'bn': 'ওভারভিউ', 'de': 'Übersicht',
        'es': 'Resumen', 'fa': 'مرور کلی', 'fr': 'Aperçu', 'hi': 'अवलोकन',
        'id': 'Ikhtisar', 'it': 'Panoramica', 'ja': '概要', 'ko': '개요',
        'nl': 'Overzicht', 'pl': 'Przegląd', 'pt': 'Visão geral', 'ru': 'Обзор',
        'tr': 'Genel Bakış', 'uk': 'Огляд', 'ur': 'جائزہ', 'vi': 'Tổng quan', 'zh': '概览'
    },
    'dashboard': {
        'ar': 'لوحة التحكم', 'az': 'İdarəetmə paneli', 'bn': 'ড্যাশবোর্ড', 'de': 'Dashboard',
        'es': 'Panel principal', 'fa': 'داشبورد', 'fr': 'Tableau de bord', 'hi': 'डैशबोर्ड',
        'id': 'Dasbor', 'it': 'Dashboard', 'ja': 'ダッシュボード', 'ko': '대시보드',
        'nl': 'Dashboard', 'pl': 'Pulpit nawigacyjny', 'pt': 'Painel de controle', 'ru': 'Панель управления',
        'tr': 'Gösterge Paneli', 'uk': 'Панель управління', 'ur': 'ڈیش بورڈ', 'vi': 'Bảng điều khiển', 'zh': '仪表板'
    },
    'operations': {
        'ar': 'العمليات التشغيلية', 'az': 'Əməliyyatlar', 'bn': 'অপারেশনস', 'de': 'Operatives Geschäft',
        'es': 'Operaciones', 'fa': 'عملیات', 'fr': 'Opérations', 'hi': 'ऑपरेशन',
        'id': 'Operasional', 'it': 'Operazioni', 'ja': '業務運用', 'ko': '운영',
        'nl': 'Operationele zaken', 'pl': 'Operacje', 'pt': 'Operações', 'ru': 'Операции',
        'tr': 'Operasyonlar', 'uk': 'Операції', 'ur': 'آپریشنز', 'vi': 'Vận hành', 'zh': '运营管理'
    },
    'inventory': {
        'ar': 'المخزون', 'az': 'Anbar və Stok', 'bn': 'ইনভেন্টরি', 'de': 'Lagerhaltung',
        'es': 'Inventario', 'fa': 'موجودی انبار', 'fr': 'Stocks', 'hi': 'इन्वेंटरी',
        'id': 'Inventaris', 'it': 'Magazzino', 'ja': '在庫管理', 'ko': '재고',
        'nl': 'Voorraad', 'pl': 'Magazyn', 'pt': 'Estoque', 'ru': 'Склад и запасы',
        'tr': 'Stok ve Depo', 'uk': 'Складські запаси', 'ur': 'انوینٹری', 'vi': 'Hàng tồn kho', 'zh': '库存'
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
    'warehouse': {
        'ar': 'المستودعات', 'az': 'Anbar', 'bn': 'গুদাম', 'de': 'Lagerhaus',
        'es': 'Almacenes', 'fa': 'انبار', 'fr': 'Entrepôt', 'hi': 'गोदाम',
        'id': 'Gudang', 'it': 'Magazzini', 'ja': '倉庫', 'ko': '창고',
        'nl': 'Magazijn', 'pl': 'Magazyny', 'pt': 'Almoxarifado', 'ru': 'Склады',
        'tr': 'Depolar', 'uk': 'Склади', 'ur': 'گودام', 'vi': 'Kho hàng', 'zh': '仓库'
    },
    'warehouseTransactions': {
        'ar': 'معاملات المستودع', 'az': 'Anbar əməliyyatları', 'bn': 'গুদাম লেনদেন', 'de': 'Lagerbewegungen',
        'es': 'Movimientos de almacén', 'fa': 'تراکنش‌های انبار', 'fr': 'Mouvements de stock', 'hi': 'गोदाम लेन-देन',
        'id': 'Transaksi Gudang', 'it': 'Movimenti di magazzino', 'ja': '倉庫取引', 'ko': '창고 트랜잭션',
        'nl': 'Magazijntransacties', 'pl': 'Transakcje magazynowe', 'pt': 'Transações de estoque', 'ru': 'Складские операции',
        'tr': 'Depo İşlemleri', 'uk': 'Складські операції', 'ur': 'گودام کے معاملات', 'vi': 'Giao dịch kho', 'zh': '仓库交易'
    },
    'inventoryTransfers': {
        'ar': 'تحويلات المخزون', 'az': 'Anbararası köçürmələr', 'bn': 'ইনভেন্টরি স্থানান্তরণ', 'de': 'Lagerumlagerungen',
        'es': 'Transferencias de inventario', 'fa': 'انتقالات موجودی', 'fr': 'Transferts de stock', 'hi': 'इन्वेंटरी स्थानांतरण',
        'id': 'Transfer Inventaris', 'it': 'Trasferimenti di magazzino', 'ja': '在庫移動', 'ko': '재고 이동',
        'nl': 'Voorraadverplaatsingen', 'pl': 'Przesunięcia magazynowe', 'pt': 'Transferências de estoque', 'ru': 'Перемещение товаров',
        'tr': 'Stok Transferleri', 'uk': 'Переміщення товарів', 'ur': 'انوینٹری کی منتقلی', 'vi': 'Điều chuyển kho', 'zh': '库存调拨'
    },
    'stocktakeCounting': {
        'ar': 'الجرد وحصر المخزون', 'az': 'Sayım və inventarizasiya', 'bn': 'স্টক গণনা', 'de': 'Inventur & Zählung',
        'es': 'Recuento de stock', 'fa': 'انبارگردانی و شمارش', 'fr': 'Inventaire et comptage', 'hi': 'स्टॉक गणना',
        'id': 'Stok Opname / Penghitungan', 'it': 'Inventario fisico', 'ja': '棚卸・実地棚卸', 'ko': '재고 조사 / 실사',
        'nl': 'Voorraadtelling', 'pl': 'Inwentaryzacja i liczenie', 'pt': 'Inventário físico', 'ru': 'Инвентаризация запасов',
        'tr': 'Stok Sayımı', 'uk': 'Інвентаризація товарів', 'ur': 'اسٹاک کی گنتی', 'vi': 'Kiểm kê kho', 'zh': '盘点与盘点'
    },
    'barcodeScanning': {
        'ar': 'مسح الباركود', 'az': 'Barkod oxunması', 'bn': 'বারকোড স্ক্যানিং', 'de': 'Barcode-Scannen',
        'es': 'Escaneo de código de barras', 'fa': 'اسکن بارکد', 'fr': 'Lecture de codes-barres', 'hi': 'बारकोड स्कैनिंग',
        'id': 'Pemindaian Barcode', 'it': 'Scansione codice a barre', 'ja': 'バーコードスキャン', 'ko': '바코드 스캔',
        'nl': 'Barcode scannen', 'pl': 'Skanowanie kodów kreskowych', 'pt': 'Escaneamento de código de barras', 'ru': 'Сканирование штрихкодов',
        'tr': 'Barkod Taraması', 'uk': 'Сканування штрихкодів', 'ur': 'بار کوڈ اسکیننگ', 'vi': 'Quét mã vạch', 'zh': '条码扫描'
    },
    'procurement': {
        'ar': 'المشتريات', 'az': 'Satınalma', 'bn': 'ক্রয়', 'de': 'Einkauf',
        'es': 'Compras', 'fa': 'خرید و تدارکات', 'fr': 'Achats', 'hi': 'खरीद',
        'id': 'Pengadaan', 'it': 'Acquisti', 'ja': '購買', 'ko': '조달',
        'nl': 'Inkoop', 'pl': 'Zakupy', 'pt': 'Compras', 'ru': 'Закупки',
        'tr': 'Satınalma', 'uk': 'Закупівлі', 'ur': 'خریداری', 'vi': 'Mua hàng', 'zh': '采购'
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
    'contracts': {
        'ar': 'العقود', 'az': 'Müqavilələr', 'bn': 'চুক্তি', 'de': 'Verträge',
        'es': 'Contratos', 'fa': 'قراردادها', 'fr': 'Contrats', 'hi': 'अनुबंध',
        'id': 'Kontrak', 'it': 'Contratti', 'ja': '契約', 'ko': '계약',
        'nl': 'Contracten', 'pl': 'Umowy', 'pt': 'Contratos', 'ru': 'Договоры',
        'tr': 'Sözleşmeler', 'uk': 'Договори', 'ur': 'معاہدے', 'vi': 'Hợp đồng', 'zh': '合同'
    },
    'purchaseRequisitions': {
        'ar': 'طلبات الشراء', 'az': 'Satınalma tələbləri', 'bn': 'ক্রয় কিউশন', 'de': 'Bedarfsanforderungen',
        'es': 'Solicitudes de compra', 'fa': 'درخواست‌های خرید', 'fr': 'Demandes d\'achat', 'hi': 'क्रय मांगपत्र',
        'id': 'Permintaan Pembelian', 'it': 'Richieste di acquisto', 'ja': '購買依頼', 'ko': '구매 요청서',
        'nl': 'Inkoopaanvragen', 'pl': 'Zapotrzebowania zakupu', 'pt': 'Requisições de compra', 'ru': 'Заявки на закупку',
        'tr': 'Satınalma Talepleri', 'uk': 'Заявки на закупівлю', 'ur': 'خریداری کی درخواستیں', 'vi': 'Yêu cầu mua hàng', 'zh': '采购申请'
    },
    'requestForQuotations': {
        'ar': 'طلبات عروض الأسعار', 'az': 'Qiymət sorğuları (RFQ)', 'bn': 'দরপত্রের জন্য অনুরোধ (RFQ)', 'de': 'Preisanfragen (RFQ)',
        'es': 'Solicitudes de cotización', 'fa': 'استعلام‌های قیمت', 'fr': 'Demandes de prix (RFQ)', 'hi': 'दरपत्र की मांग (RFQ)',
        'id': 'Permintaan Penawaran (RFQ)', 'it': 'Richieste di offerta (RFQ)', 'ja': '見積依頼 (RFQ)', 'ko': '견적 요청서 (RFQ)',
        'nl': 'Offerteaanvragen (RFQ)', 'pl': 'Zapytania ofertowe (RFQ)', 'pt': 'Solicitações de cotação', 'ru': 'Запросы цен (RFQ)',
        'tr': 'Teklif Talepleri (RFQ)', 'uk': 'Запити цінових пропозицій', 'ur': 'قیمت کی درخواستیں', 'vi': 'Yêu cầu báo giá (RFQ)', 'zh': '询价单 (RFQ)'
    },
    'purchaseOrders': {
        'ar': 'أوامر الشراء', 'az': 'Satınalma sifarişləri', 'bn': 'ক্রয় আদেশ', 'de': 'Bestellungen',
        'es': 'Pedidos de compra', 'fa': 'سفارشات خرید', 'fr': 'Commandes d\'achat', 'hi': 'क्रय आदेश',
        'id': 'Pesanan Pembelian', 'it': 'Ordini di acquisto', 'ja': '発注書', 'ko': '구매 주문서',
        'nl': 'Inkooporders', 'pl': 'Zamówienia zakupu', 'pt': 'Pedidos de compra', 'ru': 'Заказы на закупку',
        'tr': 'Satınalma Siparişleri', 'uk': 'Замовлення на закупівлю', 'ur': 'خریداری کے آرڈرز', 'vi': 'Đơn đặt hàng (PO)', 'zh': '采购订单'
    },
    'sales': {
        'ar': 'المبيعات', 'az': 'Satış', 'bn': 'বিক্রয়', 'de': 'Vertrieb',
        'es': 'Ventas', 'fa': 'فروش', 'fr': 'Ventes', 'hi': 'बिक्री',
        'id': 'Penjualan', 'it': 'Vendite', 'ja': '販売', 'ko': '영업',
        'nl': 'Verkoop', 'pl': 'Sprzedaż', 'pt': 'Vendas', 'ru': 'Продажи',
        'tr': 'Satış', 'uk': 'Продажі', 'ur': 'فروخت', 'vi': 'Bán hàng', 'zh': '销售'
    },
    'customers': {
        'ar': 'العملاء', 'az': 'Müştərilər', 'bn': 'গ্রাহক', 'de': 'Kunden',
        'es': 'Clientes', 'fa': 'مشتریان', 'fr': 'Clients', 'hi': 'ग्राहक',
        'id': 'Pelanggan', 'it': 'Clienti', 'ja': '得意先', 'ko': '고객',
        'nl': 'Klanten', 'pl': 'Klienci', 'pt': 'Clientes', 'ru': 'Покупатели',
        'tr': 'Müşteriler', 'uk': 'Покупці', 'ur': 'گاہک', 'vi': 'Khách hàng', 'zh': '客户'
    },
    'salesContracts': {
        'ar': 'عقود المبيعات', 'az': 'Satış müqavilələri', 'bn': 'বিক্রয় চুক্তি', 'de': 'Verkaufsverträge',
        'es': 'Contratos de venta', 'fa': 'قراردادهای فروش', 'fr': 'Contrats de vente', 'hi': 'बिक्री अनुबंध',
        'id': 'Kontrak Penjualan', 'it': 'Contratti di vendita', 'ja': '販売契約', 'ko': '판매 계약',
        'nl': 'Verkoopcontracten', 'pl': 'Umowy sprzedaży', 'pt': 'Contratos de venda', 'ru': 'Договоры продажи',
        'tr': 'Satış Sözleşmeleri', 'uk': 'Договори продажу', 'ur': 'فروخت کے معاہدے', 'vi': 'Hợp đồng bán hàng', 'zh': '销售合同'
    },
    'rfqToSuppliers': {
        'ar': 'طلبات عروض الأسعار للموردين', 'az': 'Təchizatçılara qiymət sorğusu', 'bn': 'সরবরাহকারীদের কাছে আরএফকিউ', 'de': 'Preisanfragen an Lieferanten',
        'es': 'Solicitudes de cotización a proveedores', 'fa': 'درخواست قیمت از تامین‌کنندگان', 'fr': 'Demandes de devis aux fournisseurs', 'hi': 'आपूर्तिकर्ताओं को आरएफक्यू',
        'id': 'RFQ ke Pemasok', 'it': 'Richieste di preventivo ai fornitori', 'ja': '仕入先への見積依頼', 'ko': '공급업체 견적 요청',
        'nl': 'Offerteaanvragen aan leveranciers', 'pl': 'Zapytania ofertowe do dostawców', 'pt': 'Solicitações de cotação para fornecedores', 'ru': 'Запросы предложений поставщикам',
        'tr': 'Tedarikçilere Teklif Talebi', 'uk': 'Запити цінових пропозицій постачальникам', 'ur': 'سپلائرز کو آر ایف کیو', 'vi': 'Yêu cầu báo giá gửi nhà cung cấp', 'zh': '向供应商询价'
    },
    'salesQuotations': {
        'ar': 'عروض الأسعار', 'az': 'Satış təklifləri', 'bn': 'বিক্রয় কোটেশন', 'de': 'Angebote',
        'es': 'Cotizaciones de venta', 'fa': 'پیش‌فاکتورها و پیشنهادها', 'fr': 'Devis de vente', 'hi': 'बिक्री उद्धरण',
        'id': 'Penawaran Penjualan', 'it': 'Preventivi di vendita', 'ja': '見積書', 'ko': '견적서',
        'nl': 'Verkoopoffertes', 'pl': 'Oferty handlowe', 'pt': 'Cotações de venda', 'ru': 'Коммерческие предложения',
        'tr': 'Satış Teklifleri', 'uk': 'Комерційні пропозиції', 'ur': 'فروخت کوٹیشن', 'vi': 'Báo giá bán hàng', 'zh': '销售报价单'
    },
    'salesOrders': {
        'ar': 'أوامر المبيعات', 'az': 'Satış sifarişləri', 'bn': 'বিক্রয় আদেশ', 'de': 'Kundenaufträge',
        'es': 'Pedidos de venta', 'fa': 'سفارشات فروش', 'fr': 'Commandes clients', 'hi': 'बिक्री आदेश',
        'id': 'Pesanan Penjualan', 'it': 'Ordini di vendita', 'ja': '受注書', 'ko': '판매 주문서',
        'nl': 'Verkooporders', 'pl': 'Zamówienia sprzedaży', 'pt': 'Pedidos de venda', 'ru': 'Заказы покупателей',
        'tr': 'Satış Siparişleri', 'uk': 'Замовлення покупців', 'ur': 'فروخت کے آرڈرز', 'vi': 'Đơn bán hàng', 'zh': '销售订单'
    },
    'deliverySchedules': {
        'ar': 'جداول التسليم', 'az': 'Çatdırılma cədvəlləri', 'bn': 'ডেলিভারি সময়সূচী', 'de': 'Lieferpläne',
        'es': 'Programas de entrega', 'fa': 'برنامه‌های زمان‌بندی تحویل', 'fr': 'Calendriers de livraison', 'hi': 'डिलीवरी शेड्यूल',
        'id': 'Jadwal Pengiriman', 'it': 'Piani di consegna', 'ja': '納وスケジュール', 'ko': '납품 일정',
        'nl': 'Leveringsschema\'s', 'pl': 'Harmonogramy dostaw', 'pt': 'Cronogramas de entrega', 'ru': 'Графики поставок',
        'tr': 'Teslimat Programları', 'uk': 'Графіки поставок', 'ur': 'ترسیل کا شیڈول', 'vi': 'Lịch giao hàng', 'zh': '交货计划'
    },
    'manufacturing': {
        'ar': 'التصنيع', 'az': 'İstehsalat', 'bn': 'ম্যানুফ্যাকচারিং', 'de': 'Fertigung',
        'es': 'Fabricación', 'fa': 'تولید و ساخت', 'fr': 'Fabrication', 'hi': 'विनिर्माण',
        'id': 'Manufaktur', 'it': 'Produzione industriale', 'ja': '製造', 'ko': '제조',
        'nl': 'Productie', 'pl': 'Produkcja', 'pt': 'Manufatura', 'ru': 'Производство',
        'tr': 'Üretim', 'uk': 'Виробництво', 'ur': 'مینوفیکچرنگ', 'vi': 'Sản xuất', 'zh': '制造管理'
    },
    'production': {
        'ar': 'الإنتاج', 'az': 'İstehsal', 'bn': 'উৎপাদন', 'de': 'Produktion',
        'es': 'Producción', 'fa': 'خط تولید', 'fr': 'Production', 'hi': 'उत्पादन',
        'id': 'Produksi', 'it': 'Produzione', 'ja': '生産', 'ko': '생산',
        'nl': 'Productie', 'pl': 'Produkcja', 'pt': 'Produção', 'ru': 'Производственный процесс',
        'tr': 'Üretim Süreci', 'uk': 'Виробничий процес', 'ur': 'پیداوار', 'vi': 'Quy trình sản xuất', 'zh': '生产'
    },
    'workOrders': {
        'ar': 'أوامر التصنيع', 'az': 'İstehsalat tapşırıqları', 'bn': 'কাজ এর আদেশ', 'de': 'Fertigungsaufträge',
        'es': 'Órdenes de trabajo', 'fa': 'دستورات کاری', 'fr': 'Ordres de fabrication', 'hi': 'कार्य आदेश',
        'id': 'Perintah Kerja', 'it': 'Ordini di lavoro', 'ja': '製造指示書', 'ko': '작업 지시서',
        'nl': 'Werkorders', 'pl': 'Zlecenia produkcyjne', 'pt': 'Ordens de serviço', 'ru': 'Заказы на производство',
        'tr': 'Üretim Emirleri', 'uk': 'Замовлення на виробництво', 'ur': 'کام کے آرڈرز', 'vi': 'Lệnh sản xuất', 'zh': '生产工单'
    },
    'billsOfMaterial': {
        'ar': 'قوائم المواد (BOM)', 'az': 'Məhsul tərkibi (BOM)', 'bn': 'উপাদানের তালিকা (BOM)', 'de': 'Stücklisten (BOM)',
        'es': 'Listas de materiales (BOM)', 'fa': 'ساختار محصول (BOM)', 'fr': 'Nomenclatures (BOM)', 'hi': 'सामग्री बिल (BOM)',
        'id': 'Daftar Bahan (BOM)', 'it': 'Distinte base (BOM)', 'ja': '部品表 (BOM)', 'ko': '자재 명세서 (BOM)',
        'nl': 'Stuklijsten (BOM)', 'pl': 'Struktury materiałowe (BOM)', 'pt': 'Listas de materiais (BOM)', 'ru': 'Спецификации (BOM)',
        'tr': 'Ürün Reçeteleri (BOM)', 'uk': 'Специфікації (BOM)', 'ur': 'مواد کی فہرست', 'vi': 'Định mức nguyên liệu (BOM)', 'zh': '物料清单 (BOM)'
    },
    'mrpIiWorkbench': {
        'ar': 'منصة تخطيط موارد التصنيع (MRP II)', 'az': 'MRP II iş masası', 'bn': 'এমআরপি II ওয়ার্কবেঞ্চ', 'de': 'MRP II Arbeitsplatz',
        'es': 'Banco de trabajo MRP II', 'fa': 'میز کار MRP II', 'fr': 'Espace de travail MRP II', 'hi': 'एमआरपी II कार्यस्थल',
        'id': 'Papan Kerja MRP II', 'it': 'Banco di lavoro MRP II', 'ja': 'MRP II ワークベンチ', 'ko': 'MRP II 워크벤치',
        'nl': 'MRP II werkbank', 'pl': 'Konsola MRP II', 'pt': 'Bancada MRP II', 'ru': 'Рабочее место MRP II',
        'tr': 'MRP II Çalışma Masası', 'uk': 'Робоче місце MRP II', 'ur': 'ایم آر پی ٹول باکس', 'vi': 'Bàn làm việc MRP II', 'zh': 'MRP II 工作台'
    },
    'workCentersRouting': {
        'ar': 'مراكز العمل ومسارات الإنتاج', 'az': 'İş mərkəzləri və marşrutlar', 'bn': 'ওয়ার্ক সেন্টার এবং রাউটিং', 'de': 'Arbeitsplätze & Arbeitspläne',
        'es': 'Centros de trabajo y rutas', 'fa': 'مراكز کاری و مسیریابی', 'fr': 'Postes de charge et gammes', 'hi': 'कार्य केंद्र और रूटिंग',
        'id': 'Pusat Kerja & Rute', 'it': 'Centri di lavoro e cicli', 'ja': '作業区とルーティング', 'ko': '작업장 및 라우팅',
        'nl': 'Werkplekken & Routing', 'pl': 'Gniazda produkcyjne i marszruty', 'pt': 'Centros de trabalho e roteiros', 'ru': 'Рабочие центры и маршруты',
        'tr': 'İş Merkezleri ve Rotalar', 'uk': 'Робочі центри та маршрути', 'ur': 'ورک سینٹرز اور روٹنگ', 'vi': 'Trung tâm công việc & quy trình', 'zh': '工作中心与工艺路线'
    },
    'customersDelivery': {
        'ar': 'العملاء والتسليم', 'az': 'Müştərilər və çatdırılma', 'bn': 'গ্রাহক এবং ডেলিভারি', 'de': 'Kunden & Lieferung',
        'es': 'Clientes y entrega', 'fa': 'مشتریان و تحویل', 'fr': 'Clients et livraison', 'hi': 'ग्राहक और डिलीवरी',
        'id': 'Pelanggan & Pengiriman', 'it': 'Clienti e consegna', 'ja': '得意先と配送', 'ko': '고객 및 배송',
        'nl': 'Klanten & Levering', 'pl': 'Klienci i dostawy', 'pt': 'Clientes e entregas', 'ru': 'Покупатели и доставка',
        'tr': 'Müşteriler ve Teslimat', 'uk': 'Покупці та доставка', 'ur': 'گاہک اور ترسیل', 'vi': 'Khách hàng & giao hàng', 'zh': '客户与交货'
    },
    'crm': {
        'ar': 'إدارة علاقات العملاء (CRM)', 'az': 'CRM (Müştəri əlaqələri)', 'bn': 'সিআরএম', 'de': 'CRM',
        'es': 'CRM', 'fa': 'مدیریت ارتباط با مشتری (CRM)', 'fr': 'CRM', 'hi': 'सीआरएम',
        'id': 'CRM', 'it': 'CRM', 'ja': 'CRM (顧客管理)', 'ko': 'CRM',
        'nl': 'CRM', 'pl': 'CRM', 'pt': 'CRM', 'ru': 'CRM (Связи с клиентами)',
        'tr': 'CRM (Müşteri İlişkileri)', 'uk': 'CRM', 'ur': 'سی آر ایم', 'vi': 'CRM', 'zh': 'CRM (客户关系)'
    },
    'leads': {
        'ar': 'العملاء المحتملون', 'az': 'Potensial müştərilər', 'bn': 'লিডস', 'de': 'Interessenten (Leads)',
        'es': 'Candidatos (Leads)', 'fa': 'سرنخ‌های فروش', 'fr': 'Pistes (Leads)', 'hi': 'संभावित ग्राहक',
        'id': 'Prospek (Leads)', 'it': 'Lead', 'ja': '見込み客 (Lead)', 'ko': '리드 (Lead)',
        'nl': 'Leads', 'pl': 'Szanse sprzedaży (Leads)', 'pt': 'Potenciais clientes', 'ru': 'Лиды (Лидогенерация)',
        'tr': 'Aday Müşteriler', 'uk': 'Ліди', 'ur': 'امکانی گاہک', 'vi': 'Khách hàng tiềm năng', 'zh': '线索'
    },
    'dealPipeline': {
        'ar': 'مسار الصفقات', 'az': 'Sövdələşmə boru kəməri', 'bn': 'ডিল পাইপলাইন', 'de': 'Verkaufschancen-Pipeline',
        'es': 'Embudo de ventas', 'fa': 'خط لوله معاملات', 'fr': 'Pipeline d\'affaires', 'hi': 'सौदा पाइपलाइन',
        'id': 'Pipelines Penjualan', 'it': 'Pipeline opportunità', 'ja': '商談パイプライン', 'ko': '딜 파이프라인',
        'nl': 'Deal pipeline', 'pl': 'Lejek sprzedaży', 'pt': 'Funil de vendas', 'ru': 'Воронка сделок',
        'tr': 'Fırsat Havuzu', 'uk': 'Воронка угод', 'ur': 'ڈیل پائپ لائن', 'vi': 'Quy trình cơ hội', 'zh': '商談漏斗'
    },
    'contacts': {
        'ar': 'جهات الاتصال', 'az': 'Əlaqə şəxsləri', 'bn': 'যোগাযোগ', 'de': 'Kontakte',
        'es': 'Contactos', 'fa': 'مخاطبین', 'fr': 'Contacts', 'hi': 'संपर्क',
        'id': 'Kontak', 'it': 'Contatti', 'ja': '連絡先', 'ko': '연락처',
        'nl': 'Contactpersonen', 'pl': 'Kontakty', 'pt': 'Contatos', 'ru': 'Контакты',
        'tr': 'Kişiler', 'uk': 'Контакти', 'ur': 'رابطے', 'vi': 'Liên hệ', 'zh': '联系人'
    },
    'activities': {
        'ar': 'الأنشطة والمهام', 'az': 'Fəaliyyətlər', 'bn': 'কার্যক্রম', 'de': 'Aktivitäten',
        'es': 'Actividades', 'fa': 'فعالیت‌ها', 'fr': 'Activités', 'hi': 'गतिविधियां',
        'id': 'Aktivitas', 'it': 'Attività', 'ja': 'アクティビティ', 'ko': '활동',
        'nl': 'Activiteiten', 'pl': 'Aktywności', 'pt': 'Atividades', 'ru': 'Активности',
        'tr': 'Aktiviteler', 'uk': 'Активності', 'ur': 'سرگرمیاں', 'vi': 'Hoạt động', 'zh': '活动'
    },
    'projects': {
        'ar': 'المشاريع', 'az': 'Layihələr', 'bn': 'প্রকল্প', 'de': 'Projekte',
        'es': 'Proyectos', 'fa': 'پروژه‌ها', 'fr': 'Projets', 'hi': 'परियोजनाएं',
        'id': 'Proyek', 'it': 'Progetti', 'ja': 'プロジェクト', 'ko': '프로젝트',
        'nl': 'Projecten', 'pl': 'Projekty', 'pt': 'Projetos', 'ru': 'Проекты',
        'tr': 'Projeler', 'uk': 'Проєкти', 'ur': 'منصوبے', 'vi': 'Dự án', 'zh': '项目'
    },
    'allProjects': {
        'ar': 'جميع المشاريع', 'az': 'Bütün layihələr', 'bn': 'সমস্ত প্রকল্প', 'de': 'Alle Projekte',
        'es': 'Todos los proyectos', 'fa': 'همه پروژه‌ها', 'fr': 'Tous les projets', 'hi': 'सभी परियोजनाएं',
        'id': 'Semua Proyek', 'it': 'Tutti i progetti', 'ja': 'すべてのプロジェクト', 'ko': '모든 프로젝트',
        'nl': 'Alle projecten', 'pl': 'Wszystkie projekty', 'pt': 'Todos os projetos', 'ru': 'Все проекты',
        'tr': 'Tüm Projeler', 'uk': 'Усі проєкти', 'ur': 'تمام منصوبے', 'vi': 'Tất cả dự án', 'zh': '所有项目'
    },
    'myTimesheet': {
        'ar': 'جدول ساعاتي', 'az': 'Mənim vaxt cədvəlim', 'bn': 'আমার টাইমসিট', 'de': 'Meine Stundenzettel',
        'es': 'Mi hoja de horas', 'fa': 'کارت تایم‌شیت من', 'fr': 'Ma feuille de temps', 'hi': 'मेरी समय सारणी',
        'id': 'Lembar Kerja Saya', 'it': 'Il mio foglio ore', 'ja': 'マイタイムシート', 'ko': '내 타임시트',
        'nl': 'Mijn urenkaart', 'pl': 'Karta pracy', 'pt': 'Minha folha de horas', 'ru': 'Мой табель учета времени',
        'tr': 'Zaman Çizelgem', 'uk': 'Мій табель часу', 'ur': 'میرا ٹائم شیٹ', 'vi': 'Bảng chấm công của tôi', 'zh': '我的工时表'
    },
    'financials': {
        'ar': 'الشؤون المالية', 'az': 'Maliyyə', 'bn': 'অর্থসংস্থান', 'de': 'Finanzwesen',
        'es': 'Finanzas', 'fa': 'امور مالی', 'fr': 'Finance', 'hi': 'वित्तीय',
        'id': 'Keuangan', 'it': 'Finanza', 'ja': '財務', 'ko': '재무',
        'nl': 'Financiën', 'pl': 'Finanse', 'pt': 'Finanças', 'ru': 'Финансы',
        'tr': 'Finans', 'uk': 'Фінанси', 'ur': 'مالیات', 'vi': 'Tài chính', 'zh': '财务'
    },
    'financeOverview': {
        'ar': 'نظرة عامة على المالية', 'az': 'Maliyyə icmalı', 'bn': 'অর্থনৈতিক ওভারভিউ', 'de': 'Finanzübersicht',
        'es': 'Resumen financiero', 'fa': 'مرور کلی مالی', 'fr': 'Aperçu financier', 'hi': 'वित्तीय अवलोकन',
        'id': 'Ikhtisar Keuangan', 'it': 'Panoramica finanziaria', 'ja': '財務概要', 'ko': '재무 개요',
        'nl': 'Financieel overzicht', 'pl': 'Przegląd finansowy', 'pt': 'Visão geral financeira', 'ru': 'Финансовый обзор',
        'tr': 'Finansal Genel Bakış', 'uk': 'Фінансовий огляд', 'ur': 'مالیاتی جائزہ', 'vi': 'Tổng quan tài chính', 'zh': '财务概览'
    },
    'generalLedger': {
        'ar': 'دفتر الأستاذ العام', 'az': 'Baş kitab', 'bn': 'সাধারণ খতিয়ান', 'de': 'Hauptbuch',
        'es': 'Libro mayor', 'fa': 'دفتر کل', 'fr': 'Grand livre', 'hi': 'सामान्य बही',
        'id': 'Buku Besar', 'it': 'Contabilità generale', 'ja': '総勘定元帳', 'ko': '총계정원장',
        'nl': 'Grootboek', 'pl': 'Księga главna', 'pt': 'Livro razão', 'ru': 'Главная книга',
        'tr': 'Defter-i Kebir', 'uk': 'Головна книга', 'ur': 'جنرل لیجر', 'vi': 'Sổ cái tổng hợp', 'zh': '总账'
    },
    'chartOfAccounts': {
        'ar': 'دليل الحسابات', 'az': 'Hesablar planı', 'bn': 'হিসাব তালিকা', 'de': 'Kontenplan',
        'es': 'Plan de cuentas', 'fa': 'کدینگ و کدگذاری حساب‌ها', 'fr': 'Plan comptable', 'hi': 'खातों का चार्ट',
        'id': 'Bagan Akun', 'it': 'Piano dei conti', 'ja': '勘定 kamokuchart', 'ko': '계정과목표',
        'nl': 'Rekeningschema', 'pl': 'Plan kont', 'pt': 'Plano de contas', 'ru': 'План счетов',
        'tr': 'Hesap Planı', 'uk': 'План рахунків', 'ur': 'چارٹ آف اکاؤنٹس', 'vi': 'Hệ thống tài khoản', 'zh': '科目表'
    },
    'journalEntries': {
        'ar': 'قيود اليومية', 'az': 'Jurnal yazıları', 'bn': 'জাবেদা এন্ট্রি', 'de': 'Buchungssätze',
        'es': 'Asientos contables', 'fa': 'اسناد حسابداری', 'fr': 'Écritures comptables', 'hi': 'जर्नल प्रविष्टियां',
        'id': 'Jurnal Umum', 'it': 'Prima nota', 'ja': '仕訳帳', 'ko': '분개장',
        'nl': 'Memoriaalboekingen', 'pl': 'Wpisy do dziennika', 'pt': 'Lançamentos contábeis', 'ru': 'Журнал проводок',
        'tr': 'Yevmiye Kayıtları', 'uk': 'Журнал проводок', 'ur': 'جرنل اندراجات', 'vi': 'Bút toán sổ nhật ký', 'zh': '日记账凭证'
    },
    'receivablesAr': {
        'ar': 'الحسابات المدينة (AR)', 'az': 'Müştəri borcları (AR)', 'bn': 'প্রাপ্য হিসাব (AR)', 'de': 'Forderungen (AR)',
        'es': 'Cuentas por cobrar (AR)', 'fa': 'حساب‌های دریافتنی (AR)', 'fr': 'Comptes clients (AR)', 'hi': 'प्राप्य खाते (AR)',
        'id': 'Piutang Usaha (AR)', 'it': 'Crediti clienti (AR)', 'ja': '売掛金 (AR)', 'ko': '매출채권 (AR)',
        'nl': 'Debiteuren (AR)', 'pl': 'Należności (AR)', 'pt': 'Contas a receber (AR)', 'ru': 'Дебиторская задолженность (AR)',
        'tr': 'Alacaklar (AR)', 'uk': 'Дебіторська заборгованість (AR)', 'ur': 'قابل وصول رقم (AR)', 'vi': 'Phải thu khách hàng (AR)', 'zh': '应收账款 (AR)'
    },
    'customerInvoices': {
        'ar': 'فواتير العملاء', 'az': 'Müştəri hesab-fakturaları', 'bn': 'গ্রাহক রসিদ', 'de': 'Kundenrechnungen',
        'es': 'Facturas de clientes', 'fa': 'فاکتورهای مشتریان', 'fr': 'Factures clients', 'hi': 'ग्राहक चालान',
        'id': 'Faktur Pelanggan', 'it': 'Fatture clienti', 'ja': '得意先請求書', 'ko': '고객 송장',
        'nl': 'Verkoopfacturen', 'pl': 'Faktury dla klientów', 'pt': 'Faturas de clientes', 'ru': 'Счета покупателям',
        'tr': 'Müşteri Faturaları', 'uk': 'Рахунки покупцям', 'ur': 'کسٹمر انوائس', 'vi': 'Hóa đơn khách hàng', 'zh': '客户发票'
    },
    'recurringInvoices': {
        'ar': 'الفواتير الدورية', 'az': 'Dövri hesab-fakturalar', 'bn': 'পুনরাবৃত্তিমূলক চালান', 'de': 'Wiederkehrende Rechnungen',
        'es': 'Facturas recurrentes', 'fa': 'فاکتورهای تکراری', 'fr': 'Factures récurrentes', 'hi': 'आवर्ती चालान',
        'id': 'Faktur Berulang', 'it': 'Fatture ricorrenti', 'ja': '定期請求書', 'ko': '반복 송장',
        'nl': 'Periodieke facturen', 'pl': 'Faktury cykliczne', 'pt': 'Faturas recorrentes', 'ru': 'Периодические счета',
        'tr': 'Tekrarlayan Faturalar', 'uk': 'Періодичні рахунки', 'ur': 'دوبارہ آنے والے انوائس', 'vi': 'Hóa đơn định kỳ', 'zh': '定期发票'
    },
    'paymentsReceived': {
        'ar': 'المدفوعات المستلمة', 'az': 'Daxil olan ödənişlər', 'bn': 'প্রাপ্ত পেমেন্ট', 'de': 'Zahlungseingänge',
        'es': 'Pagos recibidos', 'fa': 'پرداخت‌های دریافتی', 'fr': 'Paiements reçus', 'hi': 'प्राप्त भुगतान',
        'id': 'Pembayaran Diterima', 'it': 'Pagamenti ricevuti', 'ja': '入金記録', 'ko': '수금 기록',
        'nl': 'Ontvangen betalingen', 'pl': 'Otrzymane płatności', 'pt': 'Pagamentos recebidos', 'ru': 'Поступления оплаты',
        'tr': 'Tahsil Edilen Ödemeler', 'uk': 'Отримані платежі', 'ur': 'موصول شدہ ادائیگیاں', 'vi': 'Thanh toán đã nhận', 'zh': '已收货款'
    },
    'payablesAp': {
        'ar': 'الحسابات الدائنة (AP)', 'az': 'Məsrəf borcları (AP)', 'bn': 'প্রদেয় হিসাব (AP)', 'de': 'Verbindlichkeiten (AP)',
        'es': 'Cuentas por pagar (AP)', 'fa': 'حساب‌های پرداختنی (AP)', 'fr': 'Comptes fournisseurs (AP)', 'hi': 'देय खाते (AP)',
        'id': 'Hutang Usaha (AP)', 'it': 'Debiti fornitori (AP)', 'ja': '買掛金 (AP)', 'ko': '매입채무 (AP)',
        'nl': 'Crediteuren (AP)', 'pl': 'Zobowiązania (AP)', 'pt': 'Contas a pagar (AP)', 'ru': 'Кредиторская задолженность (AP)',
        'tr': 'Borçlar (AP)', 'uk': 'Кредиторська заборгованість (AP)', 'ur': 'قابل ادا رقم (AP)', 'vi': 'Phải trả nhà cung cấp (AP)', 'zh': '应付账款 (AP)'
    },
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
    'creditNotes': {
        'ar': 'إشعارات الخصم والإضافة', 'az': 'Kredit notaları', 'bn': 'ক্রেডিট নোট', 'de': 'Gutschriften',
        'es': 'Notas de crédito', 'fa': 'اعلامیه‌های بستانکار', 'fr': 'Avoirs', 'hi': 'क्रेडिट नोट',
        'id': 'Nota Kredit', 'it': 'Note di credito', 'ja': 'クレジットノート', 'ko': '크레디트 노트',
        'nl': 'Creditnota\'s', 'pl': 'Kredytowe noty uznaniowe', 'pt': 'Notas de crédito', 'ru': 'Kредитовые ноты',
        'tr': 'Alacak Notları', 'uk': 'Кредитові ноти', 'ur': 'کریڈٹ نوٹس', 'vi': 'Hóa đơn điều chỉnh giảm', 'zh': '贷记通知单'
    },
    'supplierPayments': {
        'ar': 'مدفوعات الموردين', 'az': 'Təchizatçı ödənişləri', 'bn': 'সরবরাহকারীর অর্থ প্রদান', 'de': 'Lieferantenzahlungen',
        'es': 'Pagos a proveedores', 'fa': 'پرداخت‌های تامین‌کنندگان', 'fr': 'Paiements fournisseurs', 'hi': 'आपूर्तिकर्ता भुगतान',
        'id': 'Pembayaran Pemasok', 'it': 'Pagamenti fornitori', 'ja': '仕入先支払', 'ko': '공급업체 지급',
        'nl': 'Leveranciersbetalingen', 'pl': 'Płatności dla dostawców', 'pt': 'Pagamentos a fornecedores', 'ru': 'Оплаты поставщикам',
        'tr': 'Tedarikçi Ödemeleri', 'uk': 'Оплати постачальникам', 'ur': 'سپلائر کی ادائیگیاں', 'vi': 'Thanh toán nhà cung cấp', 'zh': '供应商付款'
    },
    'assetsCash': {
        'ar': 'الأصول والسيولة النقدية', 'az': 'Əsas vəsaitlər və nağd pul', 'bn': 'সম্পদ ও নগদ', 'de': 'Anlagen & Liquide Mittel',
        'es': 'Activos y tesorería', 'fa': 'دارایی‌ها و وجوه نقد', 'fr': 'Actifs et trésorerie', 'hi': 'संपत्ति और नकद',
        'id': 'Aset & Kas', 'it': 'Attività e cassa', 'ja': '資産と資金', 'ko': '자산 및 현금',
        'nl': 'Activa & Kas', 'pl': 'Majątek i finanse', 'pt': 'Ativos e caixa', 'ru': 'Активы и денежные средства',
        'tr': 'Varlıklar ve Nakit', 'uk': 'Активи та грошові кошти', 'ur': 'اثاثے اور نقد', 'vi': 'Tài sản & tiền mặt', 'zh': '资产与现金'
    },
    'fixedAssets': {
        'ar': 'الأصول الثابتة', 'az': 'Əsas vəsaitlər', 'bn': 'স্থায়ী সম্পদ', 'de': 'Anlagevermögen',
        'es': 'Activos fijos', 'fa': 'دارایی‌های ثابت', 'fr': 'Immobilisations', 'hi': 'अचल संपत्ति',
        'id': 'Aset Tetap', 'it': 'Immobilizzazioni', 'ja': '固定資産', 'ko': '고정 자산',
        'nl': 'Vaste activa', 'pl': 'Środki trwałe', 'pt': 'Ativos fixos', 'ru': 'Основные средства',
        'tr': 'Maddi Duran Varlıklar', 'uk': 'Основні засоби', 'ur': 'مستقل اثاثے', 'vi': 'Tài sản cố định', 'zh': '固定资产'
    },
    'bankReconciliation': {
        'ar': 'التسوية البنكية', 'az': 'Bank üzləşdirilməsi', 'bn': 'ব্যাংক সমন্বয়', 'de': 'Bankabstimmung',
        'es': 'Conciliación bancaria', 'fa': 'مغایرت‌گیری بانکی', 'fr': 'Rapprochement bancaire', 'hi': 'बैंक समाधान',
        'id': 'Rekonsiliasi Bank', 'it': 'Riconciliazione bancaria', 'ja': '銀行勘定調整', 'ko': '은행 계정 조정',
        'nl': 'Bankafstemming', 'pl': 'Uzgodnienie bankowe', 'pt': 'Conciliação bancária', 'ru': 'Банковская сверка',
        'tr': 'Banka Mutabakatı', 'uk': 'Банківська звірка', 'ur': 'بینک سے مطابقت پذیری', 'vi': 'Đối chiếu ngân hàng', 'zh': '银行对账'
    },
    'cashFlowForecast': {
        'ar': 'توقعات التدفقات النقدية', 'az': 'Pul axını proqnozu', 'bn': 'ক্যাশ ফ্লো পূর্বাভাস', 'de': 'Liquiditätsvorschau',
        'es': 'Previsión de flujo de caja', 'fa': 'پیش‌بینی جریان وجوه نقد', 'fr': 'Prévision de trésorerie', 'hi': 'नकद प्रवाह पूर्वानुमान',
        'id': 'Prakiraan Arus Kas', 'it': 'Previsione flussi di cassa', 'ja': '資金繰り予測', 'ko': '현금 흐름 예측',
        'nl': 'Kasstroomprognose', 'pl': 'Prognoza przepływów pieniężnych', 'pt': 'Previsão de fluxo de caixa', 'ru': 'Прогноз движения денежных средств',
        'tr': 'Nakit Akışı Tahmini', 'uk': 'Прогноз руху грошових коштів', 'ur': 'نقد کے بہاؤ کی پیشن گوئی', 'vi': 'Dự báo dòng tiền', 'zh': '现金流预测'
    },
    'controlling': {
        'ar': 'إدارة التكاليف والرقابة', 'az': 'Nəzarət və kontrolling', 'bn': 'নিয়ন্ত্রণ', 'de': 'Controlling',
        'es': 'Control de gestión', 'fa': 'کنترلگری و حسابداری مدیریت', 'fr': 'Contrôle de gestion', 'hi': 'नियंत्रण',
        'id': 'Pengendalian Biaya', 'it': 'Controllo di gestione', 'ja': '管理会計', 'ko': '관리 회계',
        'nl': 'Controlling', 'pl': 'Controlling', 'pt': 'Controladoria', 'ru': 'Управленческий учет',
        'tr': 'Maliyet Kontrolü', 'uk': 'Управлінський облік', 'ur': 'کنٹرولنگ', 'vi': 'Kế toán quản trị', 'zh': '控制与预算'
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
    'currenciesFx': {
        'ar': 'العملات وأسعار الصرف', 'az': 'Valyutalar və məzənnələr', 'bn': 'মুদ্রা এবং বিনিময় হার', 'de': 'Währungen & FX',
        'es': 'Monedas y tipos de cambio', 'fa': 'ارزها و نرخ مبادله', 'fr': 'Devises et taux de change', 'hi': 'मुद्राएं और विनिमय दर',
        'id': 'Mata Uang & Kurs', 'it': 'Valute e tassi di cambio', 'ja': '通貨と為替', 'ko': '통화 및 환율',
        'nl': 'Valuta & Wisselkoersen', 'pl': 'Waluty i kursy walutowe', 'pt': 'Moedas e câmbio', 'ru': 'Валюты и курсы валют',
        'tr': 'Para Birimleri ve Dövüz', 'uk': 'Валюти та курси', 'ur': 'کرنسیاں اور تبادلہ', 'vi': 'Tiền tệ & tỷ giá', 'zh': '币种与外汇'
    },
    'accountingPeriods': {
        'ar': 'الفترات المحاسبية', 'az': 'Maliyyə dövrü', 'bn': 'হিসাবরক্ষণ সময়কাল', 'de': 'Buchungsperioden',
        'es': 'Períodos contables', 'fa': 'دوره‌های مالی', 'fr': 'Périodes comptables', 'hi': 'लेखांकन अवधि',
        'id': 'Periode Akuntansi', 'it': 'Periodi contabili', 'ja': '会計期間', 'ko': '회계 기간',
        'nl': 'Boekhoudperioden', 'pl': 'Okresy obrachunkowe', 'pt': 'Períodos contábeis', 'ru': 'Отчетные периоды',
        'tr': 'Muhasebe Dönemleri', 'uk': 'Облікові періоди', 'ur': 'اکاؤنٹنگ ادوار', 'vi': 'Kỳ kế toán', 'zh': '会计期间'
    },
    'reports': {
        'ar': 'التقارير', 'az': 'Hesabatlar', 'bn': 'রিপোর্ট', 'de': 'Berichte',
        'es': 'Informes', 'fa': 'گزارش‌ها', 'fr': 'Rapports', 'hi': 'रिपोर्ट',
        'id': 'Laporan', 'it': 'Report', 'ja': 'レポート', 'ko': '보고서',
        'nl': 'Rapporten', 'pl': 'Raporty', 'pt': 'Relatórios', 'ru': 'Отчетность',
        'tr': 'Raporlar', 'uk': 'Звіти', 'ur': 'رپورٹس', 'vi': 'Báo cáo', 'zh': '报表'
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
    'incomeStatement': {
        'ar': 'قائمة الدخل والأرباح', 'az': 'Mənfəət və zərər hesabatı', 'bn': 'আয় বিবরণী', 'de': 'Gewinn- und Verlustrechnung (GuV)',
        'es': 'Estado de resultados (P&G)', 'fa': 'صورت سود و زیان', 'fr': 'Compte de résultat', 'hi': 'आय विवरण',
        'id': 'Laporan Laba Rugi', 'it': 'Conto economico', 'ja': '損益計算書 (P&L)', 'ko': '손익계산서',
        'nl': 'Winst- en verliesrekening', 'pl': 'Rachunek zysków i strat', 'pt': 'Demonstração do resultado', 'ru': 'Отчет о финансовых результатах',
        'tr': 'Gelir Tablosu (P&L)', 'uk': 'Звіт про фінансові результати', 'ur': 'آمدنی کا گوشوارہ', 'vi': 'Báo cáo kết quả kinh doanh', 'zh': '利润表 (P&L)'
    },
    'agingArAp': {
        'ar': 'تحليل أعمار الديون (AR/AP)', 'az': 'Borcların yaş təhlili', 'bn': 'এজিং রিপোর্ট', 'de': 'Fälligkeitsstruktur (AR/AP)',
        'es': 'Antigüedad de saldos (AR/AP)', 'fa': 'تحلیل سن مطالبات و بدهی‌ها', 'fr': 'Balance âgée (AR/AP)', 'hi': 'एजिंग विश्लेषण',
        'id': 'Analisis Umur Piutang/Hutang', 'it': 'Analisi scadenze (AR/AP)', 'ja': '年齢調書 (売掛・買掛)', 'ko': '연령 분석 (채권/채무)',
        'nl': 'Ouderdomsanalyse (AR/AP)', 'pl': 'Wiekliwość należności i zobowiązań', 'pt': 'Análise de envelhecimento de saldos', 'ru': 'Анализ просрочки (AR/AP)',
        'tr': 'Yaşlandırma Raporu (AR/AP)', 'uk': 'Аналіз дебіторської/кредиторської заборгованості', 'ur': 'عمر کا تجزیہ', 'vi': 'Báo cáo tuổi nợ', 'zh': '账龄分析 (AR/AP)'
    },
    'grIrAging': {
        'ar': 'أعمار حساب تسلم البضائع وتسلم الفواتير (GR/IR)', 'az': 'GR/IR yaş təhlili', 'bn': 'জিআর/আইআর এজিং', 'de': 'GR/IR Abstimmung & Fälligkeit',
        'es': 'Antigüedad GR/IR', 'fa': 'تحلیل اقلام باز حساب GR/IR', 'fr': 'Analyse d\'ancienneté GR/IR', 'hi': 'जीआर/आईआर एजिंग',
        'id': 'Analisis Umur GR/IR', 'it': 'Analisi scadenze GR/IR', 'ja': 'GR/IR 年齢調書', 'ko': 'GR/IR 미정산 연령 분석',
        'nl': 'GR/IR ouderdom', 'pl': 'Wiekliwość rozliczeń GR/IR', 'pt': 'Envelhecimento GR/IR', 'ru': 'Старение неقфактурованных поставок (GR/IR)',
        'tr': 'GR/IR Yaşlandırma Analizi', 'uk': 'Аналіз нефактурованих поставок (GR/IR)', 'ur': 'جی آر/آئی آر رپورٹ', 'vi': 'Báo cáo tuổi nợ GR/IR', 'zh': 'GR/IR 未暂估账龄分析'
    },
    'yearEndCloseWizard': {
        'ar': 'معالج إقفال السنة المالية', 'az': 'İlin sonu bağlanış köməkçisi', 'bn': 'বছরের শেষ বন্ধের উইজার্ড', 'de': 'Jahresabschluss-Assistent',
        'es': 'Asistente de cierre de ejercicio', 'fa': 'دستیار بستن حساب‌های پایان سال', 'fr': 'Assistant de clôture annuelle', 'hi': 'वर्ष-अंत समापन विज़ार्ड',
        'id': 'Wisudawan Penutupan Akhir Tahun', 'it': 'Procedura guidata chiusura esercizio', 'ja': '年度末決算ウィザード', 'ko': '연말 결산 마법사',
        'nl': 'Eindejaarsafsluiting wizard', 'pl': 'Kreator zamknięcia roku', 'pt': 'Assistente de fechamento anual', 'ru': 'Мастер закрытия финансового года',
        'tr': 'Yıl Sonu Kapanış Sihirbazı', 'uk': 'Майстер закриття року', 'ur': 'سال کے اختتام کا مددگار', 'vi': 'Trợ lý khóa sổ cuối năm', 'zh': '年终结账向导'
    },
    'vatReturn': {
        'ar': 'الإقرار الضريبي لضريبة القيمة المضافة', 'az': 'ƏDV bəyannaməsi', 'bn': 'ভ্যাট রিটার্ন', 'de': 'Umsatzsteuer-Voranmeldung',
        'es': 'Declaración de IVA', 'fa': 'اظهارنامه مالیات بر ارزش افزوده', 'fr': 'Déclaration de TVA', 'hi': 'वैट रिटर्न',
        'id': 'SPT PPN', 'it': 'Dichiarazione IVA', 'ja': '消費税申告書', 'ko': '부가세 신고서',
        'nl': 'Btw-aangifte', 'pl': 'Deklaracja VAT', 'pt': 'Declaração de IVA', 'ru': 'Декларация по НДС',
        'tr': 'KDV Beyannamesi', 'uk': 'Декларація з ПДВ', 'ur': 'ویٹ گوشوارہ', 'vi': 'Tờ khai thuế GTGT', 'zh': '增值税申报表'
    },
    'humanResources': {
        'ar': 'الموارد البشرية', 'az': 'İnsan resursları', 'bn': 'মানব সম্পদ', 'de': 'Personalwesen (HR)',
        'es': 'Recursos humanos', 'fa': 'منابع انسانی (HR)', 'fr': 'Ressources humaines', 'hi': 'मानव संसाधन',
        'id': 'Sumber Daya Manusia', 'it': 'Risorse umane', 'ja': '人事 (HR)', 'ko': '인사 (HR)',
        'nl': 'Human Resources', 'pl': 'Zasoby ludzkie (HR)', 'pt': 'Recursos humanos', 'ru': 'Кадры и персонал',
        'tr': 'İnsan Kaynakları', 'uk': 'Кадри та персонал', 'ur': 'انسانی وسائل', 'vi': 'Nhân sự (HR)', 'zh': '人力资源 (HR)'
    },
    'hrPayroll': {
        'ar': 'الموارد البشرية والرواتب', 'az': 'İnsan resursları və əməkhaqqı', 'bn': 'মানব সম্পদ ও বেতন', 'de': 'HR & Lohnabrechnung',
        'es': 'RRHH y nómina', 'fa': 'منابع انسانی و حقوق و دستمزد', 'fr': 'RH et paie', 'hi': 'एचआर और पेरोल',
        'id': 'SDM & Penggajian', 'it': 'RU e paghe', 'ja': '人事・給与計算', 'ko': '인사 및 급여',
        'nl': 'HR & Salarisadministratie', 'pl': 'HR i płace', 'pt': 'RH e folha de pagamento', 'ru': 'Кадры и расчет зарплаты',
        'tr': 'İnsan Kaynakları ve Bordro', 'uk': 'Кадри та зарплата', 'ur': 'ایچ آر اور تنخواہیں', 'vi': 'Nhân sự & tính lương', 'zh': 'HR 与薪酬'
    },
    'employees': {
        'ar': 'الموظفون', 'az': 'Əməkdaşlar', 'bn': 'কর্মচারী', 'de': 'Mitarbeiter',
        'es': 'Empleados', 'fa': 'کارکنان و پرسنل', 'fr': 'Employés', 'hi': 'कर्मचारी',
        'id': 'Karyawan', 'it': 'Dipendenti', 'ja': '従業員', 'ko': '직원',
        'nl': 'Werknemers', 'pl': 'Pracownicy', 'pt': 'Funcionários', 'ru': 'Сотрудники',
        'tr': 'Personel', 'uk': 'Співробітники', 'ur': 'ملازمین', 'vi': 'Nhân viên', 'zh': '员工'
    },
    'leaveAttendance': {
        'ar': 'الإجازات والحضور', 'az': 'Məzuniyyət və davamiyyət', 'bn': 'ছুটি ও উপস্থিতি', 'de': 'Urlaub & Zeiterfassung',
        'es': 'Vacaciones y asistencia', 'fa': 'مرخصی و حضور و غیاب', 'fr': 'Congés et présences', 'hi': 'छुट्टी और उपस्थिति',
        'id': 'Cutik & Kehadiran', 'it': 'Ferie e presenze', 'ja': '休暇・出退勤', 'ko': '휴가 및 근태',
        'nl': 'Verlof & Verzuim', 'pl': 'Urlopy i obecności', 'pt': 'Licenças e frequência', 'ru': 'Отпуска и учет рабочего времени',
        'tr': 'İzin ve Devam Takibi', 'uk': 'Відпустки та облік часу', 'ur': 'رخصت اور حاضری', 'vi': 'Nghỉ phép & điểm danh', 'zh': '休假与考勤'
    },
    'payroll': {
        'ar': 'كشف الرواتب', 'az': 'Əməkhaqqı', 'bn': 'পে-রোল', 'de': 'Entgeltabrechnung',
        'es': 'Nóminas', 'fa': 'حقوق و دستمزد', 'fr': 'Paie', 'hi': 'पेरोल',
        'id': 'Penggajian', 'it': 'Paghe e contributi', 'ja': '給与計算', 'ko': '급여 관리',
        'nl': 'Salarisadministratie', 'pl': 'Listy płac', 'pt': 'Folha de pagamento', 'ru': 'Расчет заработной платы',
        'tr': 'Bordro İşlemleri', 'uk': 'Розрахунок заробітної плати', 'ur': 'پے رول', 'vi': 'Bảng lương', 'zh': '薪酬管理'
    },
    'intelligence': {
        'ar': 'الذكاء الاصطناعي والتحليلات', 'az': 'Intellekt və Analitika', 'bn': 'ইনটেলিজেন্স', 'de': 'Analytics & KI',
        'es': 'Inteligencia de negocio', 'fa': 'هوشمندی و تحلیل', 'fr': 'Business Intelligence & IA', 'hi': 'इंटेलीजेंस',
        'id': 'Intelijen & Analitik', 'it': 'Intelligence & IA', 'ja': 'インテリジェンス', 'ko': '인텔리전스',
        'nl': 'Intelligence & AI', 'pl': 'Analityka i AI', 'pt': 'Inteligência e IA', 'ru': 'Аналитика и ИИ',
        'tr': 'Zeka ve Analitik', 'uk': 'Аналітика та ШІ', 'ur': 'انٹیلی جنس', 'vi': 'Trí tuệ & phân tích', 'zh': '智能与 BI'
    },
    'reporting': {
        'ar': 'إعداد التقارير', 'az': 'Hesabatlıq', 'bn': 'রিপোর্টিং', 'de': 'Berichtswesen',
        'es': 'Informes y BI', 'fa': 'گزارش‌گیری', 'fr': 'Reporting', 'hi': 'रिपोर्टिंग',
        'id': 'Pelaporan', 'it': 'Reportistica', 'ja': 'レポーティング', 'ko': '리포팅',
        'nl': 'Rapportages', 'pl': 'Raportowanie', 'pt': 'Relatórios e BI', 'ru': 'Система отчетов',
        'tr': 'Raporlama', 'uk': 'Звітність', 'ur': 'رپورٹنگ', 'vi': 'Báo cáo tổng hợp', 'zh': '报表中心'
    },
    'allReports': {
        'ar': 'جميع التقارير', 'az': 'Bütün hesabatlar', 'bn': 'সমস্ত রিপোর্ট', 'de': 'Alle Berichte',
        'es': 'Todos los informes', 'fa': 'همه گزارش‌ها', 'fr': 'Tous les rapports', 'hi': 'सभी रिपोर्ट',
        'id': 'Semua Laporan', 'it': 'Tutti i report', 'ja': 'すべてのレポート', 'ko': '모든 보고서',
        'nl': 'Alle rapporten', 'pl': 'Wszystkie raporty', 'pt': 'Todos os relatórios', 'ru': 'Все отчеты',
        'tr': 'Tüm Raporlar', 'uk': 'Усі звіти', 'ur': 'تمام رپورٹس', 'vi': 'Tất cả báo cáo', 'zh': '所有报表'
    },
    'dashboards': {
        'ar': 'لوحات المعلومات', 'az': 'İnformasiya panelləri', 'bn': 'ড্যাশবোর্ডসমূহ', 'de': 'Dashboards',
        'es': 'Paneles de mando', 'fa': 'داشبوردهای مدیریتی', 'fr': 'Tableaux de bord', 'hi': 'डैशबोर्ड्स',
        'id': 'Dasbor Analitik', 'it': 'Dashboard analitiche', 'ja': 'ダッシュボード一覧', 'ko': '대시보드 목록',
        'nl': 'Dashboards', 'pl': 'Pulpity menedżerskie', 'pt': 'Painéis de controle', 'ru': 'Дашборды',
        'tr': 'Gösterge Panelleri', 'uk': 'Дашборди', 'ur': 'ڈیش بورڈز', 'vi': 'Các bảng điều khiển', 'zh': '仪表板集'
    },
    'scheduledReports': {
        'ar': 'التقارير المجدولة', 'az': 'Planlaşdırılmış hesabatlar', 'bn': 'নির্ধারিত রিপোর্ট', 'de': 'Geplante Berichte',
        'es': 'Informes programados', 'fa': 'گزارش‌های زمان‌بندی‌شده', 'fr': 'Rapports programmés', 'hi': 'अनुसूचित रिपोर्ट',
        'id': 'Laporan Terjadwal', 'it': 'Report pianificati', 'ja': 'スケジュールレポート', 'ko': '예약된 보고서',
        'nl': 'Geplande rapporten', 'pl': 'Zaplanowane raporty', 'pt': 'Relatórios agendados', 'ru': 'Запланированные отчеты',
        'tr': 'Zamanlanmış Raporlar', 'uk': 'Заплановані звіти', 'ur': 'شیڈول شدہ رپورٹس', 'vi': 'Báo cáo theo lịch', 'zh': '定时报表'
    },
    'qiraAi': {
        'ar': 'الذكاء الاصطناعي Simeli AI', 'az': 'Simeli AI İntellekt', 'bn': 'Simeli এআই', 'de': 'Simeli KI-Assistent',
        'es': 'Simeli IA', 'fa': 'هوش مصنوعی Simeli AI', 'fr': 'IA Simeli', 'hi': 'Simeli एआई',
        'id': 'Simeli AI', 'it': 'Simeli IA', 'ja': 'Simeli AI', 'ko': 'Simeli AI',
        'nl': 'Simeli AI', 'pl': 'Simeli AI', 'pt': 'Simeli IA', 'ru': 'Simeli ИИ-помощник',
        'tr': 'Simeli AI Yapay Zeka', 'uk': 'Simeli ШІ-помічник', 'ur': 'Simeli اے آئی', 'vi': 'Simeli AI', 'zh': 'Simeli AI 助手'
    },
    'aiChat': {
        'ar': 'محادثة الذكاء الاصطناعي', 'az': 'Süni intellekt çatı', 'bn': 'এআই চ্যাট', 'de': 'KI-Chat',
        'es': 'Chat de IA', 'fa': 'چت با هوش مصنوعی', 'fr': 'Chat IA', 'hi': 'एआई चैट',
        'id': 'Obrolan AI', 'it': 'Chat IA', 'ja': 'AI チャット', 'ko': 'AI 챗',
        'nl': 'AI Chat', 'pl': 'Czat z AI', 'pt': 'Chat com IA', 'ru': 'Чат с ИИ',
        'tr': 'AI Sohbet', 'uk': 'Чат з ШІ', 'ur': 'اے آئی چیٹ', 'vi': 'Trò chuyện AI', 'zh': 'AI 对话'
    },
    'businessIntelligence': {
        'ar': 'ذكاء الأعمال (BI)', 'az': 'Biznes intellekti (BI)', 'bn': 'বিজনেস ইন্টেলিজেন্স', 'de': 'Business Intelligence (BI)',
        'es': 'Inteligencia empresarial (BI)', 'fa': 'هوشمندی کسب‌وکار (BI)', 'fr': 'Informatique décisionnelle (BI)', 'hi': 'बिजनेस इंटेलिजेंस',
        'id': 'Intelijen Bisnis (BI)', 'it': 'Business Intelligence (BI)', 'ja': 'ビジネスインテリジェンス (BI)', 'ko': '비즈니스 인텔리전스 (BI)',
        'nl': 'Business Intelligence (BI)', 'pl': 'Business Intelligence (BI)', 'pt': 'Inteligência de negócios (BI)', 'ru': 'Бизнес-аналитика (BI)',
        'tr': 'İş Zekası (BI)', 'uk': 'Бізнес-аналітика (BI)', 'ur': 'بزنس انٹیلی جنس', 'vi': 'Trí tuệ kinh doanh (BI)', 'zh': '商业智能 (BI)'
    },
    'transactionAnalysis': {
        'ar': 'تحليل المعاملات', 'az': 'Əməliyyat analizi', 'bn': 'লেনদেন বিশ্লেষণ', 'de': 'Transaktionsanalyse',
        'es': 'Análisis de transacciones', 'fa': 'تحلیل تراکنش‌ها', 'fr': 'Analyse des transactions', 'hi': 'लेन-देन विश्लेषण',
        'id': 'Analisis Transaksi', 'it': 'Analisi delle transazioni', 'ja': '取引アナリティクス', 'ko': '트랜잭션 분석',
        'nl': 'Transactie-analyse', 'pl': 'Analiza transakcji', 'pt': 'Análise de transações', 'ru': 'Анализ транзакций',
        'tr': 'İşlem Analizi', 'uk': 'Аналіз транзакцій', 'ur': 'لین دین کا تجزیہ', 'vi': 'Phân tích giao dịch', 'zh': '交易分析'
    },
    'aiAnomalyResolution': {
        'ar': 'معالجة الشذوذ بالذكاء الاصطناعي', 'az': 'AI anomaliyaların həlli', 'bn': 'এআই অসঙ্গতি সমাধান', 'de': 'KI-Anomaliebehebung',
        'es': 'Resolución de anomalías con IA', 'fa': 'برطرف‌سازی ناهنجاری‌ها با هوش مصنوعی', 'fr': 'Résolution d\'anomalies par IA', 'hi': 'एआई विसंगति समाधान',
        'id': 'Resolusi Anomali AI', 'it': 'Risoluzione anomalie IA', 'ja': 'AI 異常検知と解決', 'ko': 'AI 이상 탐지 해결',
        'nl': 'AI Anomaliedetectie & Oplossing', 'pl': 'Rozwiązywanie anomalii przez AI', 'pt': 'Resolução de anomalias com IA', 'ru': 'Устранение аномалий с помощью ИИ',
        'tr': 'AI Anomali Çözümü', 'uk': 'Усунення аномалій за допомогою ШІ', 'ur': 'اے آئی غیر معمولی حل', 'vi': 'Xử lý bất thường AI', 'zh': 'AI 异常处理'
    },
    'autonomousAgents': {
        'ar': 'الوكلاء المستقلون', 'az': 'Avtonom agentlər', 'bn': 'স্বায়ত্তশাসিত এজেন্ট', 'de': 'Autonome KI-Agenten',
        'es': 'Agentes autónomos', 'fa': 'عامل‌های خودکار', 'fr': 'Agents autonomes', 'hi': 'स्वायत्त एजेंट',
        'id': 'Agen Otonom', 'it': 'Agenti autonomi', 'ja': '自律型 AI エージェント', 'ko': '자율형 AI 에이전트',
        'nl': 'Autonome agenten', 'pl': 'Autonomiczne agenty AI', 'pt': 'Agentes autônomos', 'ru': 'Автономные ИИ-агенты',
        'tr': 'Otonom AI Ajanları', 'uk': 'Автономні ШІ-агенти', 'ur': 'خودکار ایجنٹس', 'vi': 'Tác nhân tự động', 'zh': '自主 AI 代理'
    },
    'buildAnAgent': {
        'ar': 'بناء وكيل ذكي', 'az': 'Agent yarat', 'bn': 'একটি এজেন্ট তৈরি করুন', 'de': 'KI-Agent erstellen',
        'es': 'Crear un agente de IA', 'fa': 'ساخت عامل هوشمند', 'fr': 'Créer un agent IA', 'hi': 'एक एजेंट बनाएं',
        'id': 'Buat Agen AI', 'it': 'Crea un agente IA', 'ja': 'エージェント構築', 'ko': 'AI 에이전트 생성',
        'nl': 'AI-agent bouwen', 'pl': 'Stwórz agenta AI', 'pt': 'Criar um agente de IA', 'ru': 'Конструктор ИИ-агентов',
        'tr': 'AI Ajanı Oluştur', 'uk': 'Конструктор ШІ-агентів', 'ur': 'ایجنٹ بنائیں', 'vi': 'Tạo tác nhân AI', 'zh': '构建 AI 代理'
    },
    'toolLibrary': {
        'ar': 'مكتبة أدوات الذكاء الاصطناعي', 'az': 'Aletlərlə kitabxana', 'bn': 'টুল লাইব্রেরি', 'de': 'Werkzeug-Bibliothek',
        'es': 'Biblioteca de herramientas', 'fa': 'کتابخانه ابزارها', 'fr': 'Bibliothèque d\'outils', 'hi': 'टूल लाइब्रेरी',
        'id': 'Pustaka Alat AI', 'it': 'Libreria strumenti', 'ja': 'ツールライブラリ', 'ko': '툴 라이브러리',
        'nl': 'Tool-bibliotheek', 'pl': 'Biblioteka narzędzi', 'pt': 'Biblioteca de ferramentas', 'ru': 'Библиотека инструментов',
        'tr': 'Araç Kütüphanesi', 'uk': 'Бібліотека інструментів', 'ur': 'ٹول لائبریری', 'vi': 'Thư viện công cụ', 'zh': '工具库'
    },
    'documentsTemplates': {
        'ar': 'المستندات والقوالب', 'az': 'Sənədlər və şablonlar', 'bn': 'নথি এবং টেমপ্লেট', 'de': 'Dokumente & Vorlagen',
        'es': 'Documentos y plantillas', 'fa': 'اسناد و قالب‌ها', 'fr': 'Documents et modèles', 'hi': 'दस्तावेज़ और टेम्प्लेट',
        'id': 'Dokumen & Templat', 'it': 'Documenti e modelli', 'ja': 'ドキュメントとテンプレート', 'ko': '문서 및 템플릿',
        'nl': 'Documenten & Sjablonen', 'pl': 'Dokumenty i szablony', 'pt': 'Documentos e modelos', 'ru': 'Документы и шаблоны',
        'tr': 'Belgeler ve Şablonlar', 'uk': 'Документи та шаблони', 'ur': 'دستاویزات اور ٹیمپلیٹس', 'vi': 'Tài liệu & mẫu', 'zh': '文档与 Sam 模板'
    },
    'knowledgeBase': {
        'ar': 'قاعدة المعرفة', 'az': 'Bilik bazası', 'bn': 'জ্ঞান ভান্ডার', 'de': 'Wissensdatenbank',
        'es': 'Base de conocimientos', 'fa': 'پایگاه دانش', 'fr': 'Base de connaissances', 'hi': 'ज्ञान आधार',
        'id': 'Basis Pengetahuan', 'it': 'Base di conoscenza', 'ja': 'ナレッジベース', 'ko': '지식 베이스',
        'nl': 'Kennisbank', 'pl': 'Baza wiedzy', 'pt': 'Base de conhecimento', 'ru': 'База знаний',
        'tr': 'Bilgi Bankası', 'uk': 'База знань', 'ur': 'نالج بیس', 'vi': 'Cơ sở tri thức', 'zh': '知识库'
    },
    'aiGovernance': {
        'ar': 'حوكمة الذكاء الاصطناعي', 'az': 'AI idarəçiliyi', 'bn': 'এআই গভর্ন্যান্স', 'de': 'KI-Governance',
        'es': 'Gobernanza de IA', 'fa': 'حکمرانی هوش مصنوعی', 'fr': 'Gouvernance de l\'IA', 'hi': 'एआई शासन',
        'id': 'Tata Kelola AI', 'it': 'Governance dell\'IA', 'ja': 'AI ガバナンス', 'ko': 'AI 거버넌스',
        'nl': 'AI Governance', 'pl': 'Nadzór nad AI (Governance)', 'pt': 'Governança de IA', 'ru': 'Управление и аудит ИИ',
        'tr': 'Yapay Zeka Yönetişimi', 'uk': 'Управління ШІ', 'ur': 'اے آئی گورننس', 'vi': 'Quản trị AI', 'zh': 'AI 治理'
    },
    'aiSettings': {
        'ar': 'إعدادات الذكاء الاصطناعي', 'az': 'AI tənzimləmələri', 'bn': 'এআই সেটিংস', 'de': 'KI-Einstellungen',
        'es': 'Configuración de IA', 'fa': 'تنظیمات هوش مصنوعی', 'fr': 'Paramètres de l\'IA', 'hi': 'एआई सेटिंग्स',
        'id': 'Pengaturan AI', 'it': 'Impostazioni IA', 'ja': 'AI 設定', 'ko': 'AI 설정',
        'nl': 'AI Instellingen', 'pl': 'Ustawienia AI', 'pt': 'Configurações de IA', 'ru': 'Настройки ИИ',
        'tr': 'AI Ayarları', 'uk': 'Налаштування ШІ', 'ur': 'اے آئی ترتیبات', 'vi': 'Cài đặt AI', 'zh': 'AI 设置'
    },
    'governance': {
        'ar': 'الحوكمة والتدقيق', 'az': 'İdarəetmə və Auditing', 'bn': 'গভর্ন্যান্স', 'de': 'Governance & Audit',
        'es': 'Gobernanza y auditoría', 'fa': 'حکمرانی و نظارت', 'fr': 'Gouvernance et audit', 'hi': 'शासन',
        'id': 'Tata Kelola & Audit', 'it': 'Governance e audit', 'ja': 'ガバナンスと監査', 'ko': '거버넌스',
        'nl': 'Governance & Controle', 'pl': 'Nadzór i audyt', 'pt': 'Governança e auditoria', 'ru': 'Управление و контроль',
        'tr': 'Yönetişim ve Denetim', 'uk': 'Управління та аудит', 'ur': 'گورننس', 'vi': 'Quản trị & kiểm toán', 'zh': '治理与审计'
    },
    'delegationOfAuthority': {
        'ar': 'تفويض السلطات (DOA)', 'az': 'Səlahiyyətlərin həvalə edilməsi', 'bn': 'ক্ষমতা হস্তান্তর (DOA)', 'de': 'Delegation of Authority (DoA)',
        'es': 'Delegación de autoridad (DoA)', 'fa': 'تفویض اختیارات (DOA)', 'fr': 'Délégation de pouvoir (DoA)', 'hi': 'अधिकारों का प्रत्यायोजन',
        'id': 'Delegasi Wewenang (DoA)', 'it': 'Delega di autorità (DoA)', 'ja': '職務権限規程 (DOA)', 'ko': '위임 전결 규정 (DOA)',
        'nl': 'Bevoegdheidsdelegatie (DoA)', 'pl': 'Delegacja uprawnień (DoA)', 'pt': 'Delegação de autoridade (DoA)', 'ru': 'Делегирование полномочий (DoA)',
        'tr': 'Yetki Devri (DOA)', 'uk': 'Делегування повноважень (DoA)', 'ur': 'اختیارات کی تفویض', 'vi': 'Phân cấp thẩm quyền (DoA)', 'zh': '授权委托 (DOA)'
    },
    'doaManagement': {
        'ar': 'إدارة تفويض السلطات', 'az': 'DoA idarəetməsi', 'bn': 'ডিএও ব্যবস্থাপনা', 'de': 'DoA-Verwaltung',
        'es': 'Gestión de matriz DoA', 'fa': 'مدیریت تفویض اختیارات', 'fr': 'Gestion de la DoA', 'hi': 'डीओए प्रबंधन',
        'id': 'Manajemen DoA', 'it': 'Gestione DoA', 'ja': 'DOA 管理マトリクス', 'ko': 'DOA 관리',
        'nl': 'DoA-beheer', 'pl': 'Zarządzanie macierzą DoA', 'pt': 'Gestão de matriz DoA', 'ru': 'Управление матрицей DoA',
        'tr': 'DOA Yönetim Paneli', 'uk': 'Управління матрицею DoA', 'ur': 'ڈی او اے انتظامیہ', 'vi': 'Quản lý DoA', 'zh': 'DOA 矩阵管理'
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
    'auditTrail': {
        'ar': 'سجل التدقيق والمراجعة', 'az': 'Audit izi', 'bn': 'অডিট ট্রেইল', 'de': 'Audit-Trail / Protokoll',
        'es': 'Pista de auditoría', 'fa': 'ردپای ممیزی و رویدادها', 'fr': 'Piste d\'audit', 'hi': 'ऑडिट ट्रेल',
        'id': 'Jejak Audit', 'it': 'Registro di audit', 'ja': '監査ログ', 'ko': '감사 추적',
        'nl': 'Audit-trail', 'pl': 'Ścieżka audytu', 'pt': 'Trilha de auditoria', 'ru': 'Журнал аудита событий',
        'tr': 'Denetim İzi (Audit Trail)', 'uk': 'Журнал аудиту', 'ur': 'آڈٹ ٹریل', 'vi': 'Lịch sử kiểm toán', 'zh': '审计追踪'
    },
    'administration': {
        'ar': 'الإدارة والإعدادات العامة', 'az': 'İnzibatçılıq', 'bn': 'প্রশাসন', 'de': 'Systemadministration',
        'es': 'Administración del sistema', 'fa': 'مدیریت سیستم', 'fr': 'Administration', 'hi': 'प्रशासन',
        'id': 'Administrasi Sistem', 'it': 'Amministrazione', 'ja': 'システム管理', 'ko': '시스템 관리',
        'nl': 'Systeembeheer', 'pl': 'Administracja', 'pt': 'Administração do sistema', 'ru': 'Администрирование',
        'tr': 'Sistem Yönetimi', 'uk': 'Адміністрування', 'ur': 'انتظامیہ', 'vi': 'Quản trị hệ thống', 'zh': '系统管理'
    },
    'admin': {
        'ar': 'المسؤول', 'az': 'İnziçi', 'bn': 'এডমিন', 'de': 'Admin',
        'es': 'Administración', 'fa': 'مدیر ارشد', 'fr': 'Admin', 'hi': 'एडमिन',
        'id': 'Admin', 'it': 'Admin', 'ja': '管理者', 'ko': '관리자',
        'nl': 'Admin', 'pl': 'Admin', 'pt': 'Administrador', 'ru': 'Админ',
        'tr': 'Yönetici', 'uk': 'Адмін', 'ur': 'ایڈمن', 'vi': 'Quản trị viên', 'zh': '管理员'
    },
    'userManagement': {
        'ar': 'إدارة المستخدمين والأدوار', 'az': 'İstifadəçi idarəetməsi', 'bn': 'ব্যবহারকারী ব্যবস্থাপনা', 'de': 'Benutzerverwaltung',
        'es': 'Gestión de usuarios', 'fa': 'مدیریت کاربران و دسترسی‌ها', 'fr': 'Gestion des utilisateurs', 'hi': 'उपयोगकर्ता प्रबंधन',
        'id': 'Manajemen Pengguna', 'it': 'Gestione utenti', 'ja': 'ユーザー管理', 'ko': '사용자 관리',
        'nl': 'Gebruikersbeheer', 'pl': 'Zarządzanie użytkownikami', 'pt': 'Gestão de usuários', 'ru': 'Управление пользователями',
        'tr': 'Kullanıcı Yönetimi', 'uk': 'Управління користувачами', 'ur': 'صارفین کا انتظام', 'vi': 'Quản lý người dùng', 'zh': '用户管理'
    },
    'saasPlanBilling': {
        'ar': 'خطط SaaS والاشتراكات', 'az': 'SaaS planı və ödənişlər', 'bn': 'SaaS প্ল্যান এবং বিলিং', 'de': 'SaaS-Paket & Abrechnung',
        'es': 'Plan SaaS y facturación', 'fa': 'طرح اشتراک و صورتحساب', 'fr': 'Offre SaaS et facturation', 'hi': 'सास प्लान और बिलिंग',
        'id': 'Paket SaaS & Tagihan', 'it': 'Piano SaaS e fatturazione', 'ja': 'SaaS プランと請求', 'ko': 'SaaS 요금제 및 청구',
        'nl': 'SaaS-abonnement & Facturatie', 'pl': 'Plan SaaS i rozliczenia', 'pt': 'Plano SaaS e faturamento', 'ru': 'Тарифный план SaaS и счета',
        'tr': 'SaaS Planı ve Fatura', 'uk': 'Тарифний план SaaS і рахунки', 'ur': 'ایس اے اے ایس پلان', 'vi': 'Gói SaaS & thanh toán', 'zh': 'SaaS 套餐与账单'
    },
    'integrations': {
        'ar': 'التكامل والربط البرمجي', 'az': 'Inteqrasiyalar', 'bn': 'ইন্টিগ্রেশন', 'de': 'Integrationen & Schnittstellen',
        'es': 'Integraciones con API', 'fa': 'یکپارچه‌سازی‌ها', 'fr': 'Intégrations', 'hi': 'एकीकरण',
        'id': 'Integrasi Sistem', 'it': 'Integrazioni', 'ja': 'API 連携とインtegration', 'ko': '연동 및 연계',
        'nl': 'Integraties', 'pl': 'Integracje systemowe', 'pt': 'Integrações', 'ru': 'Интеграции и API',
        'tr': 'Entegrasyonlar', 'uk': 'Інтеграції', 'ur': 'انٹیگریشنز', 'vi': 'Tích hợp hệ thống', 'zh': 'API 集成'
    },
    'modules': {
        'ar': 'وحدات النظام وتفعيلها', 'az': 'Modullar', 'bn': 'মডিউল', 'de': 'Systemmodule',
        'es': 'Módulos del ERP', 'fa': 'ماژول‌های سیستم', 'fr': 'Modules', 'hi': 'मॉड्यूल',
        'id': 'Modul Sistem', 'it': 'Moduli', 'ja': '機能モジュール', 'ko': '모듈 관리',
        'nl': 'Systeemmodules', 'pl': 'Moduły systemu', 'pt': 'Módulos', 'ru': 'Модули системы',
        'tr': 'Sistem Modülleri', 'uk': 'Модулі системи', 'ur': 'ماڈیولز', 'vi': 'Các phân hệ (Modules)', 'zh': '系统模块'
    }
}

# Complete translations for Dashboard components and cards
UI_MAP = {
    'revenue': {
        'ar': 'إجمالي الإيرادات', 'az': 'Ümumi gəlir', 'bn': 'মোট রাজস্ব', 'de': 'Gesamtertrag',
        'es': 'Ingresos totales', 'fa': 'کل درآمدها', 'fr': 'Chiffre d\'affaires', 'hi': 'कुल राजस्व',
        'id': 'Total Pendapatan', 'it': 'Ricavi totali', 'ja': '売上高', 'ko': '총 매출',
        'nl': 'Totale omzet', 'pl': 'Przychody ogółem', 'pt': 'Receita total', 'ru': 'Выручка',
        'tr': 'Toplam Gelir', 'uk': 'Загальний дохід', 'ur': 'کل آمدنی', 'vi': 'Tổng doanh thu', 'zh': '总收入'
    },
    'netIncome': {
        'ar': 'صافي الدخل', 'az': 'Xalis mənfəət', 'bn': 'নিল আয়', 'de': 'Jahresüberschuss',
        'es': 'Beneficio neto', 'fa': 'سود خالص', 'fr': 'Résultat net', 'hi': 'शुद्ध आय',
        'id': 'Laba Bersih', 'it': 'Utile netto', 'ja': '当期純利益', 'ko': '당기순이익',
        'nl': 'Nettowinst', 'pl': 'Zysk netto', 'pt': 'Lucro líquido', 'ru': 'Чистая прибыль',
        'tr': 'Net Kar', 'uk': 'Чистий прибуток', 'ur': 'خالص آمدنی', 'vi': 'Lợi nhuận ròng', 'zh': '净利润'
    },
    'arOutstanding': {
        'ar': 'مستحقات الحسابات المدينة', 'az': 'Müştəri borcu balansı', 'bn': 'প্রাপ্য বকেয়া', 'de': 'Offene Forderungen',
        'es': 'Cuentas por cobrar pendientes', 'fa': 'مطالبات معوق دریافتنی', 'fr': 'Encours clients (AR)', 'hi': 'प्राप्य बकाया',
        'id': 'Piutang Belum Lunas', 'it': 'Crediti da incassare', 'ja': '売掛金残高', 'ko': '미수 채권 잔액',
        'nl': 'Openstaande debiteuren', 'pl': 'Należności nieopłacone', 'pt': 'Contas a receber pendentes', 'ru': 'Неоплаченные счета покупателей',
        'tr': 'Tahsil Edilecek Alacaklar', 'uk': 'Неоплачені рахунки покупців', 'ur': 'قابل وصول بقایا', 'vi': 'Nợ phải thu chưa trả', 'zh': '未收应收账款'
    },
    'overdue': {
        'ar': 'متأخرة عن موعدها', 'az': 'Gecikdirilmiş', 'bn': 'মেয়াদোত্তীর্ণ', 'de': 'überfällig',
        'es': 'vencido', 'fa': 'سررسید گذشته', 'fr': 'en retard', 'hi': 'बकाया',
        'id': 'terlambat', 'it': 'scaduto', 'ja': '期日超過', 'ko': '연체됨',
        'nl': 'vervallen', 'pl': 'zaległe', 'pt': 'vencido', 'ru': 'просрочено',
        'tr': 'gecikmiş', 'uk': 'прострочено', 'ur': 'میعاد ختم', 'vi': 'quá hạn', 'zh': '逾期'
    },
    'inventoryValue': {
        'ar': 'قيمة المخزون', 'az': 'Maddiyyatın ümumi dəyəri', 'bn': 'ইনভেন্টরি মান', 'de': 'Gesamter Lagerwert',
        'es': 'Valor del inventario', 'fa': 'ارزش کل موجودی انبار', 'fr': 'Valeur du stock', 'hi': 'इन्वेंटरी मूल्य',
        'id': 'Nilai Total Inventaris', 'it': 'Valore totale del magazzino', 'ja': '在庫評価額', 'ko': '총 재고 평가액',
        'nl': 'Totale voorraadwaarde', 'pl': 'Wartość zapasów', 'pt': 'Valor total do estoque', 'ru': 'Общая стоимость товарных запасов',
        'tr': 'Toplam Stok Değeri', 'uk': 'Загальна вартість товарних запасів', 'ur': 'انوینٹری کی قیمت', 'vi': 'Giá trị tồn kho', 'zh': '库存总价值'
    },
    'belowReorderPoint': {
        'ar': 'أقل من حد إعادة الطلب', 'az': 'Yenidən sifariş nöqtəsindən aşağı', 'bn': 'পুনরায় অর্ডারের সীমার নিচে', 'de': 'unter Nachbestellpunkt',
        'es': 'por debajo del punto de pedido', 'fa': 'کمتر از نقطه سفارش مجدد', 'fr': 'sous le seuil de réapprovisionnement', 'hi': 'पुनः ऑर्डर बिंदु से नीचे',
        'id': 'di bawah batas pemesanan ulang', 'it': 'sotto il punto di riordino', 'ja': '発注点未満', 'ko': '재발주 จุด 미만',
        'nl': 'onder herbestelpunt', 'pl': 'poniżej punktu zamawiania', 'pt': 'abaixo do ponto de reabastecimento', 'ru': 'ниже точки перезаказа',
        'tr': 'sipariş verme noktasının altında', 'uk': 'нижче точки перезамовлення', 'ur': 'دوبارہ آرڈر سے کم', 'vi': 'dưới điểm đặt hàng lại', 'zh': '低于再订货点'
    },
    'openWorkOrders': {
        'ar': 'أوامر التصنيع المفتوحة', 'az': 'Açıq istehsalat tapşırıqları', 'bn': 'খোলা কাজের আদেশ', 'de': 'Offene Fertigungsaufträge',
        'es': 'Órdenes de trabajo abiertas', 'fa': 'دستورات کاری در حال اجرا', 'fr': 'Ordres de fabrication ouverts', 'hi': 'खुले कार्य आदेश',
        'id': 'Perintah Kerja Aktif', 'it': 'Ordini di lavoro aperti', 'ja': '未完了の製造指示', 'ko': '진행 중인 작업 지시서',
        'nl': 'Openstaande werkorders', 'pl': 'Otwarte zlecenia produkcyjne', 'pt': 'Ordens de serviço abertas', 'ru': 'Открытые заказы на производство',
        'tr': 'Açık Üretim Emirleri', 'uk': 'Відкриті замовлення на виробництво', 'ur': 'کھلے کام کے آرڈرز', 'vi': 'Lệnh sản xuất đang mở', 'zh': '未结生产工单'
    },
    'openDeals': {
        'ar': 'الصرفات الجارية', 'az': 'Açıq sövdələşmələr', 'bn': 'খোলা ডিল', 'de': 'Offene Verkaufschancen',
        'es': 'Operaciones abiertas', 'fa': 'معاملات در حال جریان', 'fr': 'Affaires en cours', 'hi': 'खुले सौदे',
        'id': 'Peluang Penjualan Aktif', 'it': 'Opportunità aperte', 'ja': '進行中の商談', 'ko': '진행 중인 딜',
        'nl': 'Openstaande deals', 'pl': 'Otwarte szanse sprzedaży', 'pt': 'Oportunidades abertas', 'ru': 'Активные сделки в воронке',
        'tr': 'Açık Fırsatlar', 'uk': 'Активні угоди', 'ur': 'کھلی ڈیلز', 'vi': 'Cơ hội kinh doanh đang mở', 'zh': '进行中商談'
    },
    'weighted': {
        'ar': 'موزونة بالحجم', 'az': 'Çəkili', 'bn': 'ওয়েটেড', 'de': 'gewichtet',
        'es': 'ponderado', 'fa': 'وزن‌دار شده', 'fr': 'pondéré', 'hi': 'भारित',
        'id': 'terbobot', 'it': 'ponderato', 'ja': '加重評価', 'ko': '가중치 적용됨',
        'nl': 'gewogen', 'pl': 'ważona', 'pt': 'ponderado', 'ru': 'взвешенная ارزش',
        'tr': 'ağırlıklı', 'uk': 'зважена вартість', 'ur': 'وزنی', 'vi': 'trọng số', 'zh': '加权预计金额'
    },
    'headcount': {
        'ar': 'إجمالي عدد الموظفين', 'az': 'İşçi sayı', 'bn': 'মোট কর্মী সংখ্যা', 'de': 'Mitarbeiterzahl (Headcount)',
        'es': 'Plantilla de empleados', 'fa': 'تعداد پرسنل فعال', 'fr': 'Effectif des employés', 'hi': 'कुल कर्मचारी संख्या',
        'id': 'Jumlah Karyawan Aktif', 'it': 'Organico dipendenti', 'ja': '従業員数', 'ko': '총 임직원 수',
        'nl': 'Personeelsbestand', 'pl': 'Liczba pracowników', 'pt': 'Quadro de funcionários', 'ru': 'Численность штата',
        'tr': 'Toplam Personel Sayısı', 'uk': 'Штатна чисельність', 'ur': 'کل ملازمین', 'vi': 'Tổng số nhân viên', 'zh': '在职员工人数'
    },
    'financialOperationalAndCommercialPositionAt': {
        'ar': 'الوضع المالي والتشغيلي والتجاري للمؤسسة في لمحة سريعة.',
        'az': 'Müəssisənin maliyyə, əməliyyat və kommersiya vəziyyətinin icmalı.',
        'bn': 'এক নজরে ব্যবসায়িক, আর্থিক ও অর্থনৈতিক পরিস্থিতি।',
        'de': 'Finanzielle, operative und kommerzielle Lage auf einen Blick.',
        'es': 'Posición financiera, operativa y comercial de un vistazo.',
        'fa': 'وضعیت مالی، عملیاتی و تجاری شرکت در یک نگاه.',
        'fr': 'Position financière, opérationnelle et commerciale en un coup d\'œil.',
        'hi': 'एक नजर में वित्तीय, परिचालन और व्यावसायिक स्थिति।',
        'id': 'Posisi keuangan, operasional, dan komersial dalam sekilas.',
        'it': 'Posizione finanziaria, operativa e commerciale in sintesi.',
        'ja': '財務・業務・営業の現況一覧。',
        'ko': '한눈에 보는 재무, 운영 및 영업 현황.',
        'nl': 'Financiële, operationele en commerciële status in één oogopslag.',
        'pl': 'Przegląd sytuacji finansowej, operacyjnej i handlowej.',
        'pt': 'Visão geral da posição financeira, operacional e comercial.',
        'ru': 'Сводный финансовый, операционный и коммерческий статус предприятия.',
        'tr': 'Bir bakışta finansal, operasyonel ve ticari durum.',
        'uk': 'Сводний фінансовий, операційний та комерційний стан підприємства.',
        'ur': 'ایک نظر میں مالیاتی، آپریشنل اور تجارتی صورتحال۔',
        'vi': 'Tổng quan tình hình tài chính, vận hành và thương mại.',
        'zh': '一览企业的财务、运营及商业状况。'
    },
    'quickActions': {
        'ar': 'الإجراءات السريعة', 'az': 'Cəld əməliyyatlar', 'bn': 'দ্রুত পদক্ষেপ', 'de': 'Schnellzugriff & Aktionen',
        'es': 'Acciones rápidas', 'fa': 'میانبرهای دسترسی سریع', 'fr': 'Actions rapides', 'hi': 'त्वरित कार्य',
        'id': 'Tindakan Cepat', 'it': 'Azioni rapide', 'ja': 'クイックアクション', 'ko': '빠른 작업',
        'nl': 'Snelle acties', 'pl': 'Szybkie akcje', 'pt': 'Ações rápidas', 'ru': 'Быстрые действия',
        'tr': 'Hızlı İşlemler', 'uk': 'Швидкі дії', 'ur': 'فوری اقدامات', 'vi': 'Thao tác nhanh', 'zh': '快捷操作'
    },
    'billAndCollect': {
        'ar': 'إصدار الفواتير والتحصيل', 'az': 'Faktura yaz və topla', 'bn': 'বিল ও সংগ্রহ করুন', 'de': 'Abrechnen & Einkassieren',
        'es': 'Facturar y cobrar', 'fa': 'صدور فاکتور و وصول مطالبات', 'fr': 'Facturer et encaisser', 'hi': 'बिल और संग्रह करें',
        'id': 'Tagih & Kumpulkan', 'it': 'Fattura e incassa', 'ja': '請求と回収', 'ko': '청구 및 수금',
        'nl': 'Factureren & Innen', 'pl': 'Fakturuj i winduj', 'pt': 'Faturar e cobrar', 'ru': 'Выставление счетов و оплата',
        'tr': 'Fatura Kes ve Tahsil Et', 'uk': 'Виписка рахунків та оплата', 'ur': 'بل اور جمع کریں', 'vi': 'Lập hóa đơn & thu tiền', 'zh': '开票与收款'
    },
    'postToTheLedger': {
        'ar': 'ترحيل إلى دفتر الأستاذ', 'az': 'Baş kitaba keçir', 'bn': 'খতিয়ানে পোস্ট করুন', 'de': 'Ins Hauptbuch buchen',
        'es': 'Contabilizar en el libro mayor', 'fa': 'ثبت سند در دفتر کل', 'fr': 'Comptabiliser au grand livre', 'hi': 'बही में पोस्ट करें',
        'id': 'Posting ke Buku Besar', 'it': 'Registra a libro giornale', 'ja': '元帳へ記帳', 'ko': '원장에 분개 입력',
        'nl': 'Boeken in het grootboek', 'pl': 'Księguj w księdze głównej', 'pt': 'Lançar no livro razão', 'ru': 'Проведение записей в Главную книгу',
        'tr': 'Defter-i Kebire İşle', 'uk': 'Проведення в Головну книгу', 'ur': 'لیجر میں اندراج کریں', 'vi': 'Ghi sổ cái tổng hợp', 'zh': '记入总账'
    },
    'orderFromASupplier': {
        'ar': 'إصدار أمر شراء لمورد', 'az': 'Təchizatçıdan sifariş et', 'bn': 'সরবরাহকারীর কাছ থেকে অর্ডার করুন', 'de': 'Beim Lieferanten bestellen',
        'es': 'Pedir a un proveedor', 'fa': 'ارسال سفارش به تامین‌کننده', 'fr': 'Commander auprès d\'un fournisseur', 'hi': 'आपूर्तिकर्ता से ऑर्डर करें',
        'id': 'Pesan dari Pemasok', 'it': 'Ordina da un fornitore', 'ja': '仕入先へ発注', 'ko': '공급업체에 발주',
        'nl': 'Bestellen bij leverancier', 'pl': 'Zamów u dostawcy', 'pt': 'Fazer pedido ao fornecedor', 'ru': 'Оформление заказа поставщику',
        'tr': 'Tedarikçiden Sipariş Et', 'uk': 'Оформлення замовлення постачальнику', 'ur': 'سپلائر سے آرڈر کریں', 'vi': 'Đặt hàng từ nhà cung cấp', 'zh': '向供应商下单'
    },
    'runAndExportReports': {
        'ar': 'تشغيل وتصدير التقارير', 'az': 'Hesabatları icra et və eksport et', 'bn': 'রিপোর্ট চালান এবং এক্সপোর্ট করুন', 'de': 'Berichte ausführen & exportieren',
        'es': 'Generar y exportar informes', 'fa': 'تهیه و خروجی گرفتن از گزارش‌ها', 'fr': 'Générer et exporter des rapports', 'hi': 'रिपोर्ट चलाएं और निर्यात करें',
        'id': 'Jalankan & Ekspor Laporan', 'it': 'Esegui ed esporta report', 'ja': 'レポートの実行とエクスポート', 'ko': '보고서 실행 및 내보내기',
        'nl': 'Rapporten genereren & exporteren', 'pl': 'Generuj i eksportuj raporty', 'pt': 'Gerar e exportar relatórios', 'ru': 'Формирование и экспорт отчетов',
        'tr': 'Rapor Oluştur ve Dışa Aktar', 'uk': 'Формування та експорт звітів', 'ur': 'رپورٹس حاصل کریں', 'vi': 'Chạy & xuất báo cáo', 'zh': '生成与导出报表'
    },
    'notAvailableForYourRole': {
        'ar': 'غير متاح لدورك الحالي', 'az': 'Rolunuz üçün əlçatan deyil', 'bn': 'আপনার ভূমিকার জন্য উপলব্ধ নয়', 'de': 'Für Ihre Rolle nicht verfügbar',
        'es': 'No disponible para su rol', 'fa': 'برای نقش شما دسترسی وجود ندارد', 'fr': 'Non disponible pour votre rôle', 'hi': 'आपकी भूमिका के लिए उपलब्ध नहीं है',
        'id': 'Tidak tersedia untuk peran Anda', 'it': 'Non disponibile per il tuo ruolo', 'ja': 'ご利用の権限では利用できません', 'ko': '현재 역할에서는 사용할 수 없습니다',
        'nl': 'Niet beschikbaar voor uw rol', 'pl': 'Niedostępne dla Twojej roli', 'pt': 'Não disponível para a sua função', 'ru': 'Недоступно для вашей роли',
        'tr': 'Rolünüz için mevcut değil', 'uk': 'Недоступно для вашої ролі', 'ur': 'آپ کے عہدے کے لیے دستیاب نہیں ہے', 'vi': 'Không khả dụng cho vai trò của bạn', 'zh': '当前角色不可用'
    },
    'unavailable': {
        'ar': 'غير متاح', 'az': 'Əlçatan deyil', 'bn': 'অনুপলব্ধ', 'de': 'Nicht verfügbar',
        'es': 'No disponible', 'fa': 'در دسترس نیست', 'fr': 'Indisponible', 'hi': 'अनुपलब्ध',
        'id': 'Tidak tersedia', 'it': 'Non disponibile', 'ja': '利用不可', 'ko': '사용 불가',
        'nl': 'Niet beschikbaar', 'pl': 'Niedostępne', 'pt': 'Indisponível', 'ru': 'Недоступно',
        'tr': 'Mevcut değil', 'uk': 'Недоступно', 'ur': 'دستیاب نہیں', 'vi': 'Không khả dụng', 'zh': '不可用'
    }
}

def update_all_catalogues():
    print("Populating 106 Sidebar Navigation keys and Dashboard UI keys across all 21 locales...")

    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        
        # Load catalogue
        with open(cat_file, 'r', encoding='utf-8') as f:
            tree = json.load(f)

        # 1. Update nav node
        if 'nav' not in tree or not isinstance(tree['nav'], dict):
            tree['nav'] = {}

        for k, lang_map in NAV_MAP.items():
            if short in lang_map:
                tree['nav'][k] = lang_map[short]

        # 2. Update ui node
        if 'ui' not in tree or not isinstance(tree['ui'], dict):
            tree['ui'] = {}

        for k, lang_map in UI_MAP.items():
            if short in lang_map:
                tree['ui'][k] = lang_map[short]

        with open(cat_file, 'w', encoding='utf-8') as f:
            json.dump(tree, f, ensure_ascii=False, indent=2)
            f.write('\n')

        # 3. Update export done files
        for fname in EXPORT_FILES:
            done_file = os.path.join(done_dir, fname)
            if os.path.exists(done_file):
                with open(done_file, 'r', encoding='utf-8') as f:
                    done_data = json.load(f)
                
                updated = False
                for k, lang_map in NAV_MAP.items():
                    full_k = f"nav.{k}"
                    if full_k in done_data and short in lang_map:
                        done_data[full_k] = lang_map[short]
                        updated = True

                for k, lang_map in UI_MAP.items():
                    full_k = f"ui.{k}"
                    if full_k in done_data and short in lang_map:
                        done_data[full_k] = lang_map[short]
                        updated = True

                if updated:
                    with open(done_file, 'w', encoding='utf-8') as f:
                        json.dump(done_data, f, ensure_ascii=False, indent=2)
                        f.write('\n')

        print(f"Updated sidebar & dashboard keys for {loc_code} ({short})")

if __name__ == '__main__':
    update_all_catalogues()
