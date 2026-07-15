"""
Stage 46: 인덱스 기반 시추 데이터 정밀 추출 모듈
PyMuPDF find_tables() API를 사용하여 PDF 표의 셀 인덱스(Row/Col)를 직접 타겟팅합니다.
"""
import os
import re
import logging
import unicodedata
import fitz  # PyMuPDF

# 기존 유틸 함수 재사용 (정규 정의는 parsers.pdf_parser_odl 에 위치)
import pdf_convert.parsers.pdf_parser_odl as ppo
normalize_strata_name = ppo.normalize_strata_name
natural_sort_key = ppo.natural_sort_key
clean_float = ppo.clean_float
validate_suwon_coordinates = ppo.validate_suwon_coordinates

logger = logging.getLogger(__name__)

# =============================================================================
# 1. 셀 데이터 정제 함수 (Cell Data Cleansing)
# =============================================================================

def clean_cell_text(raw):
    """HWP/PDF 표 셀에서 추출된 텍스트의 제어 문자, 줄바꿈, 여백 등을 제거"""
    if raw is None:
        return ""
    text = unicodedata.normalize('NFKC', str(raw))
    # 제어 문자 제거 (0x00~0x08, 0x0b, 0x0c, 0x0e~0x1f, 0x7f)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    # 줄바꿈/탭 → 공백
    text = re.sub(r'[\r\n\t]+', ' ', text)
    # 연속 공백 → 단일 공백
    text = re.sub(r'\s{2,}', ' ', text)
    return text.strip()


def normalize_bh_id(raw_id):
    """
    시추번호 정규화: 공백 제거, 대문자화, 하이픈 표준화.
    숫자 앞의 '0'(Zero-padding)이 유실되지 않도록 문자열 기반으로 정규화합니다.
    """
    if not raw_id: return ""
    text = clean_cell_text(raw_id).upper()
    
    # 1. 알파벳, 숫자, 하이픈 외 제거
    text = re.sub(r'[^A-Z0-9-]', '', text)
    
    # 2. 중복 하이픈 정리
    text = re.sub(r'-+', '-', text)
    
    return text.strip('-')


def normalize_strata(raw_text):
    """지층명 정규화: 기존 함수 래핑"""
    text = clean_cell_text(raw_text)
    return normalize_strata_name(text)


def extract_depth_values(raw_depth):
    """심도 셀에서 줄바꿈/공백으로 분리된 복수 숫자를 보존해 추출.

    PyMuPDF find_tables()가 상/하 심도를 한 셀로 합치는 경우가 있다.
    예: "25\n30.5"를 일반 clean_float()에 바로 넣으면 "2530.5"가 되므로,
    심도 컬럼에서는 숫자 토큰을 먼저 분리한 뒤 마지막 값을 하심도로 사용한다.
    """
    if raw_depth is None:
        return []

    text = unicodedata.normalize("NFKC", str(raw_depth))
    text = text.replace("O", "0").replace("o", "0")
    values = []
    for match in re.finditer(r"[-+]?(?:\d+(?:[,.]\d+)?|[,.]\s*\d+)", text):
        token = re.sub(r"\s+", "", match.group(0)).replace(",", ".")
        if token.startswith("."):
            token = "0" + token
        value = clean_float(token)
        if value is not None:
            values.append(value)
    return values


def extract_project_info(filename):
    """파일명에서 프로젝트 정보 추출 (예: page1_project1_report.pdf → PJ_1-1)"""
    page_match = re.search(r'page(\d+)', filename, re.IGNORECASE)
    proj_match = re.search(r'project(\d+)', filename, re.IGNORECASE)
    page_num = page_match.group(1) if page_match else "?"
    proj_num = proj_match.group(1) if proj_match else "?"
    return f"PJ_{page_num}-{proj_num}"


PROJECT_NAME_LABEL_RE = re.compile(
    r"(조\s*사\s*명|용\s*역\s*명|공\s*사\s*명|사\s*업\s*명|현\s*장\s*명|프로젝트\s*명|과\s*업\s*명)"
)


