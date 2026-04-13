#!/usr/bin/env python3
"""Batch-update all 26 locale files with file-category i18n keys."""
import os
import re

LOCALES_DIR = "src/shared/locales"

# 9 keys × 26 locales
TRANSLATIONS = {
    "ar": {
        "file-category-enabled": "تصنيف الملفات الذكي",
        "file-category-hint": "الملفات التي لا تتطابق مع أي فئة تُحفظ في مجلد التنزيل الرئيسي",
        "file-category-addtask-hint": "سيتم تصنيف الملفات تلقائيًا في مجلدات فرعية حسب النوع",
        "file-category-videos": "فيديو",
        "file-category-music": "موسيقى",
        "file-category-images": "صور",
        "file-category-documents": "مستندات",
        "file-category-archives": "أرشيفات",
        "file-category-programs": "برامج",
    },
    "bg": {
        "file-category-enabled": "Интелигентна класификация на файлове",
        "file-category-hint": "Файловете, които не съответстват на нито една категория, се запазват в основната папка за изтегляне",
        "file-category-addtask-hint": "Файловете ще бъдат автоматично класифицирани в подпапки по тип",
        "file-category-videos": "Видео",
        "file-category-music": "Музика",
        "file-category-images": "Изображения",
        "file-category-documents": "Документи",
        "file-category-archives": "Архиви",
        "file-category-programs": "Програми",
    },
    "ca": {
        "file-category-enabled": "Classificació intel·ligent de fitxers",
        "file-category-hint": "Els fitxers que no coincideixin amb cap categoria es desaran al directori de descàrrega principal",
        "file-category-addtask-hint": "Els fitxers es classificaran automàticament en subdirectoris per tipus",
        "file-category-videos": "Vídeos",
        "file-category-music": "Música",
        "file-category-images": "Imatges",
        "file-category-documents": "Documents",
        "file-category-archives": "Arxius",
        "file-category-programs": "Programes",
    },
    "de": {
        "file-category-enabled": "Intelligente Dateiklassifizierung",
        "file-category-hint": "Dateien, die keiner Kategorie entsprechen, werden im Hauptdownloadverzeichnis gespeichert",
        "file-category-addtask-hint": "Dateien werden automatisch nach Typ in Unterordner einsortiert",
        "file-category-videos": "Videos",
        "file-category-music": "Musik",
        "file-category-images": "Bilder",
        "file-category-documents": "Dokumente",
        "file-category-archives": "Archive",
        "file-category-programs": "Programme",
    },
    "el": {
        "file-category-enabled": "Έξυπνη ταξινόμηση αρχείων",
        "file-category-hint": "Τα αρχεία που δεν ταιριάζουν σε καμία κατηγορία αποθηκεύονται στον κύριο φάκελο λήψης",
        "file-category-addtask-hint": "Τα αρχεία θα ταξινομηθούν αυτόματα σε υποφακέλους ανά τύπο",
        "file-category-videos": "Βίντεο",
        "file-category-music": "Μουσική",
        "file-category-images": "Εικόνες",
        "file-category-documents": "Έγγραφα",
        "file-category-archives": "Αρχεία",
        "file-category-programs": "Προγράμματα",
    },
    "en-US": {
        "file-category-enabled": "Smart File Classification",
        "file-category-hint": "Files not matching any category are saved to the main download directory",
        "file-category-addtask-hint": "Files will be auto-classified into subdirectories by type",
        "file-category-videos": "Videos",
        "file-category-music": "Music",
        "file-category-images": "Images",
        "file-category-documents": "Documents",
        "file-category-archives": "Archives",
        "file-category-programs": "Programs",
    },
    "es": {
        "file-category-enabled": "Clasificación inteligente de archivos",
        "file-category-hint": "Los archivos que no coincidan con ninguna categoría se guardarán en el directorio de descarga principal",
        "file-category-addtask-hint": "Los archivos se clasificarán automáticamente en subdirectorios por tipo",
        "file-category-videos": "Vídeos",
        "file-category-music": "Música",
        "file-category-images": "Imágenes",
        "file-category-documents": "Documentos",
        "file-category-archives": "Archivos",
        "file-category-programs": "Programas",
    },
    "fa": {
        "file-category-enabled": "طبقه\u200cبندی هوشمند فایل",
        "file-category-hint": "فایل\u200cهایی که با هیچ دسته\u200cای مطابقت ندارند در پوشه دانلود اصلی ذخیره می\u200cشوند",
        "file-category-addtask-hint": "فایل\u200cها به\u200cطور خودکار بر اساس نوع در زیرپوشه\u200cها طبقه\u200cبندی می\u200cشوند",
        "file-category-videos": "ویدیوها",
        "file-category-music": "موسیقی",
        "file-category-images": "تصاویر",
        "file-category-documents": "اسناد",
        "file-category-archives": "آرشیوها",
        "file-category-programs": "برنامه\u200cها",
    },
    "fr": {
        "file-category-enabled": "Classification intelligente des fichiers",
        "file-category-hint": "Les fichiers ne correspondant à aucune catégorie sont enregistrés dans le répertoire de téléchargement principal",
        "file-category-addtask-hint": "Les fichiers seront automatiquement classés dans des sous-répertoires par type",
        "file-category-videos": "Vidéos",
        "file-category-music": "Musique",
        "file-category-images": "Images",
        "file-category-documents": "Documents",
        "file-category-archives": "Archives",
        "file-category-programs": "Programmes",
    },
    "hu": {
        "file-category-enabled": "Intelligens fájl osztályozás",
        "file-category-hint": "A kategóriába nem illő fájlok a fő letöltési mappába kerülnek",
        "file-category-addtask-hint": "A fájlok automatikusan almappákba lesznek rendezve típus szerint",
        "file-category-videos": "Videók",
        "file-category-music": "Zene",
        "file-category-images": "Képek",
        "file-category-documents": "Dokumentumok",
        "file-category-archives": "Archívumok",
        "file-category-programs": "Programok",
    },
    "id": {
        "file-category-enabled": "Klasifikasi File Cerdas",
        "file-category-hint": "File yang tidak cocok dengan kategori apa pun disimpan di direktori unduhan utama",
        "file-category-addtask-hint": "File akan diklasifikasikan secara otomatis ke subdirektori berdasarkan jenis",
        "file-category-videos": "Video",
        "file-category-music": "Musik",
        "file-category-images": "Gambar",
        "file-category-documents": "Dokumen",
        "file-category-archives": "Arsip",
        "file-category-programs": "Program",
    },
    "it": {
        "file-category-enabled": "Classificazione intelligente dei file",
        "file-category-hint": "I file che non corrispondono a nessuna categoria vengono salvati nella directory di download principale",
        "file-category-addtask-hint": "I file verranno classificati automaticamente in sottocartelle per tipo",
        "file-category-videos": "Video",
        "file-category-music": "Musica",
        "file-category-images": "Immagini",
        "file-category-documents": "Documenti",
        "file-category-archives": "Archivi",
        "file-category-programs": "Programmi",
    },
    "ja": {
        "file-category-enabled": "スマートファイル分類",
        "file-category-hint": "どのカテゴリにも一致しないファイルはメインのダウンロードディレクトリに保存されます",
        "file-category-addtask-hint": "ファイルはタイプ別にサブディレクトリに自動分類されます",
        "file-category-videos": "動画",
        "file-category-music": "音楽",
        "file-category-images": "画像",
        "file-category-documents": "ドキュメント",
        "file-category-archives": "アーカイブ",
        "file-category-programs": "プログラム",
    },
    "ko": {
        "file-category-enabled": "스마트 파일 분류",
        "file-category-hint": "어떤 카테고리에도 일치하지 않는 파일은 기본 다운로드 디렉토리에 저장됩니다",
        "file-category-addtask-hint": "파일이 유형별로 하위 디렉토리에 자동 분류됩니다",
        "file-category-videos": "동영상",
        "file-category-music": "음악",
        "file-category-images": "이미지",
        "file-category-documents": "문서",
        "file-category-archives": "압축파일",
        "file-category-programs": "프로그램",
    },
    "nb": {
        "file-category-enabled": "Smart filklassifisering",
        "file-category-hint": "Filer som ikke matcher noen kategori lagres i hovedkatalogen for nedlasting",
        "file-category-addtask-hint": "Filer vil automatisk bli klassifisert i underkataloger etter type",
        "file-category-videos": "Videoer",
        "file-category-music": "Musikk",
        "file-category-images": "Bilder",
        "file-category-documents": "Dokumenter",
        "file-category-archives": "Arkiver",
        "file-category-programs": "Programmer",
    },
    "nl": {
        "file-category-enabled": "Slimme bestandsclassificatie",
        "file-category-hint": "Bestanden die niet bij een categorie passen, worden opgeslagen in de hoofddownloadmap",
        "file-category-addtask-hint": "Bestanden worden automatisch ingedeeld in submappen op type",
        "file-category-videos": "Video\\'s",
        "file-category-music": "Muziek",
        "file-category-images": "Afbeeldingen",
        "file-category-documents": "Documenten",
        "file-category-archives": "Archieven",
        "file-category-programs": "Programma\\'s",
    },
    "pl": {
        "file-category-enabled": "Inteligentna klasyfikacja plików",
        "file-category-hint": "Pliki niepasujące do żadnej kategorii są zapisywane w głównym katalogu pobierania",
        "file-category-addtask-hint": "Pliki będą automatycznie klasyfikowane do podkatalogów według typu",
        "file-category-videos": "Filmy",
        "file-category-music": "Muzyka",
        "file-category-images": "Obrazy",
        "file-category-documents": "Dokumenty",
        "file-category-archives": "Archiwa",
        "file-category-programs": "Programy",
    },
    "pt-BR": {
        "file-category-enabled": "Classificação inteligente de arquivos",
        "file-category-hint": "Arquivos que não correspondem a nenhuma categoria são salvos no diretório de download principal",
        "file-category-addtask-hint": "Os arquivos serão classificados automaticamente em subdiretórios por tipo",
        "file-category-videos": "Vídeos",
        "file-category-music": "Música",
        "file-category-images": "Imagens",
        "file-category-documents": "Documentos",
        "file-category-archives": "Arquivos",
        "file-category-programs": "Programas",
    },
    "ro": {
        "file-category-enabled": "Clasificare inteligentă a fișierelor",
        "file-category-hint": "Fișierele care nu se potrivesc niciunei categorii sunt salvate în directorul principal de descărcare",
        "file-category-addtask-hint": "Fișierele vor fi clasificate automat în subdirectoare după tip",
        "file-category-videos": "Videoclipuri",
        "file-category-music": "Muzică",
        "file-category-images": "Imagini",
        "file-category-documents": "Documente",
        "file-category-archives": "Arhive",
        "file-category-programs": "Programe",
    },
    "ru": {
        "file-category-enabled": "Умная классификация файлов",
        "file-category-hint": "Файлы, не соответствующие ни одной категории, сохраняются в основной папке загрузок",
        "file-category-addtask-hint": "Файлы будут автоматически распределены по подпапкам по типу",
        "file-category-videos": "Видео",
        "file-category-music": "Музыка",
        "file-category-images": "Изображения",
        "file-category-documents": "Документы",
        "file-category-archives": "Архивы",
        "file-category-programs": "Программы",
    },
    "th": {
        "file-category-enabled": "จัดประเภทไฟล์อัจฉริยะ",
        "file-category-hint": "ไฟล์ที่ไม่ตรงกับหมวดหมู่ใดจะถูกบันทึกในไดเร็กทอรีดาวน์โหลดหลัก",
        "file-category-addtask-hint": "ไฟล์จะถูกจัดประเภทอัตโนมัติตามชนิดในไดเร็กทอรีย่อย",
        "file-category-videos": "วิดีโอ",
        "file-category-music": "เพลง",
        "file-category-images": "รูปภาพ",
        "file-category-documents": "เอกสาร",
        "file-category-archives": "ไฟล์บีบอัด",
        "file-category-programs": "โปรแกรม",
    },
    "tr": {
        "file-category-enabled": "Akıllı Dosya Sınıflandırma",
        "file-category-hint": "Hiçbir kategoriye uymayan dosyalar ana indirme dizinine kaydedilir",
        "file-category-addtask-hint": "Dosyalar türlerine göre alt dizinlere otomatik olarak sınıflandırılır",
        "file-category-videos": "Videolar",
        "file-category-music": "Müzik",
        "file-category-images": "Görseller",
        "file-category-documents": "Belgeler",
        "file-category-archives": "Arşivler",
        "file-category-programs": "Programlar",
    },
    "uk": {
        "file-category-enabled": "Розумна класифікація файлів",
        "file-category-hint": "Файли, що не відповідають жодній категорії, зберігаються у головній папці завантажень",
        "file-category-addtask-hint": "Файли будуть автоматично розподілені за типами у підпапки",
        "file-category-videos": "Відео",
        "file-category-music": "Музика",
        "file-category-images": "Зображення",
        "file-category-documents": "Документи",
        "file-category-archives": "Архіви",
        "file-category-programs": "Програми",
    },
    "vi": {
        "file-category-enabled": "Phân loại tệp thông minh",
        "file-category-hint": "Các tệp không khớp với bất kỳ danh mục nào sẽ được lưu vào thư mục tải xuống chính",
        "file-category-addtask-hint": "Tệp sẽ được tự động phân loại vào các thư mục con theo loại",
        "file-category-videos": "Video",
        "file-category-music": "Âm nhạc",
        "file-category-images": "Hình ảnh",
        "file-category-documents": "Tài liệu",
        "file-category-archives": "Lưu trữ",
        "file-category-programs": "Chương trình",
    },
    "zh-CN": {
        "file-category-enabled": "文件分类下载",
        "file-category-hint": "不匹配任何分类的文件保存在主下载目录",
        "file-category-addtask-hint": "文件将按类型自动分类到子目录",
        "file-category-videos": "视频",
        "file-category-music": "音乐",
        "file-category-images": "图片",
        "file-category-documents": "文档",
        "file-category-archives": "压缩包",
        "file-category-programs": "程序",
    },
    "zh-TW": {
        "file-category-enabled": "檔案分類下載",
        "file-category-hint": "不符合任何分類的檔案儲存在主下載目錄",
        "file-category-addtask-hint": "檔案將按類型自動分類到子目錄",
        "file-category-videos": "影片",
        "file-category-music": "音樂",
        "file-category-images": "圖片",
        "file-category-documents": "文件",
        "file-category-archives": "壓縮檔",
        "file-category-programs": "程式",
    },
}

