//! Localised strings for Rust-side task notifications.
//!
//! This table is generated from `src/shared/locales/*/task.js` for the
//! small subset of strings required while the WebView is destroyed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskNotificationTexts {
    pub download_complete_title: &'static str,
    pub download_complete_body: &'static str,
    pub bt_complete_title: &'static str,
    pub bt_complete_body: &'static str,
    pub download_failed_title: &'static str,
    pub download_failed_body: &'static str,
    pub error_unknown: &'static str,
}

const EN_US_TEXTS: TaskNotificationTexts = TaskNotificationTexts {
    download_complete_title: "Download Complete",
    download_complete_body: "\"{taskName}\" completed",
    bt_complete_title: "BT download complete, seeding...",
    bt_complete_body: "\"{taskName}\" — download complete, seeding...",
    download_failed_title: "Download Failed",
    download_failed_body: "Failed to download \"{taskName}\"",
    error_unknown: "Unknown error",
};

#[cfg(test)]
const SUPPORTED_LOCALES: &[&str] = &[
    "ar", "bg", "ca", "de", "el", "en-US", "es", "fa", "fr", "hu", "id", "it", "ja", "ko", "nb",
    "nl", "pl", "pt-BR", "ro", "ru", "th", "tr", "uk", "vi", "zh-CN", "zh-TW",
];

pub fn resolve_supported_locale(raw_locale: &str) -> &'static str {
    let locale = raw_locale.trim();
    if locale.is_empty() || locale == "auto" {
        return "en-US";
    }

    match locale {
        "ar" => "ar",
        "bg" => "bg",
        "ca" => "ca",
        "de" => "de",
        "el" => "el",
        "en-US" => "en-US",
        "es" => "es",
        "fa" => "fa",
        "fr" => "fr",
        "hu" => "hu",
        "id" => "id",
        "it" => "it",
        "ja" => "ja",
        "ko" => "ko",
        "nb" => "nb",
        "nl" => "nl",
        "pl" => "pl",
        "pt-BR" => "pt-BR",
        "ro" => "ro",
        "ru" => "ru",
        "th" => "th",
        "tr" => "tr",
        "uk" => "uk",
        "vi" => "vi",
        "zh-CN" => "zh-CN",
        "zh-TW" => "zh-TW",
        _ if locale.starts_with("ar") => "ar",
        _ if locale.starts_with("de") => "de",
        _ if locale.starts_with("en") => "en-US",
        _ if locale.starts_with("es") => "es",
        _ if locale.starts_with("fr") => "fr",
        _ if locale.starts_with("it") => "it",
        _ if locale.starts_with("pt") => "pt-BR",
        "zh-HK" => "zh-TW",
        _ if locale.starts_with("zh") => "zh-CN",
        _ => "en-US",
    }
}