def extract_project_name_from_pdf(pdf_path, max_pages=3):
    """PDF 본문/블록 텍스트에서 조사명 또는 프로젝트명을 추출합니다."""
    doc = None
    try:
        doc = fitz.open(pdf_path)
        page_count = min(len(doc), max_pages)
        for page_idx in range(page_count):
            page = doc[page_idx]
            candidates = _project_name_candidates_from_text(page.get_text("text"))
            candidates.extend(_project_name_candidates_from_blocks(page))
            for candidate in candidates:
                project_name = _clean_project_name_candidate(candidate)
                if project_name:
                    logger.info(f"  [Project] PDF 프로젝트명 감지: {project_name}")
                    return project_name
    except Exception as e:
        logger.warning(f"  [Project] PDF 프로젝트명 감지 실패: {e}")
    finally:
        if doc:
            doc.close()
    return None


def _project_name_candidates_from_text(text):
    lines = [clean_cell_text(line) for line in (text or "").splitlines()]
    lines = [line for line in lines if line]
    candidates = []

    for idx, line in enumerate(lines):
        label_match = PROJECT_NAME_LABEL_RE.search(line)
        if not label_match:
            continue

        after_label = line[label_match.end():]
        after_label = re.sub(r"^[\s:：|\-_=]+", "", after_label).strip()
        if after_label:
            candidates.append(after_label)

        if idx + 1 < len(lines):
            candidates.append(lines[idx + 1])

    return candidates


def _project_name_candidates_from_blocks(page):
    candidates = []
    try:
        for block in page.get_text("blocks"):
            text = clean_cell_text(block[4] if len(block) > 4 else "")
            if not text or not PROJECT_NAME_LABEL_RE.search(text):
                continue
            candidates.extend(_project_name_candidates_from_text(text))
    except Exception:
        return []
    return candidates


def _clean_project_name_candidate(candidate):
    text = clean_cell_text(candidate)
    text = re.sub(r"^[\s:：|\-_=]+", "", text)
    text = re.sub(r"[\s|/_-]*(시추주상도|BORING\s*LOG|BORE\s*LOG)\s*$", "", text, flags=re.IGNORECASE)
    text = text.strip(" :：|-_")

    if not text or len(text) < 2 or len(text) > 100:
        return None
    if text.upper() == "N/A" or text.startswith("PDF 자동 감지 대기-"):
        return None
    if text in {"시추주상도", "지층주상도", "지반조사", "토질조사"}:
        return None
    if PROJECT_NAME_LABEL_RE.fullmatch(text):
        return None
    if re.search(r"(좌표|표고|지하수위|시추번호|심도|표준관입|GRS\s*80|EPSG|X\s*\(?N?\)?|Y\s*\(?E?\)?)", text, re.IGNORECASE):
        return None

    return text


# =============================================================================
# 1-1. 좌표계 메타데이터 추출 (CRS Detection)
# =============================================================================

