//! 업로드된 CSV/XLSX 바이트를 컬럼 + 행(문자열 셀)으로 파싱.
//! 자동감지(헤더/구분자/인코딩/포맷) + 얇은 override.

#[derive(Debug, Clone, Default)]
pub struct ParseOptions {
    pub has_header: Option<bool>, // None = auto(true)
    pub delimiter: Option<u8>,    // None = auto(',' 기본, ';'/'\t' 감지)
    pub encoding: Option<String>, // None = auto(utf-8/BOM → cp949 fallback)
    pub sheet: Option<String>,    // XLSX 시트명; None = 첫 시트
}

#[derive(Debug, Clone)]
pub struct ParsedDataset {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,      // columns에 정렬된 셀
    pub sheets: Option<Vec<String>>, // XLSX면 전체 시트명(UI 선택용)
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("디코딩 실패: {0}")]
    Decode(String),
    #[error("CSV 파싱 실패: {0}")]
    Csv(String),
    #[error("XLSX 파싱 실패: {0}")]
    Xlsx(String),
    #[error("시트 '{0}' 없음")]
    SheetNotFound(String),
}

use std::collections::HashMap;
use std::io::Cursor;

/// 업로드 바이트를 파싱. 포맷은 매직 넘버로 감지(XLSX=zip `PK\x03\x04`, 그 외 CSV).
pub fn parse_upload(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    if is_xlsx(bytes) {
        parse_xlsx(bytes, opts)
    } else {
        parse_csv(bytes, opts)
    }
}

fn is_xlsx(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0..4] == [0x50, 0x4B, 0x03, 0x04]
}

fn parse_csv(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    let text = decode(bytes, opts.encoding.as_deref())?;
    let delim = opts.delimiter.unwrap_or_else(|| detect_delimiter(&text));

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false) // 헤더는 우리가 직접 처리(컬럼 네이밍 제어)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut records: Vec<Vec<String>> = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| ParseError::Csv(e.to_string()))?;
        records.push(rec.iter().map(|s| s.to_string()).collect());
    }

    let has_header = opts.has_header.unwrap_or(true);
    build(records, has_header, None)
}

fn parse_xlsx(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    use calamine::{Reader, Xlsx, XlsxError};

    // calamine 0.26: open_workbook_from_rs<R, RS> -> Result<R, R::Error>; R::Error for
    // Xlsx<RS> is XlsxError. 그 associated type을 closure 인자에 명시해야 추론된다.
    let mut wb: Xlsx<Cursor<Vec<u8>>> =
        calamine::open_workbook_from_rs(Cursor::new(bytes.to_vec()))
            .map_err(|e: XlsxError| ParseError::Xlsx(e.to_string()))?;
    let sheet_names = wb.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err(ParseError::Xlsx("시트 없음".into()));
    }
    let target = match &opts.sheet {
        Some(s) => {
            if !sheet_names.iter().any(|n| n == s) {
                return Err(ParseError::SheetNotFound(s.clone()));
            }
            s.clone()
        }
        None => sheet_names[0].clone(),
    };

    // calamine 0.26: worksheet_range(&str) -> Result<Range<Data>, XlsxError>
    let range = wb
        .worksheet_range(&target)
        .map_err(|e| ParseError::Xlsx(e.to_string()))?;

    let mut records: Vec<Vec<String>> = Vec::new();
    for row in range.rows() {
        records.push(row.iter().map(data_to_string).collect::<Vec<_>>());
    }

    let has_header = opts.has_header.unwrap_or(true);
    build(records, has_header, Some(sheet_names))
}

/// calamine 셀을 표시 문자열로. 빈 셀→"".
fn data_to_string(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // 정수형 float은 ".0" 없이
            if f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR({e:?})"),
    }
}

/// records(헤더 포함 여부는 has_header)를 columns + 정렬된 rows로.
fn build(
    mut records: Vec<Vec<String>>,
    has_header: bool,
    sheets: Option<Vec<String>>,
) -> Result<ParsedDataset, ParseError> {
    if records.is_empty() {
        return Ok(ParsedDataset {
            columns: vec![],
            rows: vec![],
            sheets,
        });
    }
    let columns: Vec<String> = if has_header {
        normalize_columns(records.remove(0))
    } else {
        let ncols = records.iter().map(|r| r.len()).max().unwrap_or(0);
        (1..=ncols).map(|i| format!("col{i}")).collect()
    };
    let width = columns.len();
    let rows: Vec<Vec<String>> = records
        .into_iter()
        .map(|mut cells| {
            cells.resize(width, String::new()); // 짧으면 빈 문자열 패딩, 길면 truncate
            cells.truncate(width);
            cells
        })
        .collect();
    Ok(ParsedDataset {
        columns,
        rows,
        sheets,
    })
}

/// 빈 헤더 → colN(1-based), 중복 → base_2, base_3 …
fn normalize_columns(raw: Vec<String>) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    raw.into_iter()
        .enumerate()
        .map(|(i, name)| {
            let base = if name.trim().is_empty() {
                format!("col{}", i + 1)
            } else {
                name.trim().to_string()
            };
            let count = seen.entry(base.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base}_{count}")
            }
        })
        .collect()
}

/// 첫 줄에서 ','/';'/'\t' 중 최빈 구분자.
fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    let candidates = [
        (b',', first.matches(',').count()),
        (b';', first.matches(';').count()),
        (b'\t', first.matches('\t').count()),
    ];
    candidates
        .iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n > 0)
        .map(|(d, _)| *d)
        .unwrap_or(b',')
}