pub fn texts_for_locale(locale: &str) -> TaskNotificationTexts {
    match resolve_supported_locale(locale) {
        "ar" => TaskNotificationTexts {
            download_complete_title: "اكتمل التنزيل",
            download_complete_body: "اكتمل تنزيل \"{taskName}\"",
            bt_complete_title: "اكتمل تنزيل BT، جارٍ المشاركة...",
            bt_complete_body: "\"{taskName}\" — اكتمل التنزيل، جارٍ البذر...",
            download_failed_title: "فشل التنزيل",
            download_failed_body: "فشل تنزيل \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "bg" => TaskNotificationTexts {
            download_complete_title: "Изтеглянето е завършено",
            download_complete_body: "«{taskName}» е изтеглено",
            bt_complete_title: "BT изтеглянето е завършено, споделяне...",
            bt_complete_body: "«{taskName}» — изтеглянето завърши, споделяне...",
            download_failed_title: "Изтеглянето е неуспешно",
            download_failed_body: "Неуспешно изтегляне на «{taskName}»",
            error_unknown: "Unknown error",
        },
        "ca" => TaskNotificationTexts {
            download_complete_title: "Descàrrega completada",
            download_complete_body: "«{taskName}» completada",
            bt_complete_title: "Descàrrega BT completada, compartint...",
            bt_complete_body: "«{taskName}» — descàrrega completada, compartint...",
            download_failed_title: "Descàrrega fallida",
            download_failed_body: "No s'ha pogut descarregar «{taskName}»",
            error_unknown: "Unknown error",
        },
        "de" => TaskNotificationTexts {
            download_complete_title: "Download abgeschlossen",
            download_complete_body: "„{taskName}\" abgeschlossen",
            bt_complete_title: "BT-Download abgeschlossen, Seeding...",
            bt_complete_body: "„{taskName}\" — Download abgeschlossen, Seeding...",
            download_failed_title: "Download fehlgeschlagen",
            download_failed_body: "Download von „{taskName}\" fehlgeschlagen",
            error_unknown: "Unknown error",
        },
        "el" => TaskNotificationTexts {
            download_complete_title: "Η λήψη ολοκληρώθηκε",
            download_complete_body: "Η λήψη του \"{taskName}\" ολοκληρώθηκε",
            bt_complete_title: "Η BT λήψη ολοκληρώθηκε, διαμοιρασμός...",
            bt_complete_body: "\"{taskName}\" — λήψη ολοκληρώθηκε, σπορά...",
            download_failed_title: "Η λήψη απέτυχε",
            download_failed_body: "Αποτυχία λήψης του \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "es" => TaskNotificationTexts {
            download_complete_title: "Descarga completada",
            download_complete_body: "\"{taskName}\" completado",
            bt_complete_title: "Descarga BT completada, sembrando...",
            bt_complete_body: "\"{taskName}\" — descarga completa, compartiendo...",
            download_failed_title: "Descarga fallida",
            download_failed_body: "Error al descargar \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "fa" => TaskNotificationTexts {
            download_complete_title: "دانلود تکمیل شد",
            download_complete_body: "دانلود \"{taskName}\" کامل شد",
            bt_complete_title: "دانلود BT تکمیل شد، در حال اشتراک‌گذاری...",
            bt_complete_body: "\"{taskName}\" — دانلود تمام شد، بذرگذاری...",
            download_failed_title: "دانلود ناموفق بود",
            download_failed_body: "دانلود \"{taskName}\" ناموفق بود",
            error_unknown: "Unknown error",
        },
        "fr" => TaskNotificationTexts {
            download_complete_title: "Téléchargement terminé",
            download_complete_body: "Téléchargement de « {taskName} » terminé",
            bt_complete_title: "Téléchargement BT terminé, partage en cours...",
            bt_complete_body: "« {taskName} » — téléchargement terminé, partage en cours...",
            download_failed_title: "Échec du téléchargement",
            download_failed_body: "Échec du téléchargement de « {taskName} »",
            error_unknown: "Unknown error",
        },
        "hu" => TaskNotificationTexts {
            download_complete_title: "Letöltés befejezve",
            download_complete_body: "\"{taskName}\" letöltése kész",
            bt_complete_title: "BT letöltés befejezve, megosztás...",
            bt_complete_body: "\"{taskName}\" — letöltés kész, megosztás...",
            download_failed_title: "Letöltés sikertelen",
            download_failed_body: "\"{taskName}\" letöltése sikertelen",
            error_unknown: "Unknown error",
        },
        "id" => TaskNotificationTexts {
            download_complete_title: "Unduhan selesai",
            download_complete_body: "Unduhan \"{taskName}\" selesai",
            bt_complete_title: "Unduhan BT selesai, berbagi...",
            bt_complete_body: "\"{taskName}\" — unduhan selesai, seeding...",
            download_failed_title: "Unduhan gagal",
            download_failed_body: "Gagal mengunduh \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "it" => TaskNotificationTexts {
            download_complete_title: "Download completato",
            download_complete_body: "Download di \"{taskName}\" completato",
            bt_complete_title: "Download BT completato, condivisione...",
            bt_complete_body: "\"{taskName}\" — download completato, condivisione...",
            download_failed_title: "Download non riuscito",
            download_failed_body: "Download di \"{taskName}\" fallito",
            error_unknown: "Unknown error",
        },
        "ja" => TaskNotificationTexts {
            download_complete_title: "ダウンロード完了",
            download_complete_body: "「{taskName}」 のダウンロードが完了",
            bt_complete_title: "BT ダウンロード完了、シード中...",
            bt_complete_body: "「{taskName}」 ダウンロード完了、シード中...",
            download_failed_title: "ダウンロード失敗",
            download_failed_body: "「{taskName}」 のダウンロードに失敗",
            error_unknown: "不明なエラー",
        },
        "ko" => TaskNotificationTexts {
            download_complete_title: "다운로드 완료",
            download_complete_body: "\"{taskName}\" 다운로드 완료",
            bt_complete_title: "BT 다운로드 완료, 시딩 중...",
            bt_complete_body: "\"{taskName}\" 다운로드 완료, 시딩 중...",
            download_failed_title: "다운로드 실패",
            download_failed_body: "\"{taskName}\" 다운로드 실패",
            error_unknown: "알 수 없는 오류",
        },
        "nb" => TaskNotificationTexts {
            download_complete_title: "Nedlasting fullført",
            download_complete_body: "Nedlasting av \"{taskName}\" fullført",
            bt_complete_title: "BT-nedlasting fullført, deler...",
            bt_complete_body: "\"{taskName}\" — nedlasting fullført, deler...",
            download_failed_title: "Nedlasting mislyktes",
            download_failed_body: "Kunne ikke laste ned \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "nl" => TaskNotificationTexts {
            download_complete_title: "Download voltooid",
            download_complete_body: "Download van \"{taskName}\" voltooid",
            bt_complete_title: "BT-download voltooid, seeden...",
            bt_complete_body: "\"{taskName}\" — download voltooid, seeden...",
            download_failed_title: "Download mislukt",
            download_failed_body: "Download van \"{taskName}\" mislukt",
            error_unknown: "Unknown error",
        },
        "pl" => TaskNotificationTexts {
            download_complete_title: "Pobieranie ukończone",
            download_complete_body: "Pobieranie \"{taskName}\" zakończone",
            bt_complete_title: "Pobieranie BT ukończone, udostępnianie...",
            bt_complete_body: "\"{taskName}\" — pobieranie zakończone, udostępnianie...",
            download_failed_title: "Pobieranie nie powiodło się",
            download_failed_body: "Nie udało się pobrać \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "pt-BR" => TaskNotificationTexts {
            download_complete_title: "Download concluído",
            download_complete_body: "Download de \"{taskName}\" concluído",
            bt_complete_title: "Download BT concluído, semeando...",
            bt_complete_body: "\"{taskName}\" — download concluído, semeando...",
            download_failed_title: "Download falhou",
            download_failed_body: "Falha ao baixar \"{taskName}\"",
            error_unknown: "Unknown error",
        },
        "ro" => TaskNotificationTexts {
            download_complete_title: "Descărcare finalizată",
            download_complete_body: "Descărcarea \"{taskName}\" finalizată",
            bt_complete_title: "Descărcare BT finalizată, se distribuie...",
            bt_complete_body: "\"{taskName}\" — descărcare finalizată, partajare...",
            download_failed_title: "Descărcarea a eșuat",
            download_failed_body: "Descărcarea \"{taskName}\" a eșuat",
            error_unknown: "Unknown error",
        },
        "ru" => TaskNotificationTexts {
            download_complete_title: "Загрузка завершена",
            download_complete_body: "Загрузка «{taskName}» завершена",
            bt_complete_title: "BT-загрузка завершена, раздача...",
            bt_complete_body: "«{taskName}» — загрузка завершена, раздача...",
            download_failed_title: "Загрузка не удалась",
            download_failed_body: "Не удалось загрузить «{taskName}»",
            error_unknown: "Unknown error",
        },
        "th" => TaskNotificationTexts {
            download_complete_title: "ดาวน์โหลดเสร็จสิ้น",
            download_complete_body: "ดาวน์โหลด \"{taskName}\" เสร็จสิ้น",
            bt_complete_title: "ดาวน์โหลด BT เสร็จ กำลังแชร์...",
            bt_complete_body: "\"{taskName}\" — ดาวน์โหลดเสร็จ กำลังแชร์...",
            download_failed_title: "ดาวน์โหลดไม่สำเร็จ",
            download_failed_body: "ดาวน์โหลด \"{taskName}\" ล้มเหลว",
            error_unknown: "Unknown error",
        },
        "tr" => TaskNotificationTexts {
            download_complete_title: "İndirme tamamlandı",
            download_complete_body: "\"{taskName}\" tamamlandı",
            bt_complete_title: "BT indirmesi tamamlandı, paylaşılıyor...",
            bt_complete_body: "\"{taskName}\" — indirme tamamlandı, paylaşılıyor...",
            download_failed_title: "İndirme başarısız",
            download_failed_body: "\"{taskName}\" indirilemedi",
            error_unknown: "Unknown error",
        },
        "uk" => TaskNotificationTexts {
            download_complete_title: "Завантаження завершено",
            download_complete_body: "Завантаження «{taskName}» завершено",
            bt_complete_title: "BT-завантаження завершено, роздача...",
            bt_complete_body: "«{taskName}» — завантаження завершено, роздача...",
            download_failed_title: "Завантаження не вдалося",
            download_failed_body: "Не вдалося завантажити «{taskName}»",
            error_unknown: "Unknown error",
        },
        "vi" => TaskNotificationTexts {
            download_complete_title: "Tải xuống hoàn thành",
            download_complete_body: "Đã tải xong \"{taskName}\"",
            bt_complete_title: "Tải BT hoàn thành, đang chia sẻ...",
            bt_complete_body: "\"{taskName}\" — tải về hoàn tất, đang chia sẻ...",
            download_failed_title: "Tải xuống thất bại",
            download_failed_body: "Tải \"{taskName}\" thất bại",
            error_unknown: "Unknown error",
        },
        "zh-CN" => TaskNotificationTexts {
            download_complete_title: "下载完成",
            download_complete_body: "「{taskName}」下载完成",
            bt_complete_title: "BT 下载完成，正在做种...",
            bt_complete_body: "「{taskName}」已下载完成，开始做种...",
            download_failed_title: "下载失败",
            download_failed_body: "「{taskName}」下载失败",
            error_unknown: "未知错误",
        },
        "zh-TW" => TaskNotificationTexts {
            download_complete_title: "下載完成",
            download_complete_body: "「{taskName}」下載完成",
            bt_complete_title: "BT 下載完成，正在做種...",
            bt_complete_body: "「{taskName}」已下載完成，開始做種...",
            download_failed_title: "下載失敗",
            download_failed_body: "「{taskName}」下載失敗",
            error_unknown: "未知錯誤",
        },
        _ => EN_US_TEXTS,
    }
}

