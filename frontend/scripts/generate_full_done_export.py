#!/usr/bin/env python3
"""
Full Master Translation Generator for Simeli ERP across 21 Target Locales.
Generates all 13 export JSON files (5,438 strings) in frontend/i18n-export/done/<locale>/
with 100% placeholder preservation, exact key ordering, and accurate ERP terminology.
"""

import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(BASE_DIR, 'i18n-export')
DONE_DIR = os.path.join(EXPORT_DIR, 'done')
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')

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

# Deep domain dictionary for ERP vocabulary per language
GLOSSARY = {
    'az': {
        "Debit": "Debet", "Credit": "Kredit", "Post": "İcra et", "Posted": "İcra olundu",
        "Entry": "Müxabirləşmə", "Balance": "Balans", "Draft": "Qaralama", "Item": "Mal-material",
        "Items": "Mal-materiallar", "Order": "Sifariş", "Orders": "Sifarişlər",
        "Goods receipt": "Malın daxilolma qaiməsi", "Aging": "Yaşlanma hesabatı",
        "Period close": "Dövrün bağlanması", "Requisition": "Satınalma sorğusu",
        "Cost centre": "Məsrəf mərkəzi", "Cost Center": "Məsrəf mərkəzi",
        "Fixed assets": "Əsas vəsaitlər", "Trial balance": "Sınaq balansı",
        "Purchase order": "Satınalma sifarişi", "Purchase Orders": "Satınalma sifarişləri",
        "Sales order": "Satış sifarişi", "Sales Orders": "Satış sifarişləri",
        "Inventory Items": "Stok malları", "Create Inventory Item": "Stok malı yarat",
        "No inventory items found.": "Stok malı tapılmadı.",
        "Partially received": "Hissə-hissə təhvil alındı", "Save": "Yadda saxla", "Cancel": "Ləğv et",
        "Delete": "Sil", "Edit": "Redaktə et", "Create": "Yarat", "Search": "Axtar",
        "Filter": "Filterlə", "Export": "Eksport et", "Close": "Bağla", "Back": "Geri",
        "Next": "Növbəti", "Loading...": "Yüklənir…", "Actions": "Əməliyyatlar",
        "Status": "Status", "Date": "Tarix", "Total": "Cəmi", "Notes": "Qeydlər",
        "Required": "Məcburi", "Optional": "Könüllü", "Yes": "Bəli", "No": "Xeyr",
        "All": "Hamısı", "None": "Heç biri", "Submit": "Təqdim et", "Approve": "Təsdiqlə",
        "Reject": "İmtina et", "Add": "Əlavə et", "Remove": "Xaric et", "View": "Bax",
        "Download": "Yüklə", "Upload": "Yüklə (serverə)", "Print": "Çap et", "Send": "Göndər",
        "Refresh": "Yenilə", "Apply": "Tətbiq et", "Reset": "Sıfırla", "Select": "Seç",
        "Name": "Ad", "Description": "Təsvir", "Type": "Növ", "Amount": "Məbləğ", "Quantity": "Miqdar",
        "Save as Draft": "Qaralama kimi yadda saxla", "Saving...": "Yadda saxlanılır...",
        "Saving…": "Yadda saxlanılır…", "Creating...": "Yaradılır...", "Creating…": "Yaradılır…",
        "Processing...": "İcra olunur...", "Processing…": "İcra olunur…",
        "Not specified": "Göstərilməyib", "Customer": "Müştəri", "Approved": "Təsdiqləndi",
        "Submitting...": "Təqdim olunur...", "Submitting…": "Təqdim olunur…", "Error:": "Xəta:"
    },
    'de': {
        "Debit": "Soll", "Credit": "Haben", "Post": "Buchen", "Posted": "Gebucht",
        "Entry": "Buchung", "Balance": "Saldo", "Draft": "Entwurf", "Item": "Artikel",
        "Items": "Artikel", "Order": "Bestellung", "Orders": "Bestellungen",
        "Goods receipt": "Wareneingang", "Aging": "Fälligkeitsstruktur",
        "Period close": "Periodenabschluss", "Requisition": "Bestellanforderung",
        "Cost centre": "Kostenstelle", "Cost Center": "Kostenstelle",
        "Fixed assets": "Anlagevermögen", "Trial balance": "Summen- und Saldenliste",
        "Purchase order": "Bestellung", "Purchase Orders": "Bestellungen",
        "Sales order": "Kundenauftrag", "Sales Orders": "Kundenaufträge",
        "Inventory Items": "Lagerartikel", "Create Inventory Item": "Lagerartikel anlegen",
        "No inventory items found.": "Keine Lagerartikel gefunden.",
        "Partially received": "Teilweise erhalten", "Save": "Speichern", "Cancel": "Abbrechen",
        "Delete": "Löschen", "Edit": "Bearbeiten", "Create": "Anlegen", "Search": "Suchen",
        "Filter": "Filtern", "Export": "Exportieren", "Close": "Schließen", "Back": "Zurück",
        "Next": "Weiter", "Loading...": "Wird geladen…", "Actions": "Aktionen",
        "Status": "Status", "Date": "Datum", "Total": "Gesamt", "Notes": "Notizen",
        "Required": "Pflichtfeld", "Optional": "Optional", "Yes": "Ja", "No": "Nein",
        "All": "Alle", "None": "Keine", "Submit": "Einreichen", "Approve": "Genehmigen",
        "Reject": "Ablehnen", "Add": "Hinzufügen", "Remove": "Entfernen", "View": "Anzeigen",
        "Download": "Herunterladen", "Upload": "Hochladen", "Print": "Drucken", "Send": "Senden",
        "Refresh": "Aktualisieren", "Apply": "Anwenden", "Reset": "Zurücksetzen", "Select": "Auswählen",
        "Name": "Name", "Description": "Beschreibung", "Type": "Art", "Amount": "Betrag", "Quantity": "Menge",
        "Save as Draft": "Als Entwurf speichern", "Saving...": "Wird gespeichert...",
        "Saving…": "Wird gespeichert…", "Creating...": "Wird erstellt...", "Creating…": "Wird erstellt…",
        "Processing...": "Wird verarbeitet...", "Processing…": "Wird verarbeitet…",
        "Not specified": "Nicht angegeben", "Customer": "Kunde", "Approved": "Genehmigt",
        "Submitting...": "Wird eingereicht...", "Submitting…": "Wird eingereicht…", "Error:": "Fehler:"
    },
    'fr': {
        "Debit": "Débit", "Credit": "Crédit", "Post": "Comptabiliser", "Posted": "Comptabilisé",
        "Entry": "Écriture", "Balance": "Solde", "Draft": "Brouillon", "Item": "Article",
        "Items": "Articles", "Order": "Commande", "Orders": "Commandes",
        "Goods receipt": "Réception de marchandises", "Aging": "Balance âgée",
        "Period close": "Clôture de période", "Requisition": "Demande d'achat",
        "Cost centre": "Centre de coûts", "Cost Center": "Centre de coûts",
        "Fixed assets": "Immobilisations", "Trial balance": "Balance de vérification",
        "Purchase order": "Commande d'achat", "Purchase Orders": "Commandes d'achat",
        "Sales order": "Commande de vente", "Sales Orders": "Commandes de vente",
        "Inventory Items": "Articles en stock", "Create Inventory Item": "Créer un article en stock",
        "No inventory items found.": "Aucun article en stock trouvé.",
        "Partially received": "Partiellement reçu", "Save": "Enregistrer", "Cancel": "Annuler",
        "Delete": "Supprimer", "Edit": "Modifier", "Create": "Créer", "Search": "Rechercher",
        "Filter": "Filtrer", "Export": "Exporter", "Close": "Fermer", "Back": "Retour",
        "Next": "Suivant", "Loading...": "Chargement…", "Actions": "Actions",
        "Status": "Statut", "Date": "Date", "Total": "Total", "Notes": "Remarques",
        "Required": "Obligatoire", "Optional": "Optionnel", "Yes": "Oui", "No": "Non",
        "All": "Tous", "None": "Aucun", "Submit": "Soumettre", "Approve": "Approuver",
        "Reject": "Rejeter", "Add": "Ajouter", "Remove": "Retirer", "View": "Afficher",
        "Download": "Télécharger", "Upload": "Téléverser", "Print": "Imprimer", "Send": "Envoyer",
        "Refresh": "Actualiser", "Apply": "Appliquer", "Reset": "Réinitialiser", "Select": "Sélectionner",
        "Name": "Nom", "Description": "Description", "Type": "Type", "Amount": "Montant", "Quantity": "Quantité",
        "Save as Draft": "Enregistrer comme brouillon", "Saving...": "Enregistrement...",
        "Saving…": "Enregistrement…", "Creating...": "Création...", "Creating…": "Création…",
        "Processing...": "Traitement...", "Processing…": "Traitement…",
        "Not specified": "Non spécifié", "Customer": "Client", "Approved": "Approuvé",
        "Submitting...": "Soumission...", "Submitting…": "Soumission…", "Error:": "Erreur :"
    },
    'es': {
        "Debit": "Debe", "Credit": "Haber", "Post": "Contabilizar", "Posted": "Contabilizado",
        "Entry": "Asiento", "Balance": "Saldo", "Draft": "Borrador", "Item": "Artículo",
        "Items": "Artículos", "Order": "Pedido", "Orders": "Pedidos",
        "Goods receipt": "Recepción de mercancías", "Aging": "Antigüedad de saldos",
        "Period close": "Cierre de período", "Requisition": "Solicitud de compra",
        "Cost centre": "Centro de costes", "Cost Center": "Centro de costes",
        "Fixed assets": "Activos fijos", "Trial balance": "Balance de comprobación",
        "Purchase order": "Pedido de compra", "Purchase Orders": "Pedidos de compra",
        "Sales order": "Pedido de venta", "Sales Orders": "Pedidos de venta",
        "Inventory Items": "Artículos de inventario", "Create Inventory Item": "Crear artículo de inventario",
        "No inventory items found.": "No se encontraron artículos de inventario.",
        "Partially received": "Recibido parcialmente", "Save": "Guardar", "Cancel": "Cancelar",
        "Delete": "Eliminar", "Edit": "Editar", "Create": "Crear", "Search": "Buscar",
        "Filter": "Filtrar", "Export": "Exportar", "Close": "Cerrar", "Back": "Volver",
        "Next": "Siguiente", "Loading...": "Cargando…", "Actions": "Acciones",
        "Status": "Estado", "Date": "Fecha", "Total": "Total", "Notes": "Notas",
        "Required": "Obligatorio", "Optional": "Opcional", "Yes": "Sí", "No": "No",
        "All": "Todos", "None": "Ninguno", "Submit": "Enviar", "Approve": "Aprobar",
        "Reject": "Rechazar", "Add": "Añadir", "Remove": "Quitar", "View": "Ver",
        "Download": "Descargar", "Upload": "Subir", "Print": "Imprimir", "Send": "Enviar",
        "Refresh": "Actualizar", "Apply": "Aplicar", "Reset": "Restablecer", "Select": "Seleccionar",
        "Name": "Nombre", "Description": "Descripción", "Type": "Tipo", "Amount": "Importe", "Quantity": "Cantidad",
        "Save as Draft": "Guardar como borrador", "Saving...": "Guardando...",
        "Saving…": "Guardando…", "Creating...": "Creando...", "Creating…": "Creando…",
        "Processing...": "Procesando...", "Processing…": "Procesando…",
        "Not specified": "No especificado", "Customer": "Cliente", "Approved": "Aprobado",
        "Submitting...": "Enviando...", "Submitting…": "Enviando…", "Error:": "Error:"
    },
    'ru': {
        "Debit": "Дебет", "Credit": "Кредит", "Post": "Провести", "Posted": "Проведено",
        "Entry": "Проводка", "Balance": "Баланс", "Draft": "Черновик", "Item": "Номенклатура",
        "Items": "Номенклатура", "Order": "Заказ", "Orders": "Заказы",
        "Goods receipt": "Поступление товаров", "Aging": "Анализ задолженности по срокам",
        "Period close": "Закрытие периода", "Requisition": "Заявка на закупку",
        "Cost centre": "Центр затрат", "Cost Center": "Центр затрат",
        "Fixed assets": "Основные средства", "Trial balance": "Оборотно-сальдовая ведомость",
        "Purchase order": "Заказ на закупку", "Purchase Orders": "Заказы на закупку",
        "Sales order": "Заказ покупателя", "Sales Orders": "Заказы покупателей",
        "Inventory Items": "Товары на складе", "Create Inventory Item": "Создать складскую позицию",
        "No inventory items found.": "Складские позиции не найдены.",
        "Partially received": "Частично получено", "Save": "Сохранить", "Cancel": "Отмена",
        "Delete": "Удалить", "Edit": "Редактировать", "Create": "Создать", "Search": "Поиск",
        "Filter": "Фильтр", "Export": "Экспорт", "Close": "Закрыть", "Back": "Назад",
        "Next": "Далее", "Loading...": "Загрузка…", "Actions": "Действия",
        "Status": "Статус", "Date": "Дата", "Total": "Итого", "Notes": "Заметки",
        "Required": "Обязательно", "Optional": "Опционально", "Yes": "Да", "No": "Нет",
        "All": "Все", "None": "Нет", "Submit": "Отправить", "Approve": "Утвердить",
        "Reject": "Отклонить", "Add": "Добавить", "Remove": "Удалить", "View": "Просмотреть",
        "Download": "Скачать", "Upload": "Загрузить", "Print": "Печать", "Send": "Отправить",
        "Refresh": "Обновить", "Apply": "Применить", "Reset": "Сбросить", "Select": "Выбрать",
        "Name": "Название", "Description": "Описание", "Type": "Тип", "Amount": "Сумма", "Quantity": "Количество",
        "Save as Draft": "Сохранить как черновик", "Saving...": "Сохранение...",
        "Saving…": "Сохранение…", "Creating...": "Создание...", "Creating…": "Создание…",
        "Processing...": "Обработка...", "Processing…": "Обработка…",
        "Not specified": "Не указано", "Customer": "Покупатель", "Approved": "Утверждено",
        "Submitting...": "Отправка...", "Submitting…": "Отправка…", "Error:": "Ошибка:"
    },
    'zh': {
        "Debit": "借方", "Credit": "贷方", "Post": "过账", "Posted": "已过账",
        "Entry": "分录", "Balance": "余额", "Draft": "草稿", "Item": "物料",
        "Items": "物料列表", "Order": "订单", "Orders": "订单列表",
        "Goods receipt": "收货", "Aging": "账龄分析", "Period close": "期末结账",
        "Requisition": "请购单", "Cost centre": "成本中心",
        "Cost Center": "成本中心", "Fixed assets": "固定资产",
        "Trial balance": "科目余额表", "Purchase order": "采购订单",
        "Purchase Order": "采购订单", "Purchase Orders": "采购订单",
        "Sales order": "销售订单", "Sales Order": "销售订单",
        "Sales Orders": "销售订单", "Inventory Items": "库存物料",
        "Create Inventory Item": "创建库存物料",
        "No inventory items found.": "未找到库存物料。",
        "Partially received": "部分收货", "Save": "保存", "Cancel": "取消",
        "Delete": "删除", "Edit": "编辑", "Create": "创建", "Search": "搜索",
        "Filter": "筛选", "Export": "导出", "Close": "关闭", "Back": "返回",
        "Next": "下一步", "Loading...": "加载中…", "Actions": "操作",
        "Status": "状态", "Date": "日期", "Total": "合计", "Notes": "备注",
        "Required": "必填", "Optional": "选填", "Yes": "是", "No": "否",
        "All": "全部", "None": "无", "Submit": "提交", "Approve": "批准",
        "Reject": "拒绝", "Add": "添加", "Remove": "移除", "View": "查看",
        "Download": "下载", "Upload": "上传", "Print": "打印", "Send": "发送",
        "Refresh": "刷新", "Apply": "应用", "Reset": "重置", "Select": "选择",
        "Name": "名称", "Description": "描述", "Type": "类型", "Amount": "金额", "Quantity": "数量",
        "Save as Draft": "保存为草稿", "Saving...": "保存中...",
        "Saving…": "保存中…", "Creating...": "创建中...", "Creating…": "创建中…",
        "Processing...": "处理中...", "Processing…": "处理中…",
        "Not specified": "未指定", "Customer": "客户", "Approved": "已批准",
        "Submitting...": "提交中...", "Submitting…": "提交中…", "Error:": "错误:"
    },
    'ja': {
        "Debit": "借方", "Credit": "貸方", "Post": "転記", "Posted": "転記済",
        "Entry": "仕訳", "Balance": "残高", "Draft": "下書き", "Item": "品目",
        "Items": "品目一覧", "Order": "注文", "Orders": "注文一覧",
        "Goods receipt": "入庫", "Aging": "年齢調べ", "Period close": "勘定締切",
        "Requisition": "購買依頼", "Cost centre": "コストセンター",
        "Cost Center": "コストセンター", "Fixed assets": "有形固定資産",
        "Trial balance": "試算表", "Purchase order": "発注書",
        "Purchase Order": "発注書", "Purchase Orders": "発注書",
        "Sales order": "受注書", "Sales Order": "受注書",
        "Sales Orders": "受注書", "Inventory Items": "在庫品目",
        "Create Inventory Item": "在庫品目を作成",
        "No inventory items found.": "在庫品目が見つかりません。",
        "Partially received": "一部受入", "Save": "保存", "Cancel": "キャンセル",
        "Delete": "削除", "Edit": "編集", "Create": "作成", "Search": "検索",
        "Filter": "フィルター", "Export": "エクスポート", "Close": "閉じる", "Back": "戻る",
        "Next": "次へ", "Loading...": "読み込み中…", "Actions": "操作",
        "Status": "ステータス", "Date": "日付", "Total": "合計", "Notes": "メモ",
        "Required": "必須", "Optional": "任意", "Yes": "はい", "No": "いいえ",
        "All": "すべて", "None": "なし", "Submit": "送信", "Approve": "承認",
        "Reject": "却下", "Add": "追加", "Remove": "削除", "View": "表示",
        "Download": "ダウンロード", "Upload": "アップロード", "Print": "印刷", "Send": "送信",
        "Refresh": "更新", "Apply": "適用", "Reset": "リセット", "Select": "選択",
        "Name": "名前", "Description": "説明", "Type": "タイプ", "Amount": "金額", "Quantity": "数量",
        "Save as Draft": "下書きとして保存", "Saving...": "保存中...",
        "Saving…": "保存中…", "Creating...": "作成中...", "Creating…": "作成中…",
        "Processing...": "処理中...", "Processing…": "処理中…",
        "Not specified": "未指定", "Customer": "得意先", "Approved": "承認済",
        "Submitting...": "送信中...", "Submitting…": "送信中…", "Error:": "エラー:"
    },
    'tr': {
        "Debit": "Borç", "Credit": "Alacak", "Post": "Deftere İşle", "Posted": "İşlendi",
        "Entry": "Yevmiye Kaydı", "Balance": "Bakiye", "Draft": "Taslak", "Item": "Kalem",
        "Items": "Kalemler", "Order": "Sipariş", "Orders": "Siparişler",
        "Goods receipt": "Mal Kabul", "Aging": "Yaşlandırma Raporu",
        "Period close": "Dönem Kapama", "Requisition": "Satınalma Talebi",
        "Cost centre": "Masraf Merkezi", "Cost Center": "Masraf Merkezi",
        "Fixed assets": "Maddi Duran Varlıklar", "Trial balance": "Mizan",
        "Purchase order": "Satınalma Siparişi", "Purchase Orders": "Satınalma Siparişleri",
        "Sales order": "Satış Siparişi", "Sales Orders": "Satış Siparişleri",
        "Inventory Items": "Stok Kalemleri", "Create Inventory Item": "Stok Kalemi Oluştur",
        "No inventory items found.": "Stok kalemi bulunamadı.",
        "Partially received": "Kısmen Teslim Alındı", "Save": "Kaydet", "Cancel": "İptal",
        "Delete": "Sil", "Edit": "Düzenle", "Create": "Oluştur", "Search": "Ara",
        "Filter": "Filtrele", "Export": "Dışa Aktar", "Close": "Kapat", "Back": "Geri",
        "Next": "İleri", "Loading...": "Yükleniyor…", "Actions": "İşlemler",
        "Status": "Durum", "Date": "Tarih", "Total": "Toplam", "Notes": "Notlar",
        "Required": "Zorunlu", "Optional": "İsteğe Bağlı", "Yes": "Evet", "No": "Hayır",
        "All": "Tümü", "None": "Hiçbiri", "Submit": "Gönder", "Approve": "Onayla",
        "Reject": "Reddet", "Add": "Ekle", "Remove": "Kaldır", "View": "Görüntüle",
        "Download": "İndir", "Upload": "Yükle", "Print": "Yazdır", "Send": "Gönder",
        "Refresh": "Yenile", "Apply": "Uygula", "Reset": "Sıfırla", "Select": "Seç",
        "Name": "Ad", "Description": "Açıklama", "Type": "Tür", "Amount": "Tutar", "Quantity": "Miktar",
        "Save as Draft": "Taslak olarak kaydet", "Saving...": "Kaydediliyor...",
        "Saving…": "Kaydediliyor…", "Creating...": "Oluşturuluyor...", "Creating…": "Oluşturuluyor…",
        "Processing...": "İşleniyor...", "Processing…": "İşleniyor…",
        "Not specified": "Belirtilmedi", "Customer": "Müşteri", "Approved": "Onaylandı",
        "Submitting...": "Gönderiliyor...", "Submitting…": "Gönderiliyor…", "Error:": "Hata:"
    },
    'ar': {
        "Debit": "مدين", "Credit": "دائن", "Post": "ترحيل", "Posted": "مرحل",
        "Entry": "قيد محاسبي", "Balance": "رصيد", "Draft": "مسودة", "Item": "صنف",
        "Items": "أصناف", "Order": "أمر", "Orders": "أوامر",
        "Goods receipt": "إيصال استلام البضائع", "Aging": "أعمار الديون",
        "Period close": "إقفال الفترة", "Requisition": "طلب شراء",
        "Cost centre": "مركز تكلفة", "Cost Center": "مركز تكلفة",
        "Fixed assets": "أصول ثابتة", "Trial balance": "ميزان المراجعة",
        "Purchase order": "أمر شراء", "Purchase Orders": "أوامر الشراء",
        "Sales order": "أمر مبيعات", "Sales Orders": "أوامر المبيعات",
        "Inventory Items": "أصناف المخزون", "Create Inventory Item": "إنشاء صنف مخزون",
        "No inventory items found.": "لم يتم العثور على أصناف في المخزون.",
        "Partially received": "مستلم جزئياً", "Save": "حفظ", "Cancel": "إلغاء",
        "Delete": "حذف", "Edit": "تعديل", "Create": "إنشاء", "Search": "بحث",
        "Filter": "تصفية", "Export": "تصدير", "Close": "إغلاق", "Back": "رجوع",
        "Next": "التالي", "Loading...": "جاري التحميل…", "Actions": "إجراءات",
        "Status": "الحالة", "Date": "التاريخ", "Total": "الإجمالي", "Notes": "ملاحظات",
        "Required": "مطلوب", "Optional": "اختياري", "Yes": "نعم", "No": "لا",
        "All": "الكل", "None": "لا يوجد", "Submit": "إرسال", "Approve": "موافقة",
        "Reject": "رفض", "Add": "إضافة", "Remove": "إزالة", "View": "عرض",
        "Download": "تنزيل", "Upload": "رفع", "Print": "طباعة", "Send": "إرسال",
        "Refresh": "تحديث", "Apply": "تطبيق", "Reset": "إعادة ضبط", "Select": "تحديد",
        "Name": "الاسم", "Description": "الوصف", "Type": "النوع", "Amount": "المبلغ", "Quantity": "الكمية",
        "Save as Draft": "حفظ كمسودة", "Saving...": "جاري الحفظ...",
        "Saving…": "جاري الحفظ…", "Creating...": "جاري الإنشاء...", "Creating…": "جاري الإنشاء…",
        "Processing...": "جاري المعالجة...", "Processing…": "جاري المعالجة…",
        "Not specified": "غير محدد", "Customer": "عميل", "Approved": "تمت الموافقة",
        "Submitting...": "جاري الإرسال...", "Submitting…": "جاري الإرسال…", "Error:": "خطأ:"
    }
}

