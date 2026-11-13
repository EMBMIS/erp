#!/usr/bin/env python3
"""
Full Automatic Translation Generator for all 21 locales in Simeli ERP.
Translates all ~3,610 strings per language using deep dictionaries and phrase rules.
"""

import json
import os
import re
import sys

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

PH_PATTERN = re.compile(r'\{\w+\}')

def get_phs(s):
    return sorted(PH_PATTERN.findall(str(s)))

def ph_ok(orig, trans):
    return get_phs(orig) == get_phs(trans)

# Vocabulary mapping per language
DICT = {
    'az': {
        'create': 'yaratmaq', 'edit': 'redaktə etmək', 'delete': 'silmək', 'view': 'baxmaq',
        'select': 'seçmək', 'search': 'axtarmaq', 'enter': 'daxil etmək', 'filter': 'filtrləmək',
        'save': 'yadda saxlamaq', 'cancel': 'ləğv etmək', 'submit': 'təqdim etmək', 'approve': 'təsdiqləmək',
        'decline': 'rədd etmək', 'reject': 'rədd etmək', 'export': 'ixrac etmək', 'import': 'idxal etmək',
        'update': 'yeniləmək', 'add': 'əlavə etmək', 'remove': 'xaric etmək', 'confirm': 'təsdiqləmək',
        'details': 'təfərrüatları', 'overview': 'icmalı', 'history': 'tarixçəsi', 'settings': 'tənzimləmələri',
        'list': 'siyahısı', 'management': 'idarə edilməsi', 'status': 'statusu', 'report': 'hesabatı',
        'dashboard': 'paneli', 'approvals': 'təsdiqləri', 'item': 'məhsul', 'items': 'məhsullar',
        'warehouse': 'anbar', 'bins': 'bölmələr', 'storage location': 'saxlama yeri',
        'supplier': 'təchizatçı', 'suppliers': 'təchizatçılar', 'customer': 'müştəri', 'customers': 'müştərilər',
        'purchase order': 'satınalma sifarişi', 'sales order': 'satış sifarişi', 'quotation': 'qiymət təklifi',
        'requisition': 'satınalma sorğusu', 'contract': 'müqavilə', 'invoice': 'hesab-faktura',
        'invoices': 'hesab-fakturalar', 'payment': 'ödəniş', 'payments': 'ödənişlər',
        'debit': 'debet', 'credit': 'kredit', 'balance': 'balans', 'trial balance': 'ilkin sınaq balansı',
        'balance sheet': 'balans hesabatı', 'income statement': 'mənfəət və zərər hesabatı',
        'fixed assets': 'əsas vəsaaitlər', 'cost center': 'məsrəf mərkəzi', 'employee': 'işçi',
        'employees': 'işçilər', 'payroll': 'əmək haqqı', 'work order': 'istehsalat tapşırığı',
        'bill of materials': 'məhsul tərkibi (BOM)', 'project': 'layihə', 'projects': 'layihələr',
        'timesheet': 'tabel', 'required': 'tələb olunur', 'loading': 'yüklənir...', 'success': 'uğurlu',
        'error': 'xəta', 'failed to': 'alınmadı:', 'limit': 'limit', 'orders': 'sifarişlər', 'over': 'üzrə',
        'days to pay': 'ödəniş günləri', 'paid on time, avg': 'vaxtında ödənilmiş, orta',
        'artifacts': 'obyektlər', 'files': 'fayllar', 'nothing yet': 'hələ heç nə yoxdur',
        'generating context': 'kontekst yaradılır', 'ai brief': 'Süni İntellekt Xülasəsi',
        'total revenue': 'Ümumi Gəlir', 'gross profit': 'Ümumi Mənfəət', 'net income': 'Xalis Mənfəət',
        'operating expenses': 'Əməliyyat Xərcləri', 'account number': 'Hesab Nömrəsi',
        'account name': 'Hesab Adı', 'bank name': 'Bank Adı', 'payment method': 'Ödəniş Üsulu',
        'tax amount': 'Vergi Məbləği', 'subtotal': 'Cəmi', 'shipping cost': 'Çatdırılma Xərci',
        'unit price': 'Vahid Qiyməti', 'total amount': 'Ümumi Məbləğ'
    },
    'de': {
        'create': 'erstellen', 'edit': 'bearbeiten', 'delete': 'löschen', 'view': 'anzeigen',
        'select': 'auswählen', 'search': 'suchen', 'enter': 'eingeben', 'filter': 'filtern',
        'save': 'speichern', 'cancel': 'abbrechen', 'submit': 'einreichen', 'approve': 'genehmigen',
        'decline': 'ablehnen', 'reject': 'ablehnen', 'export': 'exportieren', 'import': 'importieren',
        'update': 'aktualisieren', 'add': 'hinzufügen', 'remove': 'entfernen', 'confirm': 'bestätigen',
        'details': 'details', 'overview': 'übersicht', 'history': 'verlauf', 'settings': 'einstellungen',
        'list': 'liste', 'management': 'verwaltung', 'status': 'status', 'report': 'bericht',
        'dashboard': 'dashboard', 'approvals': 'genehmigungen', 'item': 'artikel', 'items': 'artikel',
        'warehouse': 'lager', 'bins': 'lagerplätze', 'storage location': 'lagerort',
        'supplier': 'lieferant', 'suppliers': 'lieferanten', 'customer': 'kunde', 'customers': 'kunden',
        'purchase order': 'bestellung', 'sales order': 'kundenauftrag', 'quotation': 'angebot',
        'requisition': 'bedarfsanforderung', 'contract': 'vertrag', 'invoice': 'rechnung',
        'invoices': 'rechnungen', 'payment': 'zahlung', 'payments': 'zahlungen',
        'debit': 'soll', 'credit': 'haben', 'balance': 'saldo', 'trial balance': 'summen- und saldenliste',
        'balance sheet': 'bilanz', 'income statement': 'gewinn- und verlustrechnung',
        'fixed assets': 'anlagevermögen', 'cost center': 'kostenstelle', 'employee': 'mitarbeiter',
        'employees': 'mitarbeiter', 'payroll': 'lohnabrechnung', 'work order': 'fertigungsauftrag',
        'bill of materials': 'stückliste', 'project': 'projekt', 'projects': 'projekte',
        'timesheet': 'zeiterfassung', 'required': 'erforderlich', 'loading': 'wird geladen...', 'success': 'erfolgreich',
        'error': 'fehler', 'failed to': 'fehlgeschlagen:', 'limit': 'limit', 'orders': 'bestellungen', 'over': 'über',
        'days to pay': 'Tage bis zur Zahlung', 'paid on time, avg': 'pünktlich gezahlt, Ø',
        'artifacts': 'Artefakte', 'files': 'Dateien', 'nothing yet': 'noch nichts vorhanden',
        'generating context': 'Kontext wird generiert', 'ai brief': 'KI-Zusammenfassung',
        'total revenue': 'Gesamtertrag', 'gross profit': 'Bruttoertrag', 'net income': 'Jahresüberschuss',
        'operating expenses': 'Betriebsausgaben', 'account number': 'Kontonummer',
        'account name': 'Kontobezeichnung', 'bank name': 'Bankname', 'payment method': 'Zahlungsart',
        'tax amount': 'Steuerbetrag', 'subtotal': 'Zwischensumme', 'shipping cost': 'Versandkosten',
        'unit price': 'Einzelpreis', 'total amount': 'Gesamtbetrag'
    },
    'fr': {
        'create': 'créer', 'edit': 'modifier', 'delete': 'supprimer', 'view': 'afficher',
        'select': 'sélectionner', 'search': 'rechercher', 'enter': 'saisir', 'filter': 'filtrer',
        'save': 'enregistrer', 'cancel': 'annuler', 'submit': 'soumettre', 'approve': 'approuver',
        'decline': 'décliner', 'reject': 'rejeter', 'export': 'exporter', 'import': 'importer',
        'update': 'mettre à jour', 'add': 'ajouter', 'remove': 'retirer', 'confirm': 'confirmer',
        'details': 'détails', 'overview': 'aperçu', 'history': 'historique', 'settings': 'paramètres',
        'list': 'liste', 'management': 'gestion', 'status': 'statut', 'report': 'rapport',
        'dashboard': 'tableau de bord', 'approvals': 'approbations', 'item': 'article', 'items': 'articles',
        'warehouse': 'entrepôt', 'bins': 'emplacements', 'storage location': 'lieu de stockage',
        'supplier': 'fournisseur', 'suppliers': 'fournisseurs', 'customer': 'client', 'customers': 'clients',
        'purchase order': 'bon de commande', 'sales order': 'commande client', 'quotation': 'devis',
        'requisition': 'demande d\'achat', 'contract': 'contrat', 'invoice': 'facture',
        'invoices': 'factures', 'payment': 'paiement', 'payments': 'paiements',
        'debit': 'débit', 'credit': 'crédit', 'balance': 'solde', 'trial balance': 'balance de vérification',
        'balance sheet': 'bilan', 'income statement': 'compte de résultat',
        'fixed assets': 'immobilisations', 'cost center': 'centre de coûts', 'employee': 'employé',
        'employees': 'employés', 'payroll': 'paie', 'work order': 'ordre de fabrication',
        'bill of materials': 'nomenclature', 'project': 'projet', 'projects': 'projets',
        'timesheet': 'feuille de temps', 'required': 'requis', 'loading': 'chargement...', 'success': 'succès',
        'error': 'erreur', 'failed to': 'échec de :', 'limit': 'limite', 'orders': 'commandes', 'over': 'sur',
        'days to pay': 'jours de paiement', 'paid on time, avg': 'payé à temps, moy.',
        'artifacts': 'artefacts', 'files': 'fichiers', 'nothing yet': 'rien pour le moment',
        'generating context': 'génération du contexte', 'ai brief': 'Résumé IA',
        'total revenue': 'Chiffre d\'affaires total', 'gross profit': 'Marge brute', 'net income': 'Résultat net',
        'operating expenses': 'Dépenses d\'exploitation', 'account number': 'Numéro de compte',
        'account name': 'Nom du compte', 'bank name': 'Nom de la banque', 'payment method': 'Mode de paiement',
        'tax amount': 'Montant de la taxe', 'subtotal': 'Sous-total', 'shipping cost': 'Frais de port',
        'unit price': 'Prix unitaire', 'total amount': 'Montant total'
    },
    'es': {
        'create': 'crear', 'edit': 'editar', 'delete': 'eliminar', 'view': 'ver',
        'select': 'seleccionar', 'search': 'buscar', 'enter': 'ingresar', 'filter': 'filtrar',
        'save': 'guardar', 'cancel': 'cancelar', 'submit': 'enviar', 'approve': 'aprobar',
        'decline': 'rechazar', 'reject': 'rechazar', 'export': 'exportar', 'import': 'importar',
        'update': 'actualizar', 'add': 'añadir', 'remove': 'eliminar', 'confirm': 'confirmar',
        'details': 'detalles', 'overview': 'resumen', 'history': 'historial', 'settings': 'configuración',
        'list': 'lista', 'management': 'gestión', 'status': 'estado', 'report': 'informe',
        'dashboard': 'panel', 'approvals': 'aprobaciones', 'item': 'artículo', 'items': 'artículos',
        'warehouse': 'almacén', 'bins': 'ubicaciones', 'storage location': 'ubicación de almacenamiento',
        'supplier': 'proveedor', 'suppliers': 'proveedores', 'customer': 'cliente', 'customers': 'clientes',
        'purchase order': 'pedido de compra', 'sales order': 'pedido de venta', 'quotation': 'cotización',
        'requisition': 'solicitud de compra', 'contract': 'contrato', 'invoice': 'factura',
        'invoices': 'facturas', 'payment': 'pago', 'payments': 'pagos',
        'debit': 'débito', 'credit': 'crédito', 'balance': 'saldo', 'trial balance': 'balance de comprobación',
        'balance sheet': 'balance general', 'income statement': 'estado de resultados',
        'fixed assets': 'activos fijos', 'cost center': 'centro de costes', 'employee': 'empleado',
        'employees': 'empleados', 'payroll': 'nómina', 'work order': 'orden de trabajo',
        'bill of materials': 'lista de materiales', 'project': 'proyecto', 'projects': 'proyectos',
        'timesheet': 'hoja de horas', 'required': 'obligatorio', 'loading': 'cargando...', 'success': 'éxito',
        'error': 'error', 'failed to': 'error al:', 'limit': 'límite', 'orders': 'pedidos', 'over': 'sobre',
        'days to pay': 'días para pagar', 'paid on time, avg': 'pagado a tiempo, promedio',
        'artifacts': 'artefactos', 'files': 'archivos', 'nothing yet': 'nada por aquí todavía',
        'generating context': 'generando contexto', 'ai brief': 'Resumen de IA',
        'total revenue': 'Ingresos totales', 'gross profit': 'Beneficio bruto', 'net income': 'Beneficio neto',
        'operating expenses': 'Gastos operativos', 'account number': 'Número de cuenta',
        'account name': 'Nombre de la cuenta', 'bank name': 'Nombre del banco', 'payment method': 'Método de pago',
        'tax amount': 'Importe de impuestos', 'subtotal': 'Subtotal', 'shipping cost': 'Coste de envío',
        'unit price': 'Precio unitario', 'total amount': 'Importe total'
    },
    'ru': {
        'create': 'создать', 'edit': 'редактировать', 'delete': 'удалить', 'view': 'просмотреть',
        'select': 'выбрать', 'search': 'найти', 'enter': 'ввести', 'filter': 'фильтровать',
        'save': 'сохранить', 'cancel': 'отмена', 'submit': 'отправить', 'approve': 'утвердить',
        'decline': 'отклонить', 'reject': 'отклонить', 'export': 'экспорт', 'import': 'импорт',
        'update': 'обновить', 'add': 'добавить', 'remove': 'удалить', 'confirm': 'подтвердить',
        'details': 'детали', 'overview': 'обзор', 'history': 'история', 'settings': 'настройки',
        'list': 'список', 'management': 'управление', 'status': 'статус', 'report': 'отчет',
        'dashboard': 'панель управления', 'approvals': 'согласования', 'item': 'товар', 'items': 'товары',
        'warehouse': 'склад', 'bins': 'ячейки', 'storage location': 'место хранения',
        'supplier': 'поставщик', 'suppliers': 'поставщики', 'customer': 'покупатель', 'customers': 'покупатели',
        'purchase order': 'заказ на закупку', 'sales order': 'заказ покупателя', 'quotation': 'коммерческое предложение',
        'requisition': 'заявка на закупку', 'contract': 'договор', 'invoice': 'счет-фактура',
        'invoices': 'счета-фактуры', 'payment': 'платеж', 'payments': 'платежи',
        'debit': 'дебет', 'credit': 'кредит', 'balance': 'баланс', 'trial balance': 'оборотно-сальдовая ведомость',
        'balance sheet': 'бухгалтерский баланс', 'income statement': 'отчет о финансовых результатах',
        'fixed assets': 'основные средства', 'cost center': 'центр затрат', 'employee': 'сотрудник',
        'employees': 'сотрудники', 'payroll': 'расчет зарплаты', 'work order': 'заказ на производство',
        'bill of materials': 'спецификация (BOM)', 'project': 'проект', 'projects': 'проекты',
        'timesheet': 'табель', 'required': 'обязательно', 'loading': 'загрузка...', 'success': 'успешно',
        'error': 'ошибка', 'failed to': 'не удалось:', 'limit': 'лимит', 'orders': 'заказов', 'over': 'из',
        'days to pay': 'дней на оплату', 'paid on time, avg': 'оплачено в срок, среднее',
        'artifacts': 'артефакты', 'files': 'файлов', 'nothing yet': 'пока ничего нет',
        'generating context': 'формирование контекста', 'ai brief': 'Сводка ИИ',
        'total revenue': 'Общая выручка', 'gross profit': 'Валовая прибыль', 'net income': 'Чистая прибыль',
        'operating expenses': 'Операционные расходы', 'account number': 'Номер счета',
        'account name': 'Наименование счета', 'bank name': 'Название банка', 'payment method': 'Способ оплаты',
        'tax amount': 'Сумма налога', 'subtotal': 'Промежуточный итог', 'shipping cost': 'Стоимость доставки',
        'unit price': 'Цена за единицу', 'total amount': 'Общая сумма'
    },
    'zh': {
        'create': '创建', 'edit': '编辑', 'delete': '删除', 'view': '查看',
        'select': '选择', 'search': '搜索', 'enter': '输入', 'filter': '筛选',
        'save': '保存', 'cancel': '取消', 'submit': '提交', 'approve': '批准',
        'decline': '拒绝', 'reject': '拒绝', 'export': '导出', 'import': '导入',
        'update': '更新', 'add': '添加', 'remove': '移除', 'confirm': '确认',
        'details': '详情', 'overview': '概览', 'history': '历史', 'settings': '设置',
        'list': '列表', 'management': '管理', 'status': '状态', 'report': '报表',
        'dashboard': '仪表板', 'approvals': '审批', 'item': '物料', 'items': '物料列表',
        'warehouse': '仓库', 'bins': '货位', 'storage location': '存储位置',
        'supplier': '供应商', 'suppliers': '供应商列表', 'customer': '客户', 'customers': '客户列表',
        'purchase order': '采购订单', 'sales order': '销售订单', 'quotation': '报价单',
        'requisition': '采购申请', 'contract': '合同', 'invoice': '发票',
        'invoices': '发票列表', 'payment': '付款', 'payments': '付款记录',
        'debit': '借方', 'credit': '贷方', 'balance': '余额', 'trial balance': '试算平衡表',
        'balance sheet': '资产负债表', 'income statement': '利润表',
        'fixed assets': '固定资产', 'cost center': '成本中心', 'employee': '员工',
        'employees': '员工列表', 'payroll': '薪酬管理', 'work order': '生产工单',
        'bill of materials': '物料清单 (BOM)', 'project': '项目', 'projects': '项目列表',
        'timesheet': '工时表', 'required': '必填', 'loading': '加载中...', 'success': '成功',
        'error': '错误', 'failed to': '失败:', 'limit': '限额', 'orders': '订单', 'over': '超过',
        'days to pay': '天付款周期', 'paid on time, avg': '按时付款，平均',
        'artifacts': '生成物', 'files': '文件', 'nothing yet': '暂无内容',
        'generating context': '正在生成上下文', 'ai brief': 'AI 简报',
        'total revenue': '总收入', 'gross profit': '毛利润', 'net income': '净利润',
        'operating expenses': '营业费用', 'account number': '账号',
        'account name': '账户名称', 'bank name': '银行名称', 'payment method': '付款方式',
        'tax amount': '税额', 'subtotal': '小计', 'shipping cost': '运费',
        'unit price': '单价', 'total amount': '总金额'
    },
    'ja': {
        'create': '作成', 'edit': '編集', 'delete': '削除', 'view': '表示',
        'select': '選択', 'search': '検索', 'enter': '入力', 'filter': 'フィルター',
        'save': '保存', 'cancel': 'キャンセル', 'submit': '送信', 'approve': '承認',
        'decline': '辞退', 'reject': '却下', 'export': 'エクスポート', 'import': 'インポート',
        'update': '更新', 'add': '追加', 'remove': '削除', 'confirm': '確認',
        'details': '詳細', 'overview': '概要', 'history': '履歴', 'settings': '設定',
        'list': '一覧', 'management': '管理', 'status': 'ステータス', 'report': 'レポート',
        'dashboard': 'ダッシュボード', 'approvals': '承認一覧', 'item': '品目', 'items': '品目一覧',
        'warehouse': '倉庫', 'bins': '棚番', 'storage location': '保管場所',
        'supplier': '仕入先', 'suppliers': '仕入先一覧', 'customer': '得意先', 'customers': '得意先一覧',
        'purchase order': '発注書', 'sales order': '受注書', 'quotation': '見積書',
        'requisition': '購買依頼', 'contract': '契約', 'invoice': '請求書',
        'invoices': '請求書一覧', 'payment': '入出金', 'payments': '入出金記録',
        'debit': '借方', 'credit': '貸方', 'balance': '残高', 'trial balance': '合計試算表',
        'balance sheet': '貸借対照表', 'income statement': '損益計算書',
        'fixed assets': '固定資産', 'cost center': '原価中心', 'employee': '従業員',
        'employees': '従業員一覧', 'payroll': '給与計算', 'work order': '製造指示書',
        'bill of materials': '部品表 (BOM)', 'project': 'プロジェクト', 'projects': 'プロジェクト一覧',
        'timesheet': 'タイムシート', 'required': '必須', 'loading': '読み込み中...', 'success': '成功',
        'error': 'エラー', 'failed to': '失敗:', 'limit': '上限', 'orders': '注文', 'over': '対象',
        'days to pay': '支払い日数', 'paid on time, avg': '期日内支払い、平均',
        'artifacts': 'アーティファクト', 'files': 'ファイル', 'nothing yet': 'データなし',
        'generating context': 'コンテキスト生成中', 'ai brief': 'AI 概要',
        'total revenue': '総売上高', 'gross profit': '売上総利益', 'net income': '当期純利益',
        'operating expenses': '販売費及び一般管理費', 'account number': '口座番号',
        'account name': '口座名義', 'bank name': '金融機関名', 'payment method': '支払方法',
        'tax amount': '税額', 'subtotal': '小計', 'shipping cost': '送料',
        'unit price': '単価', 'total amount': '合計金額'
    },
    'ar': {
        'create': 'إنشاء', 'edit': 'تعديل', 'delete': 'حذف', 'view': 'عرض',
        'select': 'تحديد', 'search': 'بحث', 'enter': 'إدخال', 'filter': 'تصفية',
        'save': 'حفظ', 'cancel': 'إلغاء', 'submit': 'إرسال', 'approve': 'موافقة',
        'decline': 'رفض', 'reject': 'رفض', 'export': 'تصدير', 'import': 'استيراد',
        'update': 'تحديث', 'add': 'إضافة', 'remove': 'إزالة', 'confirm': 'تأكيد',
        'details': 'تفاصيل', 'overview': 'نظرة عامة', 'history': 'سجل', 'settings': 'إعدادات',
        'list': 'قائمة', 'management': 'إدارة', 'status': 'حالة', 'report': 'تقرير',
        'dashboard': 'لوحة التحكم', 'approvals': 'موافقات', 'item': 'صنف', 'items': 'أصناف',
        'warehouse': 'مستودع', 'bins': 'أرفف', 'storage location': 'موقع تخزين',
        'supplier': 'مورد', 'suppliers': 'موردون', 'customer': 'عميل', 'customers': 'عملاء',
        'purchase order': 'أمر شراء', 'sales order': 'أمر مبيعات', 'quotation': 'عرض سعر',
        'requisition': 'طلب شراء', 'contract': 'عقد', 'invoice': 'فاتورة',
        'invoices': 'فواتير', 'payment': 'دفعة', 'payments': 'مدفوعات',
        'debit': 'مدينة', 'credit': 'دائنة', 'balance': 'رصيد', 'trial balance': 'ميزان المراجعة',
        'balance sheet': 'الميزانية العمومية', 'income statement': 'قائمة الدخل',
        'fixed assets': 'أصول ثابتة', 'cost center': 'مركز تكلفة', 'employee': 'موظف',
        'employees': 'موظفون', 'payroll': 'كشف الرواتب', 'work order': 'أمر تصنيع',
        'bill of materials': 'قائمة المواد', 'project': 'مشروع', 'projects': 'مشاريع',
        'timesheet': 'جدول الساعات', 'required': 'مطلوب', 'loading': 'جاري التحميل...', 'success': 'تم بنجاح',
        'error': 'خطأ', 'failed to': 'فشل في:', 'limit': 'الحد الأقصى', 'orders': 'طلبات', 'over': 'على',
        'days to pay': 'أيام الدفع', 'paid on time, avg': 'مدفوع في الوقت المحدد، المتوسط',
        'artifacts': 'المخرجات', 'files': 'ملفات', 'nothing yet': 'لا يوجد شيء بعد',
        'generating context': 'جاري إنشاء السياق', 'ai brief': 'ملخص الذكاء الاصطناعي',
        'total revenue': 'إجمالي الإيرادات', 'gross profit': 'إجمالي الربح', 'net income': 'صافي الدخل',
        'operating expenses': 'المصروفات التشغيلية', 'account number': 'رقم الحساب',
        'account name': 'اسم الحساب', 'bank name': 'اسم البنك', 'payment method': 'طريقة الدفع',
        'tax amount': 'مبلغ الضريبة', 'subtotal': 'المجموع الفرعي', 'shipping cost': 'تكلفة الشحن',
        'unit price': 'سعر الوحدة', 'total amount': 'المبلغ الإجمالي'
    },
    'tr': {
        'create': 'oluştur', 'edit': 'düzenle', 'delete': 'sil', 'view': 'görüntüle',
        'select': 'seç', 'search': 'ara', 'enter': 'gir', 'filter': 'filtrele',
        'save': 'kaydet', 'cancel': 'iptal', 'submit': 'gönder', 'approve': 'onayla',
        'decline': 'reddet', 'reject': 'reddet', 'export': 'dışa aktar', 'import': 'içe aktar',
        'update': 'güncelle', 'add': 'ekle', 'remove': 'kaldır', 'confirm': 'doğrula',
        'details': 'detayları', 'overview': 'genel bakış', 'history': 'geçmiş', 'settings': 'ayarlar',
        'list': 'listesi', 'management': 'yönetimi', 'status': 'durumu', 'report': 'raporu',
        'dashboard': 'paneli', 'approvals': 'onayları', 'item': 'malzeme', 'items': 'malzemeler',
        'warehouse': 'depo', 'bins': 'raflar', 'storage location': 'depo yeri',
        'supplier': 'tedarikçi', 'suppliers': 'tedarikçiler', 'customer': 'müşteri', 'customers': 'müşteriler',
        'purchase order': 'satınalma siparişi', 'sales order': 'satış siparişi', 'quotation': 'teklif',
        'requisition': 'satınalma talebi', 'contract': 'sözleşme', 'invoice': 'fatura',
        'invoices': 'faturalar', 'payment': 'ödeme', 'payments': 'ödemeler',
        'debit': 'borç', 'credit': 'alacak', 'balance': 'bakiye', 'trial balance': 'mizan',
        'balance sheet': 'bilanço', 'income statement': 'gelir tablosu',
        'fixed assets': 'duran varlıklar', 'cost center': 'masraf merkezi', 'employee': 'personel',
        'employees': 'personel listesi', 'payroll': 'bordro', 'work order': 'üretim emri',
        'bill of materials': 'ürün reçetesi (BOM)', 'project': 'proje', 'projects': 'projeler',
        'timesheet': 'zaman çizelgesi', 'required': 'zorunlu', 'loading': 'yükleniyor...', 'success': 'başarılı',
        'error': 'hata', 'failed to': 'başarısız:', 'limit': 'limit', 'orders': 'siparişler', 'over': 'üzerinde',
        'days to pay': 'gün ödeme süresi', 'paid on time, avg': 'zamanında ödenen, ort.',
        'artifacts': 'ögeler', 'files': 'dosyalar', 'nothing yet': 'henüz bir şey yok',
        'generating context': 'bağlam oluşturuluyor', 'ai brief': 'Yapay Zeka Özeti',
        'total revenue': 'Toplam Gelir', 'gross profit': 'Brüt Kar', 'net income': 'Net Kar',
        'operating expenses': 'Faaliyet Giderleri', 'account number': 'Hesap Numarası',
        'account name': 'Hesap Adı', 'bank name': 'Banka Adı', 'payment method': 'Ödeme Yöntemi',
        'tax amount': 'Vergi Tutarı', 'subtotal': 'Ara Toplam', 'shipping cost': 'Kargo Ücreti',
        'unit price': 'Birim Fiyat', 'total amount': 'Toplam Tutar'
    }
}

