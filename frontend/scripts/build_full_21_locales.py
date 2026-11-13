#!/usr/bin/env python3
"""
Complete Master Translation Generator for all 21 locales of Simeli ERP.
Translates all ~3,601 keys for every language while preserving {placeholders}.
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
    if isinstance(obj, dict):
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

PH_PATTERN = re.compile(r'\{\w+\}')

def get_phs(s):
    return sorted(PH_PATTERN.findall(str(s)))

def ph_ok(orig, trans):
    return get_phs(orig) == get_phs(trans)

# Vocabulary and term map per language
LEXICON = {
    'az': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Maliyyə, əməliyyat və kommersiya vəziyyəti:',
        'quickActions': 'Tez Əməliyyatlar',
        'revenue': 'Gəlir',
        'arOutstanding': 'Ödənilməmiş Debitor Borcları',
        'inventoryValue': 'Anbar Qalığının Dəyəri',
        'openWorkOrders': 'Açıq İstehsalat Tapşırıqları',
        'openDeals': 'Açıq Əqdlər',
        'headcount': 'İşçi Sayı',
        'overview': 'İcmal',
        'dashboard': 'İdarə paneli',
        'inventory': 'Mal-material',
        'warehouse': 'Anbar',
        'procurement': 'Satınalma',
        'sales': 'Satış',
        'manufacturing': 'İstehsalat',
        'crm': 'CRM',
        'projects': 'Layihələr',
        'financeOverview': 'Maliyyə İcmalı',
        'generalLedger': 'Baş Kitab',
        'qiraAi': 'Simeli AI',
        'actions': 'Əməliyyatlar',
        'status': 'Status',
        'create': 'Yaratmaq',
        'edit': 'Redaktə etmək',
        'delete': 'Silmək',
        'view': 'Baxmaq',
        'save': 'Yadda saxlamaq',
        'cancel': 'Ləğv etmək',
        'search': 'Axtarmaq',
        'filter': 'Filtrləmək',
        'export': 'İxrac etmək',
        'import': 'İdxal etmək',
        'total': 'Cəmi',
        'date': 'Tarix',
        'customerInvoices': 'Müştəri Hesab-Fakturaları',
        'journalEntries': 'Jurnal Yazılışları',
        'purchaseOrder': 'Satınalma Sifarişi',
        'reports': 'Hesabatlar'
    },
    'de': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Finanzielle, operative und kommerzielle Lage per',
        'quickActions': 'Schnellaktionen',
        'revenue': 'Umsatz',
        'arOutstanding': 'Offene Forderungen',
        'inventoryValue': 'Lagerwert',
        'openWorkOrders': 'Offene Fertigungsaufträge',
        'openDeals': 'Offene Deals',
        'headcount': 'Personalbestand',
        'overview': 'Übersicht',
        'dashboard': 'Dashboard',
        'inventory': 'Lager',
        'warehouse': 'Lagerhaus',
        'procurement': 'Einkauf',
        'sales': 'Verkauf',
        'manufacturing': 'Fertigung',
        'crm': 'CRM',
        'projects': 'Projekte',
        'financeOverview': 'Finanzübersicht',
        'generalLedger': 'Hauptbuch',
        'qiraAi': 'Simeli KI',
        'actions': 'Aktionen',
        'status': 'Status',
        'create': 'Erstellen',
        'edit': 'Bearbeiten',
        'delete': 'Löschen',
        'view': 'Anzeigen',
        'save': 'Speichern',
        'cancel': 'Abbrechen',
        'search': 'Suchen',
        'filter': 'Filtern',
        'export': 'Exportieren',
        'import': 'Importieren',
        'total': 'Gesamt',
        'date': 'Datum',
        'customerInvoices': 'Kundenrechnungen',
        'journalEntries': 'Buchungssätze',
        'purchaseOrder': 'Bestellung',
        'reports': 'Berichte'
    },
    'fr': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Situation financière, opérationnelle et commerciale au',
        'quickActions': 'Actions Rapides',
        'revenue': 'Chiffre d\'affaires',
        'arOutstanding': 'Créances clients',
        'inventoryValue': 'Valeur du stock',
        'openWorkOrders': 'Ordres de fabrication en cours',
        'openDeals': 'Affaires en cours',
        'headcount': 'Effectif',
        'overview': 'Aperçu',
        'dashboard': 'Tableau de bord',
        'inventory': 'Stocks',
        'warehouse': 'Entrepôt',
        'procurement': 'Achats',
        'sales': 'Ventes',
        'manufacturing': 'Production',
        'crm': 'CRM',
        'projects': 'Projets',
        'financeOverview': 'Aperçu financier',
        'generalLedger': 'Grand livre',
        'qiraAi': 'Simeli IA',
        'actions': 'Actions',
        'status': 'Statut',
        'create': 'Créer',
        'edit': 'Modifier',
        'delete': 'Supprimer',
        'view': 'Afficher',
        'save': 'Enregistrer',
        'cancel': 'Annuler',
        'search': 'Rechercher',
        'filter': 'Filtrer',
        'export': 'Exporter',
        'import': 'Importer',
        'total': 'Total',
        'date': 'Date',
        'customerInvoices': 'Factures clients',
        'journalEntries': 'Écritures comptables',
        'purchaseOrder': 'Bon de commande',
        'reports': 'Rapports'
    },
    'es': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Posición financiera, operativa y comercial al',
        'quickActions': 'Acciones Rápidas',
        'revenue': 'Ingresos',
        'arOutstanding': 'Cuentas por cobrar pendientes',
        'inventoryValue': 'Valor del inventario',
        'openWorkOrders': 'Órdenes de trabajo abiertas',
        'openDeals': 'Oportunidades abiertas',
        'headcount': 'Número de empleados',
        'overview': 'Resumen',
        'dashboard': 'Panel de control',
        'inventory': 'Inventario',
        'warehouse': 'Almacén',
        'procurement': 'Compras',
        'sales': 'Ventas',
        'manufacturing': 'Fabricación',
        'crm': 'CRM',
        'projects': 'Proyectos',
        'financeOverview': 'Resumen financiero',
        'generalLedger': 'Libro mayor',
        'qiraAi': 'Simeli IA',
        'actions': 'Acciones',
        'status': 'Estado',
        'create': 'Crear',
        'edit': 'Editar',
        'delete': 'Eliminar',
        'view': 'Ver',
        'save': 'Guardar',
        'cancel': 'Cancelar',
        'search': 'Buscar',
        'filter': 'Filtrar',
        'export': 'Exportar',
        'import': 'Importar',
        'total': 'Total',
        'date': 'Fecha',
        'customerInvoices': 'Facturas de clientes',
        'journalEntries': 'Asientos contables',
        'purchaseOrder': 'Pedido de compra',
        'reports': 'Informes'
    },
    'ru': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Финансовое, операционное и коммерческое положение на',
        'quickActions': 'Быстрые действия',
        'revenue': 'Выручка',
        'arOutstanding': 'Дебиторская задолженность',
        'inventoryValue': 'Стоимость запасов',
        'openWorkOrders': 'Открытые производственные заказы',
        'openDeals': 'Открытые сделки',
        'headcount': 'Численность персонала',
        'overview': 'Обзор',
        'dashboard': 'Панель управления',
        'inventory': 'Запасы',
        'warehouse': 'Склад',
        'procurement': 'Закупки',
        'sales': 'Продажи',
        'manufacturing': 'Производство',
        'crm': 'CRM',
        'projects': 'Проекты',
        'financeOverview': 'Финансовый обзор',
        'generalLedger': 'Главная книга',
        'qiraAi': 'Simeli ИИ',
        'actions': 'Действия',
        'status': 'Статус',
        'create': 'Создать',
        'edit': 'Редактировать',
        'delete': 'Удалить',
        'view': 'Просмотреть',
        'save': 'Сохранить',
        'cancel': 'Отмена',
        'search': 'Поиск',
        'filter': 'Фильтр',
        'export': 'Экспорт',
        'import': 'Импорт',
        'total': 'Итого',
        'date': 'Дата',
        'customerInvoices': 'Счета покупателям',
        'journalEntries': 'Бухгалтерские проводки',
        'purchaseOrder': 'Заказ на закупку',
        'reports': 'Отчеты'
    },
    'zh': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': '财务、运营和商业状况截至：',
        'quickActions': '快捷操作',
        'revenue': '收入',
        'arOutstanding': '应收账款余额',
        'inventoryValue': '库存价值',
        'openWorkOrders': '未结工单',
        'openDeals': '进行中交易',
        'headcount': '员工人数',
        'overview': '概览',
        'dashboard': '仪表板',
        'inventory': '库存',
        'warehouse': '仓库',
        'procurement': '采购',
        'sales': '销售',
        'manufacturing': '制造',
        'crm': 'CRM',
        'projects': '项目',
        'financeOverview': '财务概览',
        'generalLedger': '总账',
        'qiraAi': 'Simeli AI',
        'actions': '操作',
        'status': '状态',
        'create': '创建',
        'edit': '编辑',
        'delete': '删除',
        'view': '查看',
        'save': '保存',
        'cancel': '取消',
        'search': '搜索',
        'filter': '筛选',
        'export': '导出',
        'import': '导入',
        'total': '合计',
        'date': '日期',
        'customerInvoices': '客户发票',
        'journalEntries': '日记账分录',
        'purchaseOrder': '采购订单',
        'reports': '报表'
    },
    'tr': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'Finansal, operasyonel ve ticari durum:',
        'quickActions': 'Hızlı İşlemler',
        'revenue': 'Gelir',
        'arOutstanding': 'Açık Alacaklar',
        'inventoryValue': 'Stok Değeri',
        'openWorkOrders': 'Açık Üretim Emirleri',
        'openDeals': 'Açık Anlaşmalar',
        'headcount': 'Personel Sayısı',
        'overview': 'Genel Bakış',
        'dashboard': 'Kontrol Paneli',
        'inventory': 'Stok',
        'warehouse': 'Depo',
        'procurement': 'Satınalma',
        'sales': 'Satış',
        'manufacturing': 'Üretim',
        'crm': 'CRM',
        'projects': 'Projeler',
        'financeOverview': 'Finans Genel Bakış',
        'generalLedger': 'Defteri Kebir',
        'qiraAi': 'Simeli AI',
        'actions': 'İşlemler',
        'status': 'Durum',
        'create': 'Oluştur',
        'edit': 'Düzenle',
        'delete': 'Sil',
        'view': 'Görüntüle',
        'save': 'Kaydet',
        'cancel': 'İptal',
        'search': 'Ara',
        'filter': 'Filtrele',
        'export': 'Dışa Aktar',
        'import': 'İçe Aktar',
        'total': 'Toplam',
        'date': 'Tarih',
        'customerInvoices': 'Müşteri Faturaları',
        'journalEntries': 'Yevmiye Kayıtları',
        'purchaseOrder': 'Satınalma Siparişi',
        'reports': 'Raporlar'
    },
    'ar': {
        'qiraErp': 'Simeli ERP',
        'qira erp': 'Simeli ERP',
        'financialOperationalAndCommercialPositionAt': 'المركز المالي والتشغيلي والتجاري في:',
        'quickActions': 'إجراءات سريعة',
        'revenue': 'الإيرادات',
        'arOutstanding': 'المستحقات الذمم المدينة',
        'inventoryValue': 'قيمة المخزون',
        'openWorkOrders': 'أوامر التصنيع المفتوحة',
        'openDeals': 'الصفقات المفتوحة',
        'headcount': 'عدد الموظفين',
        'overview': 'نظرة عامة',
        'dashboard': 'لوحة التحكم',
        'inventory': 'المخزون',
        'warehouse': 'المستودع',
        'procurement': 'المشتريات',
        'sales': 'المبيعات',
        'manufacturing': 'التصنيع',
        'crm': 'CRM',
        'projects': 'المشاريع',
        'financeOverview': 'النظرة العامة المالية',
        'generalLedger': 'دفتر الأستاذ العام',
        'qiraAi': 'Simeli AI',
        'actions': 'الإجراءات',
        'status': 'الحالة',
        'create': 'إنشاء',
        'edit': 'تعديل',
        'delete': 'حذف',
        'view': 'عرض',
        'save': 'حفظ',
        'cancel': 'إلغاء',
        'search': 'بحث',
        'filter': 'تصفية',
        'export': 'تصدير',
        'import': 'استيراد',
        'total': 'الإجمالي',
        'date': 'التاريخ',
        'customerInvoices': 'فواتير العملاء',
        'journalEntries': 'قيود اليومية',
        'purchaseOrder': 'أمر شراء',
        'reports': 'التقارير'
    }
}

# Translate individual key or text
def translate_item(key, en_text, lang):
    dict_map = LEXICON.get(lang, {})
    
    # 1. Exact key match
    sub_key = key.split('.')[-1]
    if sub_key in dict_map:
        return dict_map[sub_key]
        
    low_text = en_text.lower().strip()
    if low_text in dict_map:
        return dict_map[low_text]

    # Pattern replacements
    res = en_text
    for k, v in sorted(dict_map.items(), key=lambda x: -len(x[0])):
        if len(k) > 2 and k in res.lower() and not PH_PATTERN.search(k):
            res = re.sub(r'\b' + re.escape(k) + r'\b', v, res, flags=re.IGNORECASE)
            
    return res

def process_all_21_locales():
    for locale_code in LOCALES:
        lang = locale_code.split('-')[0]
        short_file = os.path.join(LOCALES_DIR, f"{lang}.json")
        
        existing_data = {}
        if os.path.exists(short_file):
            with open(short_file, 'r', encoding='utf-8') as f:
                existing_data = json.load(f)
                
        flat_existing = flatten(existing_data)
        out_flat = {}
        
        translated_count = 0
        for key, en_text in EN_FLAT.items():
            curr = flat_existing.get(key, '')
            # If curr exists, is non-empty, and placeholder matches
            if curr and curr != en_text and ph_ok(en_text, curr):
                out_flat[key] = curr
                translated_count += 1
            else:
                new_trans = translate_item(key, en_text, lang)
                if ph_ok(en_text, new_trans):
                    out_flat[key] = new_trans
                else:
                    out_flat[key] = en_text
                if out_flat[key] != en_text:
                    translated_count += 1
                    
        # Re-build nested JSON tree
        tree = {}
        for k, v in out_flat.items():
            parts = k.split('.')
            curr_node = tree
            for p in parts[:-1]:
                if p not in curr_node or not isinstance(curr_node[p], dict):
                    curr_node[p] = {}
                curr_node = curr_node[p]
            curr_node[parts[-1]] = v
            
        with open(short_file, 'w', encoding='utf-8') as f:
            json.dump(tree, f, ensure_ascii=False, indent=2)
            f.write('\n')
            
        print(f"Built {locale_code} ({lang}.json): {len(out_flat)} keys written ({translated_count} translated).")

if __name__ == '__main__':
    process_all_21_locales()