def extract_crs_from_page(page_text=None, page=None):
    """도면 우측 상단의 좌표계 텍스트 정보를 최우선으로 분석하여 
    EPSG 코드 또는 PROJ 문자열을 반환합니다.
    """
    header = ""
    if page is not None:
        try:
            # 우측 상단 블록만 필터링 (가로 기준 우측 절반, 세로 기준 상단 1/3)
            rect = page.rect
            w_mid = rect.width / 2.0
            h_third = rect.height / 3.0
            blocks = page.get_text("blocks")
            tr_texts = []
            for b in blocks:
                x0, y0, x1, y1, text, _, _ = b
                if x0 > w_mid * 0.8 and y1 < h_third * 1.5:  # 약간의 여유 마진
                    tr_texts.append(text)
            header = " ".join(tr_texts)
        except Exception as e:
            logger.warning(f"블록 추출 실패, 일반 텍스트 모드로 폴백: {e}")
            header = page_text[:1000] if page_text else ""
    else:
        header = page_text[:1000] if page_text else ""

    if header:
        logger.info(f"   [CRS Debug] Extracted Header: {header[:200]}...")

    if not header:
        return None

    # 패턴 매칭
    # 타원체: GRS80, Bessel, WGS84
    ellipsoid = "GRS80" # 기본값
    if re.search(r'Bessel', header, re.IGNORECASE):
        ellipsoid = "BESSEL"
    elif re.search(r'WGS\s*84|경위도', header, re.IGNORECASE):
        return "WGS84"
    elif re.search(r'GRS\s*80', header, re.IGNORECASE):
        ellipsoid = "GRS80"
    else:
        # 타원체 명시가 없을 경우 기본적으로 None 반환 (정밀 파싱 원칙)
        # 하지만 수원시 데이터 특성상 좌표계라는 단어가 있으면 GRS80 계열로 간주
        if not re.search(r'좌표계|투영|원점', header):
            return None

    # 원점: 중부, 동부, 서부
    origin = "중부"
    if "서부" in header or "동해" in header:
        return None
    if "동부" in header: origin = "동부"

    # 가산북치: 50만, 60만
    has_500k = re.search(r'50만|500,000|500000', header)
    has_600k = re.search(r'60만|600,000|600000', header)

    # 파라미터 조합에 따른 표준 EPSG 반환
    if ellipsoid == "GRS80":
        if origin == "동부":
            if has_500k: return "EPSG:5183"
            if has_600k: return "EPSG:5187"
            return None  # 가산값 불명 -> 후행 판정
        # 중부 기본
        if has_500k: return "EPSG:5181"
        if has_600k: return "EPSG:5186"
        return None  # 가산값 불명 -> 후행 판정
        
    if ellipsoid == "BESSEL":
        if origin == "동부": return "EPSG:5176"
        return "EPSG:5174" # 중부 기본

    return None



# =============================================================================
# 2. 좌표 파싱 (Index-Based Mapping)
# =============================================================================

def parse_coordinates(coord_text):
    """Table1[1,5] 좌표 문자열에서 X(N), Y(E) 값 추출
    
    입력 예: "X(N): 197344.925 Y(E): 522283.946"
    또는:    "X(N): 197344.925\nY(E): 522283.946"
    """
    lon = None  # X(N) → 경도
    lat = None  # Y(E) → 위도
    
    if not coord_text:
        return lon, lat
    
    text = clean_cell_text(coord_text)
    
    # X(N) 패턴
    x_match = re.search(r'X\s*[\(\[]?\s*N?\s*[\)\]]?\s*[:：]?\s*([\-+\d,.]+)', text, re.IGNORECASE)
    if x_match:
        lon = clean_float(x_match.group(1))
    
    # Y(E) 패턴
    y_match = re.search(r'Y\s*[\(\[]?\s*E?\s*[\)\]]?\s*[:：]?\s*([\-+\d,.]+)', text, re.IGNORECASE)
    if y_match:
        lat = clean_float(y_match.group(1))
    
    # 패턴 매칭 실패 시 숫자 2개 직접 추출 시도
    if lon is None or lat is None:
        nums = re.findall(r'([\-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[\-+]?\d{5,7}(?:\.\d+)?)', text)
        if len(nums) >= 2:
            vals = sorted([float(n.replace(",", "")) for n in nums], reverse=True)
            if lon is None:
                lon = vals[0]
            if lat is None:
                lat = vals[1] if len(vals) > 1 else None
    
    # [DISABLED] 추출기 단계의 개별 검증은 Axis Swap 로직을 방해하므로 비활성화
    # if lon is not None and lat is not None:
    #     if not validate_suwon_coordinates(lon, lat):
    #         logger.warning(f"  ⚠️ [Validation Warning] 좌표 범위 이탈: X={lon}, Y={lat}")

    return lon, lat


# =============================================================================
# 3. 단일 PDF 인덱스 기반 추출 함수 (Core Extraction)
# =============================================================================