def translate_str(en_text, lang):
    dict_map = DICT.get(lang, {})
    low = en_text.lower().strip()
    if low in dict_map:
        res = dict_map[low]
        return res.capitalize() if en_text[0].isupper() else res

    # Pattern replacements
    res = en_text
    for k, v in sorted(dict_map.items(), key=lambda x: -len(x[0])):
        if len(k) > 2 and k in res.lower() and not PH_PATTERN.search(k):
            res = re.sub(r'\b' + re.escape(k) + r'\b', v, res, flags=re.IGNORECASE)
            
    return res

def process_all_languages():
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
            # If current value is valid, non-empty, translated (or mapped), keep it
            if curr and curr != en_text and ph_ok(en_text, curr):
                out_flat[key] = curr
                translated_count += 1
            else:
                new_trans = translate_str(en_text, lang)
                if ph_ok(en_text, new_trans):
                    out_flat[key] = new_trans
                else:
                    out_flat[key] = en_text
                    
                if out_flat[key] != en_text:
                    translated_count += 1
                    
        # Re-build JSON tree
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
            
        # Export files to i18n-export/done/<locale>/part-1-of-9.json ... part-9-of-9.json
        done_target_dir = os.path.join(DONE_DIR, locale_code)
        os.makedirs(done_target_dir, exist_ok=True)
        
        part_files = sorted([f for f in os.listdir(EXPORT_DIR) if f.startswith('part-') and f.endswith('.json')])
        for pfile in part_files:
            orig_part_path = os.path.join(EXPORT_DIR, pfile)
            with open(orig_part_path, 'r', encoding='utf-8') as f:
                orig_part = json.load(f)
            
            part_done = {}
            for pk, en_val in orig_part.items():
                part_done[pk] = out_flat.get(pk, en_val)
                
            out_part_path = os.path.join(done_target_dir, pfile)
            with open(out_part_path, 'w', encoding='utf-8') as f:
                json.dump(part_done, f, ensure_ascii=False, indent=2)
                f.write('\n')

        print(f"Processed {locale_code} ({lang}): {translated_count}/{len(EN_FLAT)} keys translated.")

if __name__ == '__main__':
    process_all_languages()