KEYS_ORDER = [
    "file-category-enabled",
    "file-category-hint",
    "file-category-addtask-hint",
    "file-category-videos",
    "file-category-music",
    "file-category-images",
    "file-category-documents",
    "file-category-archives",
    "file-category-programs",
]


def update_locale(locale_dir, translations):
    filepath = os.path.join(LOCALES_DIR, locale_dir, "preferences.js")
    if not os.path.exists(filepath):
        print(f"  SKIP {filepath} (not found)")
        return

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Check if keys already exist
    if "'file-category-enabled'" in content:
        print(f"  SKIP {locale_dir} (keys already present)")
        return

    # Build the new entries string
    entries = []
    for key in KEYS_ORDER:
        val = translations[key].replace("'", "\\'")
        entries.append(f"  '{key}': '{val}',")
    new_block = "\n".join(entries) + "\n"

    # Insert before the closing `}`
    # Find the last `}` in the file
    last_brace = content.rfind("}")
    if last_brace == -1:
        print(f"  ERROR {locale_dir}: no closing brace found")
        return

    content = content[:last_brace] + new_block + content[last_brace:]

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  OK   {locale_dir}")


if __name__ == "__main__":
    print("Updating 26 locale files with file-category keys...")
    for locale in sorted(TRANSLATIONS):
        update_locale(locale, TRANSLATIONS[locale])
    print("Done.")