pub fn format_task_message(template: &str, task_name: &str) -> String {
    template.replace("{taskName}", task_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_explicit_supported_locale() {
        assert_eq!(resolve_supported_locale("zh-CN"), "zh-CN");
    }

    #[test]
    fn resolves_language_prefix_locale() {
        assert_eq!(resolve_supported_locale("zh-Hans-CN"), "zh-CN");
        assert_eq!(resolve_supported_locale("en-AU"), "en-US");
        assert_eq!(resolve_supported_locale("pt-PT"), "pt-BR");
    }

    #[test]
    fn falls_back_to_en_us_for_auto_or_unknown_locale() {
        assert_eq!(resolve_supported_locale("auto"), "en-US");
        assert_eq!(resolve_supported_locale("xx-YY"), "en-US");
    }

    #[test]
    fn all_supported_locales_have_notification_texts() {
        assert_eq!(SUPPORTED_LOCALES.len(), 26);
        for locale in SUPPORTED_LOCALES {
            let texts = texts_for_locale(locale);
            assert!(
                !texts.download_complete_title.is_empty(),
                "empty complete title for {locale}"
            );
            assert!(
                texts.download_complete_body.contains("{taskName}"),
                "complete body lacks placeholder for {locale}"
            );
            assert!(
                !texts.bt_complete_title.is_empty(),
                "empty BT title for {locale}"
            );
            assert!(
                texts.bt_complete_body.contains("{taskName}"),
                "BT body lacks placeholder for {locale}"
            );
            assert!(
                !texts.download_failed_title.is_empty(),
                "empty failed title for {locale}"
            );
            assert!(
                texts.download_failed_body.contains("{taskName}"),
                "failed body lacks placeholder for {locale}"
            );
            assert!(
                !texts.error_unknown.is_empty(),
                "empty unknown error for {locale}"
            );
        }
    }

    #[test]
    fn localises_download_complete_texts() {
        let texts = texts_for_locale("zh-CN");
        assert_eq!(texts.download_complete_title, "下载完成");
        assert_eq!(
            format_task_message(texts.download_complete_body, "file.zip"),
            "「file.zip」下载完成"
        );
    }
}