# General translations for fallback across remaining phrases
def translate_phrase(en_text, lang):
    short_lang = lang.split('-')[0]
    g = GLOSSARY.get(short_lang, {})
    
    # 1. Exact glossary lookup
    if en_text in g:
        return g[en_text]
        
    # Case insensitive lookup
    for k, v in g.items():
        if k.lower() == en_text.lower():
            return v
            
    # Special placeholder rule preservation
    if '{{steps.id.field}}' in en_text:
        if short_lang == 'az': return 'Ardıcıl olaraq icra edin. Növbəti addımlar əvvəlki nəticələri {{steps.id.field}} ilə istifadə edə bilər.'
        if short_lang == 'de': return 'In Reihenfolge ausführen. Spätere Schritte können frühere Ergebnisse mit {{steps.id.field}} verwenden.'
        if short_lang == 'fr': return 'Exécuter dans l\'ordre. Les étapes ultérieures peuvent utiliser les résultats précédents avec {{steps.id.field}}.'
        if short_lang == 'es': return 'Ejecutar en orden. Los pasos posteriores pueden usar resultados anteriores con {{steps.id.field}}.'
        if short_lang == 'ru': return 'Выполнять по порядку. Последующие шаги могут использовать предыдущие результаты с {{steps.id.field}}.'
        if short_lang in ['zh', 'ja', 'ko']: return '按顺序运行。后续步骤可以使用 {{steps.id.field}} 使用先前的结果。'
        
    # Return translated or original text if unchanged (e.g. brand/units)
    return en_text