/// 인코딩 디코드. override 없으면 UTF-8(BOM strip) 시도 후 실패 시 CP949(EUC-KR).
fn decode(bytes: &[u8], encoding: Option<&str>) -> Result<String, ParseError> {
    match encoding.map(|e| e.to_ascii_lowercase()) {
        Some(e) if e == "utf-8" || e == "utf8" => decode_with(bytes, encoding_rs::UTF_8),
        Some(e) if e == "cp949" || e == "euc-kr" || e == "euckr" => {
            decode_with(bytes, encoding_rs::EUC_KR)
        }
        Some(other) => Err(ParseError::Decode(format!("지원 안 하는 인코딩: {other}"))),
        None => {
            // auto: UTF-8 strict 먼저(BOM 자동 strip), 실패 시 CP949
            if let Ok(s) = decode_with(bytes, encoding_rs::UTF_8) {
                Ok(s)
            } else {
                decode_with(bytes, encoding_rs::EUC_KR)
                    .map_err(|_| ParseError::Decode("auto: UTF-8·CP949 모두 실패".into()))
            }
        }
    }
}

fn decode_with(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> Result<String, ParseError> {
    let (cow, _enc, had_errors) = enc.decode(bytes); // UTF_8.decode는 BOM도 strip
    if had_errors {
        Err(ParseError::Decode(enc.name().to_string()))
    } else {
        Ok(cow.into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ParseOptions {
        ParseOptions::default()
    }

    #[test]
    fn csv_comma_with_header() {
        let bytes = b"email,pw\na@ex.com,p1\nb@ex.com,p2\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["email", "pw"]);
        assert_eq!(d.rows.len(), 2);
        assert_eq!(d.rows[0], vec!["a@ex.com", "p1"]);
        assert!(d.sheets.is_none());
    }

    #[test]
    fn csv_semicolon_autodetected() {
        let bytes = b"a;b;c\n1;2;3\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b", "c"]);
        assert_eq!(d.rows[0], vec!["1", "2", "3"]);
    }

    #[test]
    fn csv_tab_autodetected() {
        let bytes = b"a\tb\n1\t2\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b"]);
        assert_eq!(d.rows[0], vec!["1", "2"]);
    }

    #[test]
    fn csv_no_header_generates_col_names() {
        let bytes = b"1,2,3\n4,5,6\n";
        let mut o = opts();
        o.has_header = Some(false);
        let d = parse_upload(bytes, &o).unwrap();
        assert_eq!(d.columns, vec!["col1", "col2", "col3"]);
        assert_eq!(d.rows.len(), 2);
        assert_eq!(d.rows[0], vec!["1", "2", "3"]);
    }

    #[test]
    fn csv_blank_and_duplicate_columns_normalized() {
        // 빈 헤더 → colN, 중복 → base_2
        let bytes = b"name,,name\nx,y,z\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["name", "col2", "name_2"]);
    }

    #[test]
    fn csv_empty_cells_become_empty_strings_and_pad() {
        let bytes = b"a,b,c\n1,,3\n4\n"; // 둘째 데이터행은 셀 1개 → b,c는 빈 문자열로 패딩
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.rows[0], vec!["1", "", "3"]);
        assert_eq!(d.rows[1], vec!["4", "", ""]);
    }

    #[test]
    fn csv_utf8_bom_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"name\nalice\n");
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["name"], "BOM이 첫 컬럼명에 섞이면 안 됨");
    }

    #[test]
    fn csv_cp949_autodetected() {
        // "이름" in CP949(EUC-KR) = 0xC0 0xCC 0xB8 0xA7
        let mut bytes = vec![0xC0, 0xCC, 0xB8, 0xA7];
        bytes.extend_from_slice(b"\nx\n");
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["이름"]);
        assert_eq!(d.rows[0], vec!["x"]);
    }

    #[test]
    fn xlsx_single_sheet() {
        let bytes = make_xlsx(&[("Sheet1", vec![vec!["a", "b"], vec!["1", "2"]])]);
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b"]);
        assert_eq!(d.rows[0], vec!["1", "2"]);
        assert_eq!(d.sheets.as_deref(), Some(&["Sheet1".to_string()][..]));
    }

    #[test]
    fn xlsx_multi_sheet_selects_named() {
        let bytes = make_xlsx(&[
            ("First", vec![vec!["x"], vec!["1"]]),
            ("Second", vec![vec!["y"], vec!["2"]]),
        ]);
        // 기본은 첫 시트
        let d0 = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d0.columns, vec!["x"]);
        assert_eq!(d0.sheets.as_ref().unwrap().len(), 2);
        // override로 둘째 시트
        let mut o = opts();
        o.sheet = Some("Second".to_string());
        let d1 = parse_upload(&bytes, &o).unwrap();
        assert_eq!(d1.columns, vec!["y"]);
        assert_eq!(d1.rows[0], vec!["2"]);
    }

    /// 테스트용 XLSX 바이트 생성(rust_xlsxwriter, dev-dep).
    fn make_xlsx(sheets: &[(&str, Vec<Vec<&str>>)]) -> Vec<u8> {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        for (name, grid) in sheets {
            let ws = wb.add_worksheet();
            ws.set_name(*name).unwrap();
            for (r, row) in grid.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    ws.write_string(r as u32, c as u16, *cell).unwrap();
                }
            }
        }
        wb.save_to_buffer().unwrap()
    }
}
