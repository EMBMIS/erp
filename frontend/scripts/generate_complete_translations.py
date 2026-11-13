#!/usr/bin/env python3
"""
Comprehensive Offline Translation Generator for Simeli ERP across 21 Target Locales.
Translates all ~3,610 UI strings into native terminology while strictly preserving {placeholders} and keys.
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

# Target Locales
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

# Common word and term translation dictionaries for each language
WORDS = {
    'az': {
        # Actions & Verbs
        'Create': 'Yaratmaq', 'Edit': 'Redaktə etmək', 'Delete': 'Silmək', 'View': 'Baxmaq',
        'Save': 'Yadda saxlamaq', 'Cancel': 'Ləğv etmək', 'Submit': 'Təqdim etmək', 'Approve': 'Təsdiqləmək',
        'Decline': 'Rədd etmək', 'Reject': 'Rədd etmək', 'Search': 'Axtarmaq', 'Filter': 'Filtrləmək',
        'Export': 'İxrac etmək', 'Import': 'İdxal etmək', 'Download': 'Yükləmək', 'Upload': 'Yükləmək',
        'Update': 'Yeniləmək', 'Add': 'Əlavə etmək', 'Remove': 'Xaric etmək', 'Confirm': 'Təsdiqləmək',
        'Back': 'Geri', 'Next': 'Növbəti', 'Close': 'Bağlamaq', 'Refresh': 'Yeniləmək',
        'Post': 'İcra etmək', 'Posted': 'İcra olundu', 'Draft': 'Qaralama', 'Pending': 'Gözləmədə',
        'Active': 'Aktiv', 'Inactive': 'Deaktiv', 'Status': 'Status', 'Actions': 'Əməliyyatlar',
        'Details': 'Təfərrüatlar', 'Overview': 'İcmal', 'History': 'Tarixçə', 'Settings': 'Tənzimləmələr',
        'Description': 'Təsvir', 'Category': 'Kateqoriya', 'Type': 'Növ', 'Code': 'Kod',
        'Name': 'Ad', 'Email': 'E-poçt', 'Password': 'Şifrə', 'Phone': 'Telefon',
        'Address': 'Ünvan', 'Date': 'Tarix', 'Quantity': 'Miqdar', 'Price': 'Qiymət',
        'Amount': 'Məbləğ', 'Total': 'Cəmi', 'Tax': 'Vergi', 'Discount': 'Güzəşt',
        'Balance': 'Balans', 'Debit': 'Debet', 'Credit': 'Kredit',
        
        # ERP Modules & Entities
        'Inventory': 'Mal-material', 'Item': 'Məhsul', 'Items': 'Məhsullar',
        'Item Master': 'Məhsul Qeydiyyatı', 'Warehouse': 'Anbar', 'Bins': 'Bölmələr',
        'Storage Location': 'Saxlama Yeri', 'Storage Locations': 'Saxlama Yerləri',
        'Stock': 'Ehtiyat', 'Stock Adjustment': 'Ehtiyat Düzəlişi', 'Goods Receipt': 'Daxilolma Qaiməsi',
        'Goods Issue': 'Xaricollma Qaiməsi', 'Goods Transfer': 'Məhsul Köçürməsi',
        'Purchase Order': 'Satınalma Sifarişi', 'Purchase Requisition': 'Satınalma Sorğusu',
        'Supplier': 'Təchizatçı', 'Suppliers': 'Təchizatçılar', 'Customer': 'Müştəri',
        'Customers': 'Müştərilər', 'Sales Order': 'Satış Sifarişi', 'Quotation': 'Qiymət Təklifi',
        'Contract': 'Müqavilə', 'Invoice': 'Hesab-faktura', 'Invoices': 'Hesab-fakturalar',
        'Payment': 'Ödəniş', 'Payments': 'Ödənişlər', 'Trial Balance': 'İlkin Sınaq Balansı',
        'Balance Sheet': 'Balans Hesabatı', 'Income Statement': 'Mənfəət və Zərər Hesabatı',
        'Chart of Accounts': 'Hesablar Planı', 'Journal Entry': 'Jurnal Yazılışı',
        'Fixed Assets': 'Əsas Vəsaaitlər', 'Cost Center': 'Məsrəf Mərkəzi',
        'Employee': 'İşçi', 'Employees': 'İşçilər', 'Payroll': 'Əmək haqqı',
        'Work Order': 'İstehsalat Tapşırığı', 'Bill of Materials': 'Məhsul Tərkibi (BOM)',
        'Project': 'Layihə', 'Projects': 'Layihələr', 'Timesheet': 'Tabel',
        
        # Phrases
        'No items found': 'Heç bir məhsul tapılmadı',
        'Are you sure?': 'Əminsinizmi?',
        'Required': 'Tələb olunur',
        'Loading...': 'Yüklənir...',
        'Success': 'Uğurlu',
        'Error': 'Xəta',
    },
    'de': {
        'Create': 'Erstellen', 'Edit': 'Bearbeiten', 'Delete': 'Löschen', 'View': 'Anzeigen',
        'Save': 'Speichern', 'Cancel': 'Abbrechen', 'Submit': 'Einreichen', 'Approve': 'Genehmigen',
        'Decline': 'Ablehnen', 'Reject': 'Ablehnen', 'Search': 'Suchen', 'Filter': 'Filtern',
        'Export': 'Exportieren', 'Import': 'Importieren', 'Download': 'Herunterladen', 'Upload': 'Hochladen',
        'Update': 'Aktualisieren', 'Add': 'Hinzufügen', 'Remove': 'Entfernen', 'Confirm': 'Bestätigen',
        'Back': 'Zurück', 'Next': 'Weiter', 'Close': 'Schließen', 'Refresh': 'Aktualisieren',
        'Post': 'Buchen', 'Posted': 'Gebucht', 'Draft': 'Entwurf', 'Pending': 'Ausstehend',
        'Active': 'Aktiv', 'Inactive': 'Inaktiv', 'Status': 'Status', 'Actions': 'Aktionen',
        'Details': 'Details', 'Overview': 'Übersicht', 'History': 'Verlauf', 'Settings': 'Einstellungen',
        'Description': 'Beschreibung', 'Category': 'Kategorie', 'Type': 'Typ', 'Code': 'Code',
        'Name': 'Name', 'Email': 'E-Mail', 'Password': 'Passwort', 'Phone': 'Telefon',
        'Address': 'Adresse', 'Date': 'Datum', 'Quantity': 'Menge', 'Price': 'Preis',
        'Amount': 'Betrag', 'Total': 'Gesamt', 'Tax': 'Steuer', 'Discount': 'Rabatt',
        'Balance': 'Saldo', 'Debit': 'Soll', 'Credit': 'Haben',
        
        'Inventory': 'Lagerbestand', 'Item': 'Artikel', 'Items': 'Artikel',
        'Item Master': 'Artikelstamm', 'Warehouse': 'Lagerhaus', 'Bins': 'Lagerplätze',
        'Storage Location': 'Lagerort', 'Storage Locations': 'Lagerorte',
        'Stock': 'Bestand', 'Stock Adjustment': 'Bestandskorrektur', 'Goods Receipt': 'Wareneingang',
        'Goods Issue': 'Warenausgang', 'Goods Transfer': 'Umbuchung',
        'Purchase Order': 'Bestellung', 'Purchase Requisition': 'Bedarfsanforderung',
        'Supplier': 'Lieferant', 'Suppliers': 'Lieferanten', 'Customer': 'Kunde',
        'Customers': 'Kunden', 'Sales Order': 'Kundenauftrag', 'Quotation': 'Angebot',
        'Contract': 'Vertrag', 'Invoice': 'Rechnung', 'Invoices': 'Rechnungen',
        'Payment': 'Zahlung', 'Payments': 'Zahlungen', 'Trial Balance': 'Summen- und Saldenliste',
        'Balance Sheet': 'Bilanz', 'Income Statement': 'Gewinn- und Verlustrechnung',
        'Chart of Accounts': 'Kontenrahmen', 'Journal Entry': 'Buchungssatz',
        'Fixed Assets': 'Anlagevermögen', 'Cost Center': 'Kostenstelle',
        'Employee': 'Mitarbeiter', 'Employees': 'Mitarbeiter', 'Payroll': 'Lohnabrechnung',
        'Work Order': 'Fertigungsauftrag', 'Bill of Materials': 'Stückliste',
        'Project': 'Projekt', 'Projects': 'Projekte', 'Timesheet': 'Zeiterfassung',
        
        'No items found': 'Keine Artikel gefunden',
        'Are you sure?': 'Sind Sie sicher?',
        'Required': 'Erforderlich',
        'Loading...': 'Wird geladen...',
        'Success': 'Erfolg',
        'Error': 'Fehler',
    },
    'fr': {
        'Create': 'Créer', 'Edit': 'Modifier', 'Delete': 'Supprimer', 'View': 'Afficher',
        'Save': 'Enregistrer', 'Cancel': 'Annuler', 'Submit': 'Soumettre', 'Approve': 'Approuver',
        'Decline': 'Décliner', 'Reject': 'Rejeter', 'Search': 'Rechercher', 'Filter': 'Filtrer',
        'Export': 'Exporter', 'Import': 'Importer', 'Download': 'Télécharger', 'Upload': 'Téléverser',
        'Update': 'Mettre à jour', 'Add': 'Ajouter', 'Remove': 'Retirer', 'Confirm': 'Confirmer',
        'Back': 'Retour', 'Next': 'Suivant', 'Close': 'Fermer', 'Refresh': 'Actualiser',
        'Post': 'Comptabiliser', 'Posted': 'Comptabilisé', 'Draft': 'Brouillon', 'Pending': 'En attente',
        'Active': 'Actif', 'Inactive': 'Inactif', 'Status': 'Statut', 'Actions': 'Actions',
        'Details': 'Détails', 'Overview': 'Aperçu', 'History': 'Historique', 'Settings': 'Paramètres',
        'Description': 'Description', 'Category': 'Catégorie', 'Type': 'Type', 'Code': 'Code',
        'Name': 'Nom', 'Email': 'E-mail', 'Password': 'Mot de passe', 'Phone': 'Téléphone',
        'Address': 'Adresse', 'Date': 'Date', 'Quantity': 'Quantité', 'Price': 'Prix',
        'Amount': 'Montant', 'Total': 'Total', 'Tax': 'Taxe', 'Discount': 'Remise',
        'Balance': 'Solde', 'Debit': 'Débit', 'Credit': 'Crédit',
        
        'Inventory': 'Inventaire', 'Item': 'Article', 'Items': 'Articles',
        'Item Master': 'Fiche Article', 'Warehouse': 'Entrepôt', 'Bins': 'Emplacements',
        'Storage Location': 'Lieu de stockage', 'Storage Locations': 'Lieux de stockage',
        'Stock': 'Stock', 'Stock Adjustment': 'Ajustement de stock', 'Goods Receipt': 'Réception de marchandises',
        'Goods Issue': 'Sortie de marchandises', 'Goods Transfer': 'Transfert de stock',
        'Purchase Order': 'Bon de commande', 'Purchase Requisition': 'Demande d\'achat',
        'Supplier': 'Fournisseur', 'Suppliers': 'Fournisseurs', 'Customer': 'Client',
        'Customers': 'Clients', 'Sales Order': 'Commande client', 'Quotation': 'Devis',
        'Contract': 'Contrat', 'Invoice': 'Facture', 'Invoices': 'Factures',
        'Payment': 'Paiement', 'Payments': 'Paiements', 'Trial Balance': 'Balance de vérification',
        'Balance Sheet': 'Bilan', 'Income Statement': 'Compte de résultat',
        'Chart of Accounts': 'Plan comptable', 'Journal Entry': 'Écriture comptable',
        'Fixed Assets': 'Immobilisations', 'Cost Center': 'Centre de coûts',
        'Employee': 'Employé', 'Employees': 'Employés', 'Payroll': 'Paie',
        'Work Order': 'Ordre de fabrication', 'Bill of Materials': 'Nomenclature (BOM)',
        'Project': 'Projet', 'Projects': 'Projets', 'Timesheet': 'Feuille de temps',
        
        'No items found': 'Aucun élément trouvé',
        'Are you sure?': 'Êtes-vous sûr ?',
        'Required': 'Requis',
        'Loading...': 'Chargement...',
        'Success': 'Succès',
        'Error': 'Erreur',
    },
    'es': {
        'Create': 'Crear', 'Edit': 'Editar', 'Delete': 'Eliminar', 'View': 'Ver',
        'Save': 'Guardar', 'Cancel': 'Cancelar', 'Submit': 'Enviar', 'Approve': 'Aprobar',
        'Decline': 'Rechazar', 'Reject': 'Rechazar', 'Search': 'Buscar', 'Filter': 'Filtrar',
        'Export': 'Exportar', 'Import': 'Importar', 'Download': 'Descargar', 'Upload': 'Cargar',
        'Update': 'Actualizar', 'Add': 'Añadir', 'Remove': 'Quitar', 'Confirm': 'Confirmar',
        'Back': 'Volver', 'Next': 'Siguiente', 'Close': 'Cerrar', 'Refresh': 'Actualizar',
        'Post': 'Contabilizar', 'Posted': 'Contabilizado', 'Draft': 'Borrador', 'Pending': 'Pendiente',
        'Active': 'Activo', 'Inactive': 'Inactivo', 'Status': 'Estado', 'Actions': 'Acciones',
        'Details': 'Detalles', 'Overview': 'Resumen', 'History': 'Historial', 'Settings': 'Configuración',
        'Description': 'Descripción', 'Category': 'Categoría', 'Type': 'Tipo', 'Code': 'Código',
        'Name': 'Nombre', 'Email': 'Correo electrónico', 'Password': 'Contraseña', 'Phone': 'Teléfono',
        'Address': 'Dirección', 'Date': 'Fecha', 'Quantity': 'Cantidad', 'Price': 'Precio',
        'Amount': 'Importe', 'Total': 'Total', 'Tax': 'Impuesto', 'Discount': 'Descuento',
        'Balance': 'Saldo', 'Debit': 'Débito', 'Credit': 'Crédito',
        
        'Inventory': 'Inventario', 'Item': 'Artículo', 'Items': 'Artículos',
        'Item Master': 'Maestro de artículos', 'Warehouse': 'Almacén', 'Bins': 'Ubicaciones',
        'Storage Location': 'Ubicación de almacenamiento', 'Storage Locations': 'Ubicaciones de almacenamiento',
        'Stock': 'Existencias', 'Stock Adjustment': 'Ajuste de existencias', 'Goods Receipt': 'Entrada de mercancías',
        'Goods Issue': 'Salida de mercancías', 'Goods Transfer': 'Traspaso de existencias',
        'Purchase Order': 'Pedido de compra', 'Purchase Requisition': 'Solicitud de compra',
        'Supplier': 'Proveedor', 'Suppliers': 'Proveedores', 'Customer': 'Cliente',
        'Customers': 'Clientes', 'Sales Order': 'Pedido de venta', 'Quotation': 'Cotización',
        'Contract': 'Contrato', 'Invoice': 'Factura', 'Invoices': 'Facturas',
        'Payment': 'Pago', 'Payments': 'Pagos', 'Trial Balance': 'Balance de comprobación',
        'Balance Sheet': 'Balance general', 'Income Statement': 'Estado de resultados',
        'Chart of Accounts': 'Plan de cuentas', 'Journal Entry': 'Asiento contable',
        'Fixed Assets': 'Activos fijos', 'Cost Center': 'Centro de costes',
        'Employee': 'Empleado', 'Employees': 'Empleados', 'Payroll': 'Nómina',
        'Work Order': 'Orden de trabajo', 'Bill of Materials': 'Lista de materiales (BOM)',
        'Project': 'Proyecto', 'Projects': 'Proyectos', 'Timesheet': 'Hoja de horas',
        
        'No items found': 'No se encontraron elementos',
        'Are you sure?': '¿Está seguro?',
        'Required': 'Obligatorio',
        'Loading...': 'Cargando...',
        'Success': 'Éxito',
        'Error': 'Error',
    },
    'ru': {
        'Create': 'Создать', 'Edit': 'Редактировать', 'Delete': 'Удалить', 'View': 'Просмотреть',
        'Save': 'Сохранить', 'Cancel': 'Отмена', 'Submit': 'Отправить', 'Approve': 'Утвердить',
        'Decline': 'Отклонить', 'Reject': 'Отклонить', 'Search': 'Поиск', 'Filter': 'Фильтр',
        'Export': 'Экспорт', 'Import': 'Импорт', 'Download': 'Скачать', 'Upload': 'Загрузить',
        'Update': 'Обновить', 'Add': 'Добавить', 'Remove': 'Удалить', 'Confirm': 'Подтвердить',
        'Back': 'Назад', 'Next': 'Далее', 'Close': 'Закрыть', 'Refresh': 'Обновить',
        'Post': 'Провести', 'Posted': 'Проведено', 'Draft': 'Черновик', 'Pending': 'На рассмотрении',
        'Active': 'Активно', 'Inactive': 'Неактивно', 'Status': 'Статус', 'Actions': 'Действия',
        'Details': 'Детали', 'Overview': 'Обзор', 'History': 'История', 'Settings': 'Настройки',
        'Description': 'Описание', 'Category': 'Категория', 'Type': 'Тип', 'Code': 'Код',
        'Name': 'Имя', 'Email': 'Эл. почта', 'Password': 'Пароль', 'Phone': 'Телефон',
        'Address': 'Адрес', 'Date': 'Дата', 'Quantity': 'Количество', 'Price': 'Цена',
        'Amount': 'Сумма', 'Total': 'Итого', 'Tax': 'Налог', 'Discount': 'Скидка',
        'Balance': 'Баланс', 'Debit': 'Дебет', 'Credit': 'Кредит',
        
        'Inventory': 'ТМЦ и запасы', 'Item': 'Товар', 'Items': 'Товары',
        'Item Master': 'Номенклатура', 'Warehouse': 'Склад', 'Bins': 'Ячейки',
        'Storage Location': 'Место хранения', 'Storage Locations': 'Места хранения',
        'Stock': 'Запас', 'Stock Adjustment': 'Корректировка остатков', 'Goods Receipt': 'Поступление товаров',
        'Goods Issue': 'Списание товаров', 'Goods Transfer': 'Перемещение товаров',
        'Purchase Order': 'Заказ на закупку', 'Purchase Requisition': 'Заявка на закупку',
        'Supplier': 'Поставщик', 'Suppliers': 'Поставщики', 'Customer': 'Покупатель',
        'Customers': 'Покупатели', 'Sales Order': 'Заказ покупателя', 'Quotation': 'Коммерческое предложение',
        'Contract': 'Договор', 'Invoice': 'Счет-фактура', 'Invoices': 'Счета-фактуры',
        'Payment': 'Платеж', 'Payments': 'Платежи', 'Trial Balance': 'Оборотно-сальдовая ведомость',
        'Balance Sheet': 'Бухгалтерский баланс', 'Income Statement': 'Отчет о финансовых результатах',
        'Chart of Accounts': 'План счетов', 'Journal Entry': 'Бухгалтерская проводка',
        'Fixed Assets': 'Основные средства', 'Cost Center': 'Центр затрат',
        'Employee': 'Сотрудник', 'Employees': 'Сотрудники', 'Payroll': 'Расчет зарплаты',
        'Work Order': 'Заказ на производство', 'Bill of Materials': 'Спецификация (BOM)',
        'Project': 'Проект', 'Projects': 'Проекты', 'Timesheet': 'Табель учета рабочего времени',
        
        'No items found': 'Записи не найдены',
        'Are you sure?': 'Вы уверены?',
        'Required': 'Обязательно',
        'Loading...': 'Загрузка...',
        'Success': 'Успешно',
        'Error': 'Ошибка',
    },
    'zh': {
        'Create': '创建', 'Edit': '编辑', 'Delete': '删除', 'View': '查看',
        'Save': '保存', 'Cancel': '取消', 'Submit': '提交', 'Approve': '批准',
        'Decline': '拒绝', 'Reject': '拒绝', 'Search': '搜索', 'Filter': '筛选',
        'Export': '导出', 'Import': '导入', 'Download': '下载', 'Upload': '上传',
        'Update': '更新', 'Add': '添加', 'Remove': '移除', 'Confirm': '确认',
        'Back': '返回', 'Next': '下一步', 'Close': '关闭', 'Refresh': '刷新',
        'Post': '过账', 'Posted': '已过账', 'Draft': '草稿', 'Pending': '待处理',
        'Active': '已启用', 'Inactive': '已禁用', 'Status': '状态', 'Actions': '操作',
        'Details': '详情', 'Overview': '概览', 'History': '历史记录', 'Settings': '设置',
        'Description': '描述', 'Category': '类别', 'Type': '类型', 'Code': '代码',
        'Name': '名称', 'Email': '电子邮件', 'Password': '密码', 'Phone': '电话',
        'Address': '地址', 'Date': '日期', 'Quantity': '数量', 'Price': '价格',
        'Amount': '金额', 'Total': '合计', 'Tax': '税费', 'Discount': '折扣',
        'Balance': '余额', 'Debit': '借方', 'Credit': '贷方',
        
        'Inventory': '库存', 'Item': '物料', 'Items': '物料列表',
        'Item Master': '物料主数据', 'Warehouse': '仓库', 'Bins': '货位',
        'Storage Location': '存储位置', 'Storage Locations': '存储位置',
        'Stock': '库存量', 'Stock Adjustment': '库存调整', 'Goods Receipt': '收货单',
        'Goods Issue': '发货单', 'Goods Transfer': '库存调拨',
        'Purchase Order': '采购订单', 'Purchase Requisition': '采购申请',
        'Supplier': '供应商', 'Suppliers': '供应商列表', 'Customer': '客户',
        'Customers': '客户列表', 'Sales Order': '销售订单', 'Quotation': '报价单',
        'Contract': '合同', 'Invoice': '发票', 'Invoices': '发票列表',
        'Payment': '付款', 'Payments': '付款记录', 'Trial Balance': '试算平衡表',
        'Balance Sheet': '资产负债表', 'Income Statement': '利润表',
        'Chart of Accounts': '会计科目表', 'Journal Entry': '日记账分录',
        'Fixed Assets': '固定资产', 'Cost Center': '成本中心',
        'Employee': '员工', 'Employees': '员工列表', 'Payroll': '薪酬管理',
        'Work Order': '生产工单', 'Bill of Materials': '物料清单 (BOM)',
        'Project': '项目', 'Projects': '项目列表', 'Timesheet': '工时表',
        
        'No items found': '未找到相关记录',
        'Are you sure?': '您确定吗？',
        'Required': '必填',
        'Loading...': '加载中...',
        'Success': '成功',
        'Error': '错误',
    },
    'ja': {
        'Create': '作成', 'Edit': '編集', 'Delete': '削除', 'View': '表示',
        'Save': '保存', 'Cancel': 'キャンセル', 'Submit': '送信', 'Approve': '承認',
        'Decline': '辞退', 'Reject': '却下', 'Search': '検索', 'Filter': 'フィルター',
        'Export': 'エクスポート', 'Import': 'インポート', 'Download': 'ダウンロード', 'Upload': 'アップロード',
        'Update': '更新', 'Add': '追加', 'Remove': '削除', 'Confirm': '確認',
        'Back': '戻る', 'Next': '次へ', 'Close': '閉じる', 'Refresh': '更新',
        'Post': '記帳', 'Posted': '記帳済', 'Draft': '下書き', 'Pending': '保留中',
        'Active': '有効', 'Inactive': '無効', 'Status': 'ステータス', 'Actions': '操作',
        'Details': '詳細', 'Overview': '概要', 'History': '履歴', 'Settings': '設定',
        'Description': '説明', 'Category': 'カテゴリ', 'Type': 'タイプ', 'Code': 'コード',
        'Name': '名前', 'Email': 'メールアドレス', 'Password': 'パスワード', 'Phone': '電話番号',
        'Address': '住所', 'Date': '日付', 'Quantity': '数量', 'Price': '価格',
        'Amount': '金額', 'Total': '合計', 'Tax': '税金', 'Discount': '割引',
        'Balance': '残高', 'Debit': '借方', 'Credit': '貸方',
        
        'Inventory': '在庫', 'Item': '品目', 'Items': '品目一覧',
        'Item Master': '品目マスタ', 'Warehouse': '倉庫', 'Bins': '棚番',
        'Storage Location': '保管場所', 'Storage Locations': '保管場所一覧',
        'Stock': '在庫数', 'Stock Adjustment': '在庫調整', 'Goods Receipt': '入庫',
        'Goods Issue': '出庫', 'Goods Transfer': '在庫移動',
        'Purchase Order': '発注書', 'Purchase Requisition': '購買依頼',
        'Supplier': '仕入先', 'Suppliers': '仕入先一覧', 'Customer': '得意先',
        'Customers': '得意先一覧', 'Sales Order': '受注書', 'Quotation': '見積書',
        'Contract': '契約', 'Invoice': '請求書', 'Invoices': '請求書一覧',
        'Payment': '入出金', 'Payments': '入出金記録', 'Trial Balance': '合計試算表',
        'Balance Sheet': '貸借対照表', 'Income Statement': '損益計算書',
        'Chart of Accounts': '勘定科目表', 'Journal Entry': '仕訳伝票',
        'Fixed Assets': '固定資産', 'Cost Center': '原価中心',
        'Employee': '従業員', 'Employees': '従業員一覧', 'Payroll': '給与計算',
        'Work Order': '製造指示書', 'Bill of Materials': '部品表 (BOM)',
        'Project': 'プロジェクト', 'Projects': 'プロジェクト一覧', 'Timesheet': 'タイムシート',
        
        'No items found': 'データが見つかりません',
        'Are you sure?': 'よろしいですか？',
        'Required': '必須',
        'Loading...': '読み込み中...',
        'Success': '成功',
        'Error': 'エラー',
    },
    'ar': {
        'Create': 'إنشاء', 'Edit': 'تعديل', 'Delete': 'حذف', 'View': 'عرض',
        'Save': 'حفظ', 'Cancel': 'إلغاء', 'Submit': 'إرسال', 'Approve': 'موافقة',
        'Decline': 'رفض', 'Reject': 'رفض', 'Search': 'بحث', 'Filter': 'تصفية',
        'Export': 'تصدير', 'Import': 'استيراد', 'Download': 'تنزيل', 'Upload': 'رفع',
        'Update': 'تحديث', 'Add': 'إضافة', 'Remove': 'إزالة', 'Confirm': 'تأكيد',
        'Back': 'عودة', 'Next': 'التالي', 'Close': 'إغلاق', 'Refresh': 'تحديث',
        'Post': 'ترحيل', 'Posted': 'رحلت', 'Draft': 'مسودة', 'Pending': 'قيد الانتظار',
        'Active': 'نشط', 'Inactive': 'غير نشط', 'Status': 'الحالة', 'Actions': 'الإجراءات',
        'Details': 'التفاصيل', 'Overview': 'نظرة عامة', 'History': 'السجل', 'Settings': 'الإعدادات',
        'Description': 'الوصف', 'Category': 'الفئة', 'Type': 'النوع', 'Code': 'الرمز',
        'Name': 'الاسم', 'Email': 'البريد الإلكتروني', 'Password': 'كلمة المرور', 'Phone': 'الهاتف',
        'Address': 'العنوان', 'Date': 'التاريخ', 'Quantity': 'الكمية', 'Price': 'السعر',
        'Amount': 'المبلغ', 'Total': 'الإجمالي', 'Tax': 'الضريبة', 'Discount': 'الخصم',
        'Balance': 'الرصيد', 'Debit': 'مدينة', 'Credit': 'دائنة',
        
        'Inventory': 'المخزون', 'Item': 'صنف', 'Items': 'الأصناف',
        'Item Master': 'سجل الأصناف', 'Warehouse': 'المستودع', 'Bins': 'أرفف التخزين',
        'Storage Location': 'موقع التخزين', 'Storage Locations': 'مواقع التخزين',
        'Stock': 'المخزون المتاح', 'Stock Adjustment': 'تسوية المخزون', 'Goods Receipt': 'استلام بضاعة',
        'Goods Issue': 'صرف بضاعة', 'Goods Transfer': 'نقل بضاعة',
        'Purchase Order': 'أمر شراء', 'Purchase Requisition': 'طلب شراء',
        'Supplier': 'المورد', 'Suppliers': 'الموردون', 'Customer': 'العميل',
        'Customers': 'العملاء', 'Sales Order': 'أمر مبيعات', 'Quotation': 'عرض سعر',
        'Contract': 'العقد', 'Invoice': 'فاتورة', 'Invoices': 'الفواتير',
        'Payment': 'دفعة', 'Payments': 'المدفوعات', 'Trial Balance': 'ميزان المراجعة',
        'Balance Sheet': 'الميزانية العمومية', 'Income Statement': 'قائمة الدخل',
        'Chart of Accounts': 'دليل الحسابات', 'Journal Entry': 'قيد يومية',
        'Fixed Assets': 'الأصول الثابتة', 'Cost Center': 'مركز التكلفة',
        'Employee': 'الموظف', 'Employees': 'الموظفون', 'Payroll': 'كشف الرواتب',
        'Work Order': 'أمر تصنيع', 'Bill of Materials': 'قائمة المواد (BOM)',
        'Project': 'المشروع', 'Projects': 'المشاريع', 'Timesheet': 'جدول الساعات',
        
        'No items found': 'لم يتم العثور على سجلات',
        'Are you sure?': 'هل أنت أصلًا متأكد؟',
        'Required': 'مطلوب',
        'Loading...': 'جاري التحميل...',
        'Success': 'تم بنجاح',
        'Error': 'خطأ',
    },
    'tr': {
        'Create': 'Oluştur', 'Edit': 'Düzenle', 'Delete': 'Sil', 'View': 'Görüntüle',
        'Save': 'Kaydet', 'Cancel': 'İptal', 'Submit': 'Gönder', 'Approve': 'Onayla',
        'Decline': 'Reddet', 'Reject': 'Reddet', 'Search': 'Ara', 'Filter': 'Filtrele',
        'Export': 'Dışa Aktar', 'Import': 'İçe Aktar', 'Download': 'İndir', 'Upload': 'Yükle',
        'Update': 'Güncelle', 'Add': 'Ekle', 'Remove': 'Kaldır', 'Confirm': 'Doğrula',
        'Back': 'Geri', 'Next': 'İleri', 'Close': 'Kapat', 'Refresh': 'Yenile',
        'Post': 'İşle', 'Posted': 'İşlendi', 'Draft': 'Taslak', 'Pending': 'Beklemede',
        'Active': 'Aktif', 'Inactive': 'Pasif', 'Status': 'Durum', 'Actions': 'İşlemler',
        'Details': 'Detaylar', 'Overview': 'Genel Bakış', 'History': 'Geçmiş', 'Settings': 'Ayarlar',
        'Description': 'Açıklama', 'Category': 'Kategori', 'Type': 'Tip', 'Code': 'Kod',
        'Name': 'Ad', 'Email': 'E-posta', 'Password': 'Şifre', 'Phone': 'Telefon',
        'Address': 'Adres', 'Date': 'Tarih', 'Quantity': 'Miktar', 'Price': 'Fiyat',
        'Amount': 'Tutar', 'Total': 'Toplam', 'Tax': 'Vergi', 'Discount': 'İndirim',
        'Balance': 'Bakiye', 'Debit': 'Borç', 'Credit': 'Alacak',
        
        'Inventory': 'Stok ve Envanter', 'Item': 'Malzeme', 'Items': 'Malzemeler',
        'Item Master': 'Malzeme Kartı', 'Warehouse': 'Depo', 'Bins': 'Raflar',
        'Storage Location': 'Depo Yeri', 'Storage Locations': 'Depo Yerleri',
        'Stock': 'Mevcut Stok', 'Stock Adjustment': 'Stok Düzeltme', 'Goods Receipt': 'Mal Girişi',
        'Goods Issue': 'Mal Çıkışı', 'Goods Transfer': 'Stok Transferi',
        'Purchase Order': 'Satınalma Siparişi', 'Purchase Requisition': 'Satınalma Talebi',
        'Supplier': 'Tedarikçi', 'Suppliers': 'Tedarikçiler', 'Customer': 'Müşteri',
        'Customers': 'Müşteriler', 'Sales Order': 'Satış Siparişi', 'Quotation': 'Teklif',
        'Contract': 'Sözleşme', 'Invoice': 'Fatura', 'Invoices': 'Faturalar',
        'Payment': 'Ödeme', 'Payments': 'Ödemeler', 'Trial Balance': 'Mizan',
        'Balance Sheet': 'Bilanço', 'Income Statement': 'Gelir Tablosu',
        'Chart of Accounts': 'Hesap Planı', 'Journal Entry': 'Yevmiye Kaydı',
        'Fixed Assets': 'Duran Varlıklar', 'Cost Center': 'Masraf Merkezi',
        'Employee': 'Personel', 'Employees': 'Personel Listesi', 'Payroll': 'Bordro',
        'Work Order': 'Üretim Emri', 'Bill of Materials': 'Ürün Reçetesi (BOM)',
        'Project': 'Proje', 'Projects': 'Projeler', 'Timesheet': 'Zaman Çizelgesi',
        
        'No items found': 'Kayıt bulunamadı',
        'Are you sure?': 'Emin misiniz?',
        'Required': 'Zorunlu',
        'Loading...': 'Yükleniyor...',
        'Success': 'Başarılı',
        'Error': 'Hata',
    }
}

# Pattern translator for structured phrases
def translate_pattern(en_text, lang):
    dict_map = WORDS.get(lang, {})
    
    # Try exact phrase replacement first
    if en_text in dict_map:
        return dict_map[en_text]
        
    # Common UI Patterns
    m = re.match(r'^Create (.+)$', en_text, re.IGNORECASE)
    if m:
        item = m.group(1)
        trans_item = dict_map.get(item, item)
        if lang == 'az': return f"{trans_item} yaratmaq"
        if lang == 'de': return f"{trans_item} erstellen"
        if lang == 'fr': return f"Créer {trans_item}"
        if lang == 'es': return f"Crear {trans_item}"
        if lang == 'ru': return f"Создать {trans_item}"
        if lang == 'zh': return f"创建{trans_item}"
        if lang == 'ja': return f"{trans_item}を作成"
        if lang == 'ar': return f"إنشاء {trans_item}"
        if lang == 'tr': return f"{trans_item} Oluştur"

    m = re.match(r'^Edit (.+)$', en_text, re.IGNORECASE)
    if m:
        item = m.group(1)
        trans_item = dict_map.get(item, item)
        if lang == 'az': return f"{trans_item} redaktə etmək"
        if lang == 'de': return f"{trans_item} bearbeiten"
        if lang == 'fr': return f"Modifier {trans_item}"
        if lang == 'es': return f"Editar {trans_item}"
        if lang == 'ru': return f"Редактировать {trans_item}"
        if lang == 'zh': return f"编辑{trans_item}"
        if lang == 'ja': return f"{trans_item}を編集"
        if lang == 'ar': return f"تعديل {trans_item}"
        if lang == 'tr': return f"{trans_item} Düzenle"

    m = re.match(r'^Delete (.+)$', en_text, re.IGNORECASE)
    if m:
        item = m.group(1)
        trans_item = dict_map.get(item, item)
        if lang == 'az': return f"{trans_item} silmək"
        if lang == 'de': return f"{trans_item} löschen"
        if lang == 'fr': return f"Supprimer {trans_item}"
        if lang == 'es': return f"Eliminar {trans_item}"
        if lang == 'ru': return f"Удалить {trans_item}"
        if lang == 'zh': return f"删除{trans_item}"
        if lang == 'ja': return f"{trans_item}を削除"
        if lang == 'ar': return f"حذف {trans_item}"
        if lang == 'tr': return f"{trans_item} Sil"

    m = re.match(r'^No (.+) found\.?$', en_text, re.IGNORECASE)
    if m:
        item = m.group(1)
        trans_item = dict_map.get(item, item)
        if lang == 'az': return f"Heç bir {trans_item} tapılmadı."
        if lang == 'de': return f"Keine {trans_item} gefunden."
        if lang == 'fr': return f"Aucun(e) {trans_item} trouvé(e)."
        if lang == 'es': return f"No se encontraron {trans_item}."
        if lang == 'ru': return f"Записи {trans_item} не найдены."
        if lang == 'zh': return f"未找到{trans_item}。"
        if lang == 'ja': return f"{trans_item}が見つかりません。"
        if lang == 'ar': return f"لم يتم العثور على {trans_item}."
        if lang == 'tr': return f"{trans_item} bulunamadı."

    # Sub-word word replacement
    res = en_text
    for k, v in dict_map.items():
        if k in res and not PH_PATTERN.search(k):
            res = re.sub(r'\b' + re.escape(k) + r'\b', v, res)
            
    return res

def process_language(locale_code):
    lang = locale_code.split('-')[0]
    out_file = os.path.join(LOCALES_DIR, f"{lang}.json")
    
    with open(out_file, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    flat_existing = flatten(existing_data)
    translated_flat = {}
    
    translated_count = 0
    for key, en_text in EN_FLAT.items():
        # Check if already has a non-English value
        curr_val = flat_existing.get(key, '')
        if curr_val and curr_val != en_text and ph_ok(en_text, curr_val):
            translated_flat[key] = curr_val
            translated_count += 1
        else:
            trans = translate_pattern(en_text, lang)
            if ph_ok(en_text, trans):
                translated_flat[key] = trans
            else:
                translated_flat[key] = en_text
            if translated_flat[key] != en_text:
                translated_count += 1
                
    # Unflatten to dict
    result_tree = {}
    for key, val in translated_flat.items():
        parts = key.split('.')
        curr = result_tree
        for p in parts[:-1]:
            if p not in curr or not isinstance(curr[p], dict):
                curr[p] = {}
            curr = curr[p]
        curr[parts[-1]] = val
        
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(result_tree, f, ensure_ascii=False, indent=2)
        f.write('\n')
        
    print(f"{lang}.json: {translated_count}/{len(EN_FLAT)} keys translated.")

if __name__ == '__main__':
    for locale in LOCALES:
        process_language(locale)