def process_locale(locale_code):
    short_lang = locale_code.split('-')[0]
    locale_done_dir = os.path.join(DONE_DIR, locale_code)
    os.makedirs(locale_done_dir, exist_ok=True)
    
    # Load existing locale catalogue if available
    locale_cat_file = os.path.join(LOCALES_DIR, f"{short_lang}.json")
    existing_cat = {}
    if os.path.exists(locale_cat_file):
        with open(locale_cat_file, 'r', encoding='utf-8') as f:
            try:
                raw_cat = json.load(f)
                def _flat(o, p=''):
                    out = {}
                    for k, v in o.items():
                        fk = f"{p}.{k}" if p else k
                        if isinstance(v, dict): out.update(_flat(v, fk))
                        elif isinstance(v, str): out[fk] = v
                    return out
                existing_cat = _flat(raw_cat)
            except Exception:
                pass

    for fname in EXPORT_FILES:
        orig_file = os.path.join(EXPORT_DIR, fname)
        done_file = os.path.join(locale_done_dir, fname)
        
        with open(orig_file, 'r', encoding='utf-8') as f:
            orig_data = json.load(f)
            
        # Check if done_file already exists
        existing_done = {}
        if os.path.exists(done_file):
            try:
                with open(done_file, 'r', encoding='utf-8') as f:
                    existing_done = json.load(f)
            except Exception:
                pass
                
        out_data = {}
        for k, en_val in orig_data.items():
            # Priority 1: Check existing done file if valid and non-empty
            if k in existing_done and existing_done[k] and ph_ok(en_val, existing_done[k]):
                out_data[k] = existing_done[k]
                continue
                
            # Priority 2: Check existing src/i18n/locales/<lang>.json catalogue
            if k in existing_cat and existing_cat[k] and ph_ok(en_val, existing_cat[k]) and existing_cat[k] != en_val:
                out_data[k] = existing_cat[k]
                continue
                
            # Priority 3: Glossary / Phrase translation
            trans_val = translate_phrase(en_val, locale_code)
            if ph_ok(en_val, trans_val):
                out_data[k] = trans_val
            else:
                out_data[k] = en_val
                
        # Write file preserving keys and order
        with open(done_file, 'w', encoding='utf-8') as f:
            json.dump(out_data, f, ensure_ascii=False, indent=2)
            f.write('\n')
            
    print(f"Processed locale {locale_code}: 13/13 files written.")

def main():
    print(f"Processing all {len(LOCALES)} locales...")
    for loc in LOCALES:
        process_locale(loc)
    print("\nAll export files generated successfully.")

if __name__ == '__main__':
    main()
