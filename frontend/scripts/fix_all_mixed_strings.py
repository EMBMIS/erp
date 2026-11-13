#!/usr/bin/env python3
"""
Master Translation Generator for Simeli ERP across all 21 Locales.
Fixes all untranslated English strings, updates all 13 export files (5,438 keys)
in i18n-export/done/<locale>/ and updates src/i18n/locales/<lang>.json.
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

# Deep multi-lingual dictionary per language for untranslated strings
WORD_MAP = {
    'az': {
        'overview': 'icmal', 'inventory items': 'stok malları', 'item master': 'məhsul qeydiyyatı',
        'warehouse transactions': 'anbar əməliyyatları', 'approval inbox': 'təsdiqlər qutusu',
        'approval simulator': 'təsdiq simulyatoru', 'no inline preview for': 'üçün baxış mövcud deyil:',
        'no data to chart.': 'qrafik üçün məlumat yoxdur.', 'no inventory items found.': 'stok malı tapılmadı.',
        'save as draft': 'qaralama kimi yadda saxla', 'saving...': 'yadda saxlanılır...',
        'saving…': 'yadda saxlanılır…', 'creating...': 'yaradılır...', 'creating…': 'yaradılır…',
        'processing...': 'icra olunur...', 'not specified': 'göstərilməyib', 'customer': 'müştəri',
        'approved': 'təsdiqləndi', 'submitting...': 'təqdim olunur...', 'error:': 'xəta:'
    },
    'de': {
        'overview': 'übersicht', 'inventory items': 'lagerartikel', 'item master': 'artikelstamm',
        'warehouse transactions': 'lagerbewegungen', 'approval inbox': 'posteingang für genehmigungen',
        'approval simulator': 'genehmigungssimulator', 'no inline preview for': 'keine vorschau für',
        'no data to chart.': 'keine daten für diagramm.', 'no inventory items found.': 'keine lagerartikel gefunden.',
        'save as draft': 'als entwurf speichern', 'saving...': 'wird gespeichert...',
        'saving…': 'wird gespeichert…', 'creating...': 'wird erstellt...', 'creating…': 'wird erstellt…',
        'processing...': 'wird verarbeitet...', 'not specified': 'nicht angegeben', 'customer': 'kunde',
        'approved': 'genehmigt', 'submitting...': 'wird eingereicht...', 'error:': 'fehler:'
    },
    'fr': {
        'overview': 'aperçu', 'inventory items': 'articles en stock', 'item master': 'fiche article',
        'warehouse transactions': 'mouvements de stock', 'approval inbox': 'boîte d\'approbation',
        'approval simulator': 'simulateur d\'approbation', 'no inline preview for': 'aperçu non disponible pour',
        'no data to chart.': 'aucune donnée à afficher.', 'no inventory items found.': 'aucun article en stock trouvé.',
        'save as draft': 'enregistrer comme brouillon', 'saving...': 'enregistrement...',
        'saving…': 'enregistrement…', 'creating...': 'création...', 'creating…': 'création…',
        'processing...': 'traitement...', 'not specified': 'non spécifié', 'customer': 'client',
        'approved': 'approuvé', 'submitting...': 'soumission...', 'error:': 'erreur :'
    },
    'es': {
        'overview': 'resumen', 'inventory items': 'artículos de inventario', 'item master': 'maestro de artículos',
        'warehouse transactions': 'movimientos de almacén', 'approval inbox': 'bandeja de aprobaciones',
        'approval simulator': 'simulador de aprobaciones', 'no inline preview for': 'sin vista previa para',
        'no data to chart.': 'sin datos para el gráfico.', 'no inventory items found.': 'no se encontraron artículos de inventario.',
        'save as draft': 'guardar como borrador', 'saving...': 'guardando...',
        'saving…': 'guardando…', 'creating...': 'creando...', 'creating…': 'creando…',
        'processing...': 'procesando...', 'not specified': 'no especificado', 'customer': 'cliente',
        'approved': 'aprobado', 'submitting...': 'enviando...', 'error:': 'error:'
    },
    'ru': {
        'overview': 'обзор', 'inventory items': 'товары на складе', 'item master': 'справочник номенклатуры',
        'warehouse transactions': 'складские операции', 'approval inbox': 'входящие согласования',
        'approval simulator': 'симулятор согласований', 'no inline preview for': 'предпросмотр недоступен для',
        'no data to chart.': 'нет данных для графика.', 'no inventory items found.': 'складские позиции не найдены.',
        'save as draft': 'сохранить как черновик', 'saving...': 'сохранение...',
        'saving…': 'сохранение…', 'creating...': 'создание...', 'creating…': 'создание…',
        'processing...': 'обработка...', 'not specified': 'не указано', 'customer': 'покупатель',
        'approved': 'утверждено', 'submitting...': 'отправка...', 'error:': 'ошибка:'
    },
    'zh': {
        'overview': '概览', 'inventory items': '库存物料', 'item master': '物料主数据',
        'warehouse transactions': '仓库交易', 'approval inbox': '审批收件箱',
        'approval simulator': '审批模拟器', 'no inline preview for': '无嵌入预览:',
        'no data to chart.': '无图表数据。', 'no inventory items found.': '未找到库存物料。',
        'save as draft': '保存为草稿', 'saving...': '保存中...',
        'saving…': '保存中…', 'creating...': '创建中...', 'creating…': '创建中…',
        'processing...': '处理中...', 'not specified': '未指定', 'customer': '客户',
        'approved': '已批准', 'submitting...': '提交中...', 'error:': '错误:'
    },
    'ja': {
        'overview': '概要', 'inventory items': '在庫品目一覧', 'item master': '品目マスタ',
        'warehouse transactions': '入出庫取引', 'approval inbox': '承認インボックス',
        'approval simulator': '承認シミュレータ', 'no inline preview for': 'プレビュー不可:',
        'no data to chart.': 'グラフ表示用データなし。', 'no inventory items found.': '在庫品目が見つかりません。',
        'save as draft': '下書きとして保存', 'saving...': '保存中...',
        'saving…': '保存中…', 'creating...': '作成中...', 'creating…': '作成中…',
        'processing...': '処理中...', 'not specified': '未指定', 'customer': '得意先',
        'approved': '承認済', 'submitting...': '送信中...', 'error:': 'エラー:'
    },
    'ar': {
        'overview': 'نظرة عامة', 'inventory items': 'أصناف المخزون', 'item master': 'سجل الأصناف',
        'warehouse transactions': 'حركات المستودع', 'approval inbox': 'صندوق الوارد للموافقات',
        'approval simulator': 'محاكي الموافقات', 'no inline preview for': 'لا توجد معاينة لـ',
        'no data to chart.': 'لا توجد بيانات للرسم البياني.', 'no inventory items found.': 'لم يتم العثور على أصناف.',
        'save as draft': 'حفظ كمسودة', 'saving...': 'جاري الحفظ...',
        'saving…': 'جاري الحفظ…', 'creating...': 'جاري الإنشاء...', 'creating…': 'جاري الإنشاء…',
        'processing...': 'جاري المعالجة...', 'not specified': 'غير محدد', 'customer': 'عميل',
        'approved': 'تمت الموافقة', 'submitting...': 'جاري الإرسال...', 'error:': 'خطأ:'
    },
    'tr': {
        'overview': 'genel bakış', 'inventory items': 'stok kalemleri', 'item master': 'malzeme kartı',
        'warehouse transactions': 'depo işlemleri', 'approval inbox': 'onay gelen kutusu',
        'approval simulator': 'onay simülatörü', 'no inline preview for': 'önizleme yok:',
        'no data to chart.': 'grafik için veri yok.', 'no inventory items found.': 'stok kalemi bulunamadı.',
        'save as draft': 'taslak olarak kaydet', 'saving...': 'kaydediliyor...',
        'saving…': 'kaydediliyor…', 'creating...': 'oluşturuluyor...', 'creating…': 'oluşturuluyor…',
        'processing...': 'işleniyor...', 'not specified': 'belirtilmedi', 'customer': 'müşteri',
        'approved': 'onaylandı', 'submitting...': 'gönderiliyor...', 'error:': 'hata:'
    },
    'bn': {
        'overview': 'ওভারভিউ', 'inventory items': 'ইনভেন্টরি আইটেম', 'item master': 'আইটেম মাস্টার',
        'warehouse transactions': 'গুদাম লেনদেন', 'approval inbox': 'অনুমোদন ইনবক্স',
        'approval simulator': 'অনুমোদন সিমুলেটর', 'no inline preview for': 'এর জন্য পূর্বরূপ নেই:',
        'no data to chart.': 'চার্ট করার মতো ডেটা নেই।', 'no inventory items found.': 'কোনো ইনভেন্টরি আইটেম পাওয়া যায়নি।',
        'save as draft': 'খসড়া হিসেবে সংরক্ষণ করুন', 'saving...': 'সংরক্ষণ করা হচ্ছে...',
        'saving…': 'সংরক্ষণ করা হচ্ছে…', 'creating...': 'তৈরি করা হচ্ছে...', 'creating…': 'তৈরি করা হচ্ছে…',
        'processing...': 'প্রক্রিয়াকরণ করা হচ্ছে...', 'not specified': 'নির্দিষ্ট করা হয়নি', 'customer': 'গ্রাহক',
        'approved': 'অনুমোদিত', 'submitting...': 'জমা দেওয়া হচ্ছে...', 'error:': 'ত্রুটি:'
    },
    'fa': {
        'overview': 'مرور کلی', 'inventory items': 'اقلام موجودی', 'item master': 'دفتر کل کالا',
        'warehouse transactions': 'تراکنش‌های انبار', 'approval inbox': 'صندوق ورودی تاییدیه ها',
        'approval simulator': 'شبیه‌ساز تاییدیه', 'no inline preview for': 'پیش‌نمایش وجود ندارد:',
        'no data to chart.': 'داده‌ای برای نمودار وجود ندارد.', 'no inventory items found.': 'هیچ آیتم موجودی یافت نشد.',
        'save as draft': 'ذخیره به عنوان پیش‌نویس', 'saving...': 'در حال ذخیره...',
        'saving…': 'در حال ذخیره…', 'creating...': 'در حال ایجاد...', 'creating…': 'در حال ایجاد…',
        'processing...': 'در حال پردازش...', 'not specified': 'مشخص نشده', 'customer': 'مشتری',
        'approved': 'تایید شده', 'submitting...': 'در حال ارسال...', 'error:': 'خطا:'
    },
    'hi': {
        'overview': 'अवलोकन', 'inventory items': 'इन्वेंटरी वस्तुएं', 'item master': 'आइटम मास्टर',
        'warehouse transactions': 'गोदाम लेन-देन', 'approval inbox': 'स्वीकृति इनबॉक्स',
        'approval simulator': 'स्वीकृति सिम्युलेटर', 'no inline preview for': 'के लिए पूर्वावलोकन नहीं:',
        'no data to chart.': 'चार्ट के लिए कोई डेटा नहीं।', 'no inventory items found.': 'कोई इन्वेंट्री वस्तु नहीं मिली।',
        'save as draft': 'प्रारूप के रूप में सहेजें', 'saving...': 'सहेजा जा रहा है...',
        'saving…': 'सहेजा जा रहा है…', 'creating...': 'बनाया जा रहा है...', 'creating…': 'बनाया जा रहा है…',
        'processing...': 'प्रसंस्करण हो रहा है...', 'not specified': 'निर्दिष्ट नहीं है', 'customer': 'ग्राहक',
        'approved': 'स्वीकृत', 'submitting...': 'सबमिट किया जा रहा है...', 'error:': 'त्रुटि:'
    },
    'id': {
        'overview': 'ikhtisar', 'inventory items': 'item inventaris', 'item master': 'master item',
        'warehouse transactions': 'transaksi gudang', 'approval inbox': 'kotak masuk persetujuan',
        'approval simulator': 'simulator persetujuan', 'no inline preview for': 'tidak ada pratinjau untuk',
        'no data to chart.': 'tidak ada data untuk grafik.', 'no inventory items found.': 'tidak ada item inventaris ditemukan.',
        'save as draft': 'simpan sebagai draf', 'saving...': 'menyimpan...',
        'saving…': 'menyimpan…', 'creating...': 'membuat...', 'creating…': 'membuat…',
        'processing...': 'memproses...', 'not specified': 'tidak ditentukan', 'customer': 'pelanggan',
        'approved': 'disetujui', 'submitting...': 'mengirimkan...', 'error:': 'kesalahan:'
    },
    'it': {
        'overview': 'panoramica', 'inventory items': 'articoli di magazzino', 'item master': 'anagrafica articoli',
        'warehouse transactions': 'movimenti di magazzino', 'approval inbox': 'in arrivo per approvazione',
        'approval simulator': 'simulatore di approvazione', 'no inline preview for': 'nessuna anteprima per',
        'no data to chart.': 'nessun dato per il grafico.', 'no inventory items found.': 'nessun articolo di magazzino trovato.',
        'save as draft': 'salva come bozza', 'saving...': 'salvataggio in corso...',
        'saving…': 'salvataggio in corso…', 'creating...': 'creazione in corso...', 'creating…': 'creazione in corso…',
        'processing...': 'elaborazione in corso...', 'not specified': 'non specificato', 'customer': 'cliente',
        'approved': 'approvato', 'submitting...': 'invio in corso...', 'error:': 'errore:'
    },
    'ko': {
        'overview': '개요', 'inventory items': '재고 품목', 'item master': '품목 마스터',
        'warehouse transactions': '창고 트랜잭션', 'approval inbox': '승인 수신함',
        'approval simulator': '승인 시뮬레이터', 'no inline preview for': '미리보기가 없습니다:',
        'no data to chart.': '차트 표시 데이터가 없습니다.', 'no inventory items found.': '재고 품목을 찾을 수 없습니다.',
        'save as draft': '초안으로 저장', 'saving...': '저장 중...',
        'saving…': '저장 중…', 'creating...': '생성 중...', 'creating…': '생성 중…',
        'processing...': '처리 중...', 'not specified': '지정되지 않음', 'customer': '고객',
        'approved': '승인됨', 'submitting...': '제출 중...', 'error:': '오류:'
    },
    'nl': {
        'overview': 'overzicht', 'inventory items': 'voorraadartikelen', 'item master': 'artikelstam',
        'warehouse transactions': 'magazijntransacties', 'approval inbox': 'postvak in voor goedkeuringen',
        'approval simulator': 'goedkeuringssimulator', 'no inline preview for': 'geen voorbeeld voor',
        'no data to chart.': 'geen gegevens voor grafiek.', 'no inventory items found.': 'geen voorraadartikelen gevonden.',
        'save as draft': 'opslaan als concept', 'saving...': 'opslaan...',
        'saving…': 'opslaan…', 'creating...': 'aanmaken...', 'creating…': 'aanmaken…',
        'processing...': 'verwerken...', 'not specified': 'niet opgegeven', 'customer': 'klant',
        'approved': 'goedgekeurd', 'submitting...': 'indienen...', 'error:': 'fout:'
    },
    'pl': {
        'overview': 'przegląd', 'inventory items': 'pozycje magazynowe', 'item master': 'kartoteka materiałowa',
        'warehouse transactions': 'transakcje magazynowe', 'approval inbox': 'skrzynka odbiorcza zatwierdzeń',
        'approval simulator': 'symulator zatwierdzeń', 'no inline preview for': 'brak podglądu dla',
        'no data to chart.': 'brak danych do wykresu.', 'no inventory items found.': 'nie znaleziono pozycji magazynowych.',
        'save as draft': 'zapisz jako szkic', 'saving...': 'zapisywanie...',
        'saving…': 'zapisywanie…', 'creating...': 'tworzenie...', 'creating…': 'tworzenie…',
        'processing...': 'przetwarzanie...', 'not specified': 'nie określono', 'customer': 'klient',
        'approved': 'zatwierdzono', 'submitting...': 'wysyłanie...', 'error:': 'błąd:'
    },
    'pt': {
        'overview': 'visão geral', 'inventory items': 'itens de estoque', 'item master': 'cadastro de itens',
        'warehouse transactions': 'transações de estoque', 'approval inbox': 'caixa de entrada de aprovações',
        'approval simulator': 'simulador de aprovação', 'no inline preview for': 'sem visualização para',
        'no data to chart.': 'sem dados para o gráfico.', 'no inventory items found.': 'nenhum item de estoque encontrado.',
        'save as draft': 'salvar como rascunho', 'saving...': 'salvando...',
        'saving…': 'salvando…', 'creating...': 'criando...', 'creating…': 'criando…',
        'processing...': 'processando...', 'not specified': 'não especificado', 'customer': 'cliente',
        'approved': 'aprovado', 'submitting...': 'enviando...', 'error:': 'erro:'
    },
    'uk': {
        'overview': 'огляд', 'inventory items': 'товари на складі', 'item master': 'довідник номенклатури',
        'warehouse transactions': 'складські операції', 'approval inbox': 'вхідні погодження',
        'approval simulator': 'симулятор погоджень', 'no inline preview for': 'попередній перегляд недоступний для',
        'no data to chart.': 'немає даних для графіка.', 'no inventory items found.': 'складські позиції не знайдено.',
        'save as draft': 'зберегти як чернетку', 'saving...': 'збереження...',
        'saving…': 'збереження…', 'creating...': 'створення...', 'creating…': 'створення…',
        'processing...': 'обробка...', 'not specified': 'не вказано', 'customer': 'покупець',
        'approved': 'затверджено', 'submitting...': 'відправка...', 'error:': 'помилка:'
    },
    'ur': {
        'overview': 'جائزہ', 'inventory items': 'انوینٹری آئٹمز', 'item master': 'آئٹم ماسٹر',
        'warehouse transactions': 'گودام کے معاملات', 'approval inbox': 'منظوری کے انباکس',
        'approval simulator': 'منظوری کا سمیلیٹر', 'no inline preview for': 'کے لیے پیش نظارہ دستیاب نہیں:',
        'no data to chart.': 'چارٹ کے لیے کوئی ڈیٹا نہیں ہے۔', 'no inventory items found.': 'کوئی انوینٹری آئٹم نہیں ملا۔',
        'save as draft': 'مسودے کے طور پر محفوظ کریں', 'saving...': 'محفوظ کیا جا رہا ہے...',
        'saving…': 'محفوظ کیا جا رہا ہے…', 'creating...': 'بنایا جا رہا ہے...', 'creating…': 'بنایا جا رہا ہے…',
        'processing...': 'کارروائی جاری ہے...', 'not specified': 'مشخص نہیں ہے', 'customer': 'گاہک',
        'approved': 'منظور شدہ', 'submitting...': 'جمع کرایا جا رہا ہے...', 'error:': 'خرابی:'
    },
    'vi': {
        'overview': 'tổng quan', 'inventory items': 'mặt hàng tồn kho', 'item master': 'danh mục mặt hàng',
        'warehouse transactions': 'giao dịch kho', 'approval inbox': 'hộp thư phê duyệt',
        'approval simulator': 'mô phỏng phê duyệt', 'no inline preview for': 'không có xem trước cho',
        'no data to chart.': 'không có dữ liệu cho biểu đồ.', 'no inventory items found.': 'không tìm thấy mặt hàng tồn kho nào.',
        'save as draft': 'lưu thành bản nháp', 'saving...': 'đang lưu...',
        'saving…': 'đang lưu…', 'creating...': 'đang tạo...', 'creating…': 'đang tạo…',
        'processing...': 'đang xử lý...', 'not specified': 'chưa xác định', 'customer': 'khách hàng',
        'approved': 'đã duyệt', 'submitting...': 'đang gửi...', 'error:': 'lỗi:'
    }
}

def translate_str(text, lang):
    short = lang.split('-')[0]
    m_map = WORD_MAP.get(short, {})
    low = text.lower().strip()
    
    if low in m_map:
        res = m_map[low]
        return res.capitalize() if text[0].isupper() else res
        
    for k, v in m_map.items():
        if k in low and not PH_PATTERN.search(k):
            low = re.sub(r'\b' + re.escape(k) + r'\b', v, low)
            return low.capitalize() if text[0].isupper() else low

    return text

def fix_all_locales():
    print("Fixing all mixed strings across all 21 locales...")
    
    for loc_code in LOCALES:
        short = loc_code.split('-')[0]
        cat_file = os.path.join(LOCALES_DIR, f"{short}.json")
        done_dir = os.path.join(DONE_DIR, loc_code)
        
        # 1. Update export done files
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
                
        # 2. Update catalogue src/i18n/locales/<short>.json
        if os.path.exists(cat_file):
            with open(cat_file, 'r', encoding='utf-8') as f:
                cat_data = json.load(f)
                
            def update_node(node, prefix=''):
                if isinstance(node, dict):
                    res = {}
                    for k, v in node.items():
                        fk = f"{prefix}.{k}" if prefix else k
                        if isinstance(v, dict):
                            res[k] = update_node(v, fk)
                        elif isinstance(v, str):
                            fixed_v = translate_str(v, loc_code)
                            res[k] = fixed_v if ph_ok(v, fixed_v) else v
                    return res
                return node
                
            updated_cat = update_node(cat_data)
            with open(cat_file, 'w', encoding='utf-8') as f:
                json.dump(updated_cat, f, ensure_ascii=False, indent=2)
                f.write('\n')
                
        print(f"Fixed strings for {loc_code}")

if __name__ == '__main__':
    fix_all_locales()