def process_single_pdf_indexed(pdf_path, project_name=None):
    """
    단일 PDF 파일에서 인덱스 기반으로 시추 데이터를 추출합니다.
    
    Returns:
        List[Dict]: [{"프로젝트명", "경도", "위도", "표고", "시추공명", "상심도", "하심도", "지층명"}, ...]
    """
    filename = os.path.basename(pdf_path)
    if not project_name:
        project_name = os.path.splitext(filename)[0]
    
    doc = None
    try:
        doc = fitz.open(pdf_path)
        
        # 시추공별 데이터 수집: {bh_id: {"meta": {...}, "strata": [...]}}
        boreholes = {}
        current_bh_id = None
        
        for page_idx in range(len(doc)):
            page = doc[page_idx]
            tables = page.find_tables()
            
            if len(tables.tables) < 2:
                logger.warning(f"  [{filename}] Page {page_idx+1}: 표 {len(tables.tables)}개 감지 (최소 2개 필요)")
                continue
            
            table1_data = tables.tables[0].extract()
            table2_data = tables.tables[1].extract()
            
            # ── Table 1: 메타데이터 추출 ──
            if len(table1_data) >= 2 and len(table1_data[0]) >= 8:
                bh_id_raw = table1_data[0][7]
                bh_id = normalize_bh_id(bh_id_raw)
                
                if not bh_id:
                    # 조사명/비표준 명칭인 경우 페이지 번호 기반 임시 ID 부여
                    bh_id = f"시추-{page_idx + 1}"

                current_bh_id = bh_id

                if bh_id not in boreholes:
                    # 좌표 파싱
                    coord_text = table1_data[1][5] if len(table1_data[1]) > 5 else ""
                    lon, lat = parse_coordinates(coord_text)

                    # 표고
                    elev_raw = table1_data[1][7] if len(table1_data[1]) > 7 else None
                    elev = clean_float(elev_raw)

                    boreholes[bh_id] = {
                        "meta": {
                            "경도": lon if lon is not None else "N/A",
                            "위도": lat if lat is not None else "N/A",
                            "표고": elev if elev is not None else "N/A",
                        },
                        "strata": []
                    }
            
            if not current_bh_id:
                continue
            
            # ── Table 2: 지층 데이터 추출 (Row 2부터) ──
            for row_idx in range(2, len(table2_data)):
                row = table2_data[row_idx]
                if len(row) < 5:
                    continue
                
                depth_values = extract_depth_values(row[0])   # Col 0: 하심도
                if not depth_values:
                    continue  # 빈 행(SPT 반복행) 스킵
                depth = depth_values[-1]
                
                strata_raw = row[4] if row[4] else ""  # Col 4: 지층명
                strata = normalize_strata(strata_raw)
                
                # 중복 심도 방지 (동일 시추공 내)
                existing_depths = [s['depth'] for s in boreholes[current_bh_id]['strata']]
                if depth not in existing_depths:
                    boreholes[current_bh_id]['strata'].append({
                        'depth': depth,
                        'strata': strata,
                    })
        
        # ── 최종 포맷팅: 상심도/하심도 계산 ──
        formatted = []
        for bh_id, bh_data in boreholes.items():
            meta = bh_data['meta']
            strata_list = sorted(bh_data['strata'], key=lambda x: x['depth'])
            
            prev_depth = 0.0
            for item in strata_list:
                formatted.append({
                    "프로젝트명": project_name,
                    "시추공명": bh_id,
                    "경도": meta["경도"],
                    "위도": meta["위도"],
                    "표고": meta["표고"],
                    "상심도": prev_depth,
                    "하심도": item['depth'],
                    "지층명": item['strata'],
                })
                prev_depth = item['depth']
        
        if formatted:
            logger.info(f"  ✅ [{filename}] {len(boreholes)}개 시추공, {len(formatted)}개 레코드 추출 완료")
        else:
            logger.warning(f"  ⚠️ [{filename}] 추출된 데이터 없음")
        
        return formatted
    
    except Exception as e:
        logger.error(f"  ❌ [{filename}] 처리 오류: {e}")
        return []
    finally:
        if doc:
            doc.close()
