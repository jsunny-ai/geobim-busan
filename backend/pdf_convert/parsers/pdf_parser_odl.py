import os
import re
import logging
import gc
import unicodedata

def natural_sort_key(s):
    """문자열 내의 숫자를 수치로 인식하여 정렬하기 위한 키를 생성합니다. (Hashable한 튜플 반환)"""
    return tuple(int(text) if text.isdigit() else text.lower() for text in re.split('([0-9]+)', str(s)))

def normalize_strata_name(text: str) -> str:
    """추출된 지반명 텍스트에서 색상 정보 등을 제거하여 정규화합니다.

    처리 순서:
      1) 색상·접미사 제거
      2) 정확한 키워드 매칭 (기존 동작 유지)
      3) 미지 지층명 자동 분류 휴리스틱
         - "풍화" + "암" → 풍화암
         - "토" 포함 / 모래·자갈·실트·점토 계열 → 토사
         - "암" 포함 + 강도 힌트 → 경암 / 연암 / 보통암
    """
    if not text: return "토사"
    text = unicodedata.normalize('NFKC', text)
    text = re.sub(r'\(.*?\)', '', text)
    colors = ['암갈색', '회갈색', '황갈색', '회색', '청회색', '담회색', '적갈색', '갈색', '흑색', '백색']
    for color in colors: text = text.replace(color, '')
    suffixes = ['층색', '표']
    for s in suffixes: text = text.replace(s, '')
    compact_text = re.sub(r'\s+', '', text)
    compact_upper = compact_text.upper()

    # ── 1순위: 정확한 키워드 매칭 ──────────────────────────────────────────
    # 토사 세분류는 해치 표현의 원천이므로 "토사"로 접지 않고 보존한다.
    keywords = [
        '유기질토', '점토질모래', '사질점토',
        '매립토', '매립층', '퇴적토', '퇴적층', '충적토', '충적층',
        '풍화토', '잔류토', '점성토', '점토', '실트', '사질토', '모래', '역질토', '자갈',
        '풍화암', '보통암', '발파암', '리핑암', '화강암', '연암', '경암', '토사',
    ]
    for kw in keywords:
        if kw in compact_text: return kw

    uscs_map = {
        'CL': '점토', 'CH': '점토',
        'ML': '실트', 'MH': '실트',
        'SW': '모래', 'SP': '모래', 'SM': '모래', 'SC': '모래',
        'GW': '자갈', 'GP': '자갈', 'GM': '자갈', 'GC': '자갈',
        'OL': '유기질토', 'OH': '유기질토', 'PT': '유기질토',
    }
    for code, detail in uscs_map.items():
        if re.search(rf'(^|[^A-Z]){code}([^A-Z]|$)', compact_upper):
            return detail

    # ── 2순위: 미지 지층명 자동 분류 휴리스틱 ─────────────────────────────
    text = re.sub(r'[a-zA-Z]', '', compact_text)
    text = re.sub(r'[^\w\s]', '', text).strip()
    if not text:
        return '토사'

    # 풍화암 계열: "풍화" + "암" 동시 포함 (풍화암질, 부분풍화암 등)
    if '풍화' in text and '암' in text:
        return '풍화암'

    # 토사 계열: "토" 포함(전답토, 점성토, 사질토 …)
    #           또는 모래·자갈·실트·점토 관련 단어 포함
    _SOIL_DETAIL_WORDS = [
        ('점토', '점토'),
        ('점성', '점토'),
        ('실트', '실트'),
        ('모래', '모래'),
        ('사질', '사질토'),
        ('자갈', '자갈'),
        ('역질', '자갈'),
        ('퇴적', '퇴적토'),
        ('충적', '충적토'),
        ('붕적', '붕적토'),
        ('유기', '유기질토'),
        ('이탄', '유기질토'),
        ('부식', '유기질토'),
    ]
    for word, detail in _SOIL_DETAIL_WORDS:
        if word in text:
            return detail
    if '토' in text:
        return '토사'

    # 암 계열: "암" 포함 → 강도 힌트로 세분
    if '암' in text:
        if any(w in text for w in ['경', '단단', '견고']):
            return '경암'
        if any(w in text for w in ['연', '약', '무른']):
            return '연암'
        return '보통암'

    # 최종 fallback
    return '토사'

def classify_strata_from_text(text: str, image_code: str):
    """지층 분류 엔진"""
    text = unicodedata.normalize('NFKC', text)
    text_content = text.upper().replace(" ", "")
    if "풍화암" in text_content: return "풍화암"
    priority_keywords = ["매립", "퇴적", "풍화토", "연암", "리핑암", "보통암", "경암", "발파암", "화강암"]
    for kw in priority_keywords:
        if kw in text_content: return normalize_strata_name(text)
    return normalize_strata_name(text)

def clean_float(val_str):
    """숫자 추출 시 숫자, 소수점, 마이너스 외의 문자를 완벽히 제거하고 float로 변환"""
    if val_str is None: return None
    s = str(val_str).strip()
    if '~' in s: s = s.split('~')[-1]
    
    # 1. 숫자, 소수점, 마이너스 부호만 남기기 (정규식 강화)
    cleaned = re.sub(r'[^\d\.\-]', '', s)
    
    # 2. 다중 소수점 처리 (예: 123.45.67 -> 123.4567)
    if cleaned.count('.') > 1:
        parts = cleaned.split('.')
        cleaned = parts[0] + '.' + "".join(parts[1:])
        
    if not cleaned or cleaned == '.' or cleaned == '-': return None

    try:
        return float(cleaned)
    except ValueError:
        return None

def extract_last_depth(val_str):
    """심도 셀에서 공백/줄바꿈/<br>로 분리된 복수 숫자를 '토큰 단위로 분리'해
    마지막(=하심도) 값만 반환한다.

    [버그 배경] PyMuPDF/표 추출이 상·하 심도를 한 셀로 합치는 경우가 있다
    ('25\\n40', '25 40', '25<br>40'). 이를 clean_float()에 그대로 넣으면
    `re.sub(r'[^\\d.\\-]','')`가 공백·줄바꿈을 제거하며 '2540'으로 붙여버린다
    (상심도 25가 하심도 40 앞에 중복 부착 → 하심도 2540). 그 결과 DB에
    depth_bottom=2540 같은 이상값이 저장됐다.
    토큰을 먼저 분리하면 [25, 40]이 되어 마지막 40을 안전하게 하심도로 취한다.
    소수점(25.40)은 한 토큰으로 보존되므로 정상값은 영향받지 않는다.
    범위 표기('0.0 ~ 25.0')도 마지막 토큰 25.0을 취해 기존 동작과 일치한다.
    """
    if val_str is None:
        return None
    text = unicodedata.normalize("NFKC", str(val_str)).replace("O", "0").replace("o", "0")
    last = None
    for m in re.finditer(r"[-+]?\d+(?:[.,]\d+)?", text):
        v = clean_float(m.group(0).replace(",", "."))
        if v is not None:
            last = v
    return last

def validate_suwon_coordinates(x, y):
    """
    수원시 로컬 좌표계 범위(TM) 검증:
    X(N) : 200,000 내외 (오차범위 고려 170,000 ~ 230,000)
    Y(E) : 500,000 내외 (오차범위 고려 470,000 ~ 550,000)
    """
    if x is None or y is None: return False
    
    # X와 Y가 바뀌어 들어오는 경우도 대비하여 유연하게 체크하거나, 
    # 엄격하게 수원 범위를 벗어나면 경고하도록 설정
    x_valid = (170000 <= x <= 230000)
    y_valid = (470000 <= y <= 550000)
    
    if x_valid and y_valid:
        return True
    return False

def find_value_in_cells(cells, keywords):
    """표의 셀 리스트 내에서 키워드 발견 시 해당 키워드 이후의 텍스트에서 수치 추출 (인라인 보강)"""
    combined_text = " ".join(cells).replace("<br>", " ")
    for kw in keywords:
        # 키워드 이후 콜론(:) 및 공백, 단위 등을 유연하게 매칭하여 수치 추출
        pattern = re.escape(kw) + r'[\s\r\n\|(\)m]*[:\s\|]*([-0-9\s.,\u3000]{1,})'
        m = re.search(pattern, combined_text, re.IGNORECASE | re.DOTALL)
        if m:
            val = clean_float(m.group(1))
            if val is not None: return val
    return None

def find_id_by_spatial_proximity(page, pdf_bh_ids, y_limit=150):
    """PDF 페이지 상단에서 시추공 ID 탐지 및 교차 검증 (Stage 44)"""
    try:
        blocks = page.get_text("blocks")
        for b in blocks:
            if b[1] > y_limit: continue
            b_text = b[4].strip()
            b_clean = re.sub(r'[^A-Za-z0-9]', '', b_text).upper()
            for pid in pdf_bh_ids:
                pid_clean = re.sub(r'[^A-Za-z0-9]', '', pid).upper()
                if pid.upper() in b_text.upper() or pid_clean == b_clean:
                    # ID 정규화: 중복 하이픈 제거 (BH---3 -> BH-3)
                    matched_id = pid
                    matched_id = re.sub(r'-+', '-', matched_id)
                    return matched_id

        anchors = ["시추번호", "공번", "시추공명", "NO.", "NO"]
        for kw in anchors:
            for b in blocks:
                if b[1] > y_limit: continue
                if kw in b[4].replace(" ", ""):
                    pattern = re.escape(kw) + r'[:\s]*([A-Za-z0-9\s-]{2,15})'
                    im = re.search(pattern, b[4], re.I)
                    if im:
                        val = im.group(1).upper()
                        val_clean = re.sub(r'[^A-Za-z0-9]', '', val)
                        for pid in pdf_bh_ids:
                            pid_clean = re.sub(r'[^A-Za-z0-9]', '', pid).upper()
                            if val_clean == pid_clean: return pid
                    
                    ax0, ay0, ax1, ay1 = b[:4]
                    for candidate in blocks:
                        if candidate == b: continue
                        cx0, cy0, cx1, cy1 = candidate[:4]
                        is_right = (cx0 >= ax1 - 10) and (cx0 <= ax1 + 250) and (abs(cy0 - ay0) < 30)
                        is_below = (cy0 >= ay1 - 5) and (cy0 <= ay1 + 60) and (abs(cx0 - ax0) < 100)
                        if is_right or is_below:
                            c_text = re.sub(r'[^A-Za-z0-9]', '', candidate[4]).upper()
                            if 2 <= len(c_text) <= 15:
                                for pid in pdf_bh_ids:
                                    pid_clean = re.sub(r'[^A-Za-z0-9]', '', pid).upper()
                                    if c_text == pid_clean: return pid
    except Exception: pass
    return None

def find_value_by_spatial_proximity(page, keywords, y_limit=350):
    """PDF 페이지 내 키워드 영역 기반 수치 추출 (ROI 유연화 및 상단 집중)"""
    try:
        blocks = page.get_text("dict")["blocks"]
        all_spans = []
        for b in blocks:
            if "lines" in b:
                for l in b["lines"]:
                    for s in l["spans"]:
                        text_norm = unicodedata.normalize('NFKC', s["text"]).replace(" ", "").upper()
                        s["text_clean"] = text_norm
                        all_spans.append(s)
        
        for kw in keywords:
            kw_clean = kw.replace(" ", "").upper()
            anchor = None
            for s in all_spans:
                if s["bbox"][1] > y_limit: continue
                if kw_clean in s["text_clean"]:
                    anchor = s
                    # 인라인 수치 탐색
                    pattern = re.escape(kw_clean) + r'[:\s\(]*([-0-9.,\u3000]{2,})'
                    im = re.search(pattern, s["text_clean"])
                    if im:
                        val = clean_float(im.group(1))
                        if val is not None: return val
                    break
            
            if not anchor: continue
            ax0, ay0, ax1, ay1 = anchor["bbox"]
            acx, acy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
            
            candidates = []
            # 우측/하단 인접 텍스트에서 수치 검색
            for s in all_spans:
                if s == anchor: continue
                sx0, sy0, sx1, sy1 = s["bbox"]
                scx, scy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
                
                is_right = (sx0 >= ax1 - 5) and (sx0 <= ax1 + 450) and (abs(sy0 - ay0) < 15)
                is_below = (sy0 >= ay1 - 5) and (sy0 <= ay1 + 40) and (abs(sx0 - ax0) < 100)
                
                if is_right or is_below:
                    is_coord_kw = any(x in kw_clean for x in ["X(N)", "Y(E)", "浵", "ð", "위도", "경도", "X:", "Y:"])
                    min_len = 5 if is_coord_kw else 1
                    pattern = r'([-0-9.,\u3000]{' + str(min_len) + r',})'
                    m = re.search(pattern, s["text"])
                    if m:
                        val = clean_float(m.group(1))
                        if val is not None:
                            if is_coord_kw:
                                if not (10000 <= val <= 1000000): continue 
                            else: # 표고
                                if not (-100 <= val <= 5000): continue
                            
                            dist = ((acx - scx)**2 + (acy - scy)**2)**0.5
                            candidates.append((dist, val))
            
            if candidates:
                candidates.sort()
                return candidates[0][1]
        
        # [Stage 44-B] 2차 시도: 키워드 없이 직접 패턴 탐색 (X(N), Y(E) 등)
        for kw_direct in ["X(N)", "Y(E)", "X:", "Y:", "N:", "E:", "X", "Y"]:
            target_kw = kw_direct.upper()
            anchor = None
            for s in all_spans:
                if s["bbox"][1] > y_limit: continue
                if target_kw in s["text_clean"]:
                    # 인라인 수치 검색
                    im = re.search(r'[:\s\(]*([-0-9.,\u3000]{5,})', s["text"])
                    if im: return clean_float(im.group(1))
                    anchor = s
                    break
            
            if anchor: # 인접 주변 검색 (Stage 44-B)
                ax0, ay0, ax1, ay1 = anchor["bbox"]
                acx, acy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
                candidates = []
                is_coord_anchor = any(x in target_kw for x in ["X(N)", "Y(E)", "X:", "Y:", "N:", "E:", "X", "Y"])
                for s in all_spans:
                    if s == anchor: continue
                    sx0, sy0, sx1, sy1 = s["bbox"]
                    scx, scy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
                    is_near = (abs(sy0 - ay0) < 15) and (sx0 >= ax0 - 150) and (sx0 <= ax1 + 450)
                    if is_near:
                        m_len = 5 if is_coord_anchor else 1
                        m = re.search(r'([-0-9.,\u3000]{' + str(m_len) + r',})', s["text"])
                        if m:
                            val = clean_float(m.group(1))
                            if val is not None:
                                if is_coord_anchor:
                                    if not (100000 <= val <= 1000000): continue
                                else:
                                    if not (-100 <= val <= 5000): continue
                                dist = ((acx - scx)**2 + (acy - scy)**2)**0.5
                                candidates.append((dist, val))
                if candidates:
                    candidates.sort()
                    return candidates[0][1]
    except Exception: pass
    return None

def find_metadata_spatial(page):
    """페이지 내 메타데이터(표고, 좌표)를 공간적으로 추출 및 수원 범위 검증"""
    el = find_value_by_spatial_proximity(page, ["표고", "E.L", "EL", "ǥ", "\u00A7", "EL."])
    lon = find_value_by_spatial_proximity(page, ["경도", "X(N)", "LON", "E(X)", "浵", "X:"])
    lat = find_value_by_spatial_proximity(page, ["위도", "Y(E)", "LAT", "ð", "N(Y)", "Y:"])
    
    # [NEW] 수원시 로컬 좌표계 1차 수치 검증 적용
    if lon is not None and lat is not None:
        if not validate_suwon_coordinates(lon, lat):
            logging.warning(f"  ⚠️ [Validation Warning] 좌표 범위 이탈 감지: X={lon}, Y={lat} (수원 범위 외)")
            # 범위를 심각하게 벗어나면 N/A 처리하여 폴백 유도 가능 (선택 사항)
            # lon, lat = "N/A", "N/A" 

    return {"el": el, "lat": lat, "lon": lon}

def extract_from_pdf_fallback(pdf_path, page_num, keywords):
    """
    마크다운에서 값을 찾지 못한 경우, PDF 원본의 특정 페이지 상단(헤더 영역)에서 텍스트를 직접 추출하여 폴백합니다.
    """
    try:
        import fitz
        doc = fitz.open(pdf_path)
        if page_num >= len(doc): 
            doc.close()
            return None
        
        page = doc[page_num]
        # ROI: 상단 200픽셀 구역 (헤더 영역)
        roi = fitz.Rect(0, 0, page.rect.width, 200)
        text = page.get_text("text", clip=roi)
        doc.close()
        
        if not text: return None
        
        # 유니코드 정규화 및 공백 제거
        text_norm = unicodedata.normalize('NFKC', text).replace(" ", "")
        
        for kw in keywords:
            kw_norm = kw.replace(" ", "")
            # 키워드 이후 콜론(:) 및 수치 매칭
            pattern = re.escape(kw_norm) + r'[:\s\|(\)m]*([-0-9.,\u3000]{2,})'
            m = re.search(pattern, text_norm, re.IGNORECASE)
            if m:
                val = clean_float(m.group(1))
                if val is not None: return val
    except Exception: pass
    return None

def extract_all_from_md(md_path: str, project_name: str = "", pdf_path: str = None):
    """2-Pass MD 파싱 및 PDF 폴백 통합 추출 함수 (Stage 45)"""
    pdf_bh_ids = []
    results = []
    bh_metadata = {}
    current_bh_id = None
    last_processed_depth = -1.0 
    el_kws = ["표고", "EL", "G.L", "E.L", "F.L", "G.L.", "E.L.", "PROJECTELEV"]

    error_dir = os.path.dirname(md_path) or os.getcwd()
    ERROR_LOG_PATH = os.path.join(error_dir, "error_log.txt")
    def _log_error(msg):
        with open(ERROR_LOG_PATH, "a", encoding="utf-8") as ef:
            ef.write(f"[{project_name or 'UNKNOWN'}] {msg}\n")

    # [1] PDF 기반 시추공 ID 추출
    if pdf_path and os.path.exists(pdf_path):
        doc = None
        try:
            import fitz
            doc = fitz.open(pdf_path)
            full_text = ""
            for page in doc: full_text += page.get_text() + "\n"
            full_text = unicodedata.normalize('NFKC', full_text)
            # PB, TP, NX 등 다양한 시추기호 매칭 강화
            bh_pattern = r'((?:NH|BH|TP|NX|SB|DB|TB|DH|OW|MW|IW|BX|JB|TH|KP|CB|PB|EB|KB)[-\s]*\d+[A-Z]?)'
            found_ids = re.findall(bh_pattern, full_text)
            for bid in found_ids:
                # 하이픈 중복 정규화 (BH---3 -> BH-3)
                bid_clean = re.sub(r'[-\s]+', '-', bid.upper())
                if bid_clean not in pdf_bh_ids: pdf_bh_ids.append(bid_clean)
            print(f"DEBUG: Found PDF BH IDs: {pdf_bh_ids}")
        except Exception: pass
        finally:
            if doc: doc.close()

    if not os.path.exists(md_path): return []

    try:
        with open(md_path, 'r', encoding='utf-8') as f: raw_lines = f.readlines()
        lines = [unicodedata.normalize('NFKC', l).strip() for l in raw_lines]
        md_content_full = "\n".join(lines)

        # [2-1] MD 1-Pass: 시추공 및 메타데이터 맵 구축 (Stage 44 Targeting)
        # MD 텍스트 분석 대신 PDF 기반 공간 정보를 사용하여 각 페이지의 정확한 ID 확정
        page_metadata = {} # {page_idx: {id: ..., lat: ..., lon: ..., el: ...}}
        if pdf_path and os.path.exists(pdf_path):
            doc = None
            try:
                doc = fitz.open(pdf_path)
                for p_idx, page in enumerate(doc):
                    p_id = find_id_by_spatial_proximity(page, pdf_bh_ids, 160)
                    print(f"DEBUG: Page {p_idx} ID Search result: {p_id}")
                    if p_id:
                            # [Stage 44-B] 폰트 깨짐 대응 및 X(N), Y(E) 타겟팅 고도화
                            meta_spatial = find_metadata_spatial(page)
                            meta = {
                                "id": p_id, 
                                "위도": meta_spatial["lat"] if meta_spatial["lat"] is not None else "N/A",
                                "경도": meta_spatial["lon"] if meta_spatial["lon"] is not None else "N/A",
                                "표고": meta_spatial["el"] if meta_spatial["el"] is not None else "N/A"
                            }
                            page_metadata[p_idx] = meta
                            if p_id not in bh_metadata:
                                bh_metadata[p_id] = {"위도": meta["위도"], "경도": meta["경도"], "표고": meta["표고"]}
            except Exception: pass
            finally:
                if doc: doc.close()

        # [2-2] MD 2-Pass: 기둥 주상도 데이터(Strata) 추출
        section_idx = 0
        current_page_idx = -1
        current_bh_id = None
        if pdf_bh_ids:
            current_bh_id = pdf_bh_ids[0]
        else:
            # 표준 접두어 없는 PDF: 첫 번째 임시 ID 부여
            pdf_bh_ids = ["시추-1"]
            current_bh_id = "시추-1"
        
        for i in range(len(lines)):
            line = lines[i]
            if not line: continue
            
            # [수정] 페이지 전환 감지(L363-371) 대신 심도 리셋 및 ID 목록 기반 순차 전환으로 통합
            if "|심 도 (-m)|표 고 (m)|" in line.replace(" ", ""):
                # 헤더 라인은 데이터 파싱 제외하되, 페이지 번호만 추적 (로깅용)
                current_page_idx += 1
                continue 
            
            # 수동 ID 전환 (MD 텍스트 보조)
            id_match = re.search(r'(?:시추번호|시추공번|시추공명|No\.?)[^A-Za-z0-9가-힣/]*([A-Za-z0-9-]{2,15})', line, re.I)
            if id_match:
                val = id_match.group(1).upper()
                for pid in pdf_bh_ids:
                    if val in pid.replace("-","").upper() or pid.upper() in val:
                        if current_bh_id != pid:
                            current_bh_id = pid
                            section_idx += 1
                            last_processed_depth = -1.0
                            if current_bh_id not in bh_metadata:
                                bh_metadata[current_bh_id] = {"경도": "N/A", "위도": "N/A", "표고": "N/A"}
                        break

            row_match = re.match(r'^\|\s*([^\|]+)\|\s*([^\|]+)\|\s*([^\|]+)\|', line)
            if row_match:
                try:
                    # [심도 concat 버그 수정] 상·하 심도가 한 셀로 합쳐진 경우
                    # ('25 40'→clean_float→2540)를 막기 위해 토큰 분리 후 마지막값(하심도) 사용
                    temp_depth = extract_last_depth(row_match.group(1).strip())
                    if temp_depth is None: continue
                    
                    # 수치 기반 자동 시추공 전환 (심도 리셋 감지)
                    # 현재 심도가 이전 심도보다 현저히 낮아지면(예: 30m -> 0m) 새로운 시추공으로 간주
                    is_reset = current_bh_id and len(results) > 0 and temp_depth < results[-1]['심도'] - 2.0
                    
                    if (not current_bh_id or is_reset) and pdf_bh_ids:
                        if not current_bh_id:
                            current_bh_id = pdf_bh_ids[0]
                        elif is_reset:
                            try:
                                curr_idx = pdf_bh_ids.index(current_bh_id)
                                if curr_idx + 1 < len(pdf_bh_ids):
                                    current_bh_id = pdf_bh_ids[curr_idx + 1]
                                else:
                                    # 임시 ID 목록 소진 시 동적 확장
                                    new_id = f"시추-{curr_idx + 2}"
                                    pdf_bh_ids.append(new_id)
                                    current_bh_id = new_id
                                section_idx += 1
                                last_processed_depth = -1.0
                                # ID 전환 시 주변 텍스트에서 메타데이터 보강 시도
                                ctx_start = max(0, i - 20)
                                ctx_text = "\n".join(lines[ctx_start:i+1])
                                if current_bh_id not in bh_metadata:
                                    bh_metadata[current_bh_id] = {"경도": "N/A", "위도": "N/A", "표고": "N/A"}
                                for kw, key in [("X(N)", "위도"), ("Y(E)", "경도"), ("표고", "표고"), ("EL", "표고")]:
                                    if bh_metadata[current_bh_id][key] == "N/A":
                                        val = find_value_in_cells([ctx_text], [kw])
                                        if val is not None: bh_metadata[current_bh_id][key] = val
                            except ValueError: pass
                        
                        if current_bh_id not in bh_metadata:
                            bh_metadata[current_bh_id] = {"경도": "N/A", "위도": "N/A", "표고": "N/A"}

                    if current_bh_id and temp_depth > last_processed_depth:
                        rest = line.split('|', 4)
                        if len(rest) >= 5:
                            cells = [c.strip() for c in rest[4].split('|')]
                            if len(cells) >= 2:
                                last_processed_depth = temp_depth
                                img_code = ""
                                im = re.search(r'/([^/\s]+)\.png', cells[0], re.I)
                                if im: img_code = im.group(1).upper()
                                soil = classify_strata_from_text(cells[1].replace("<br>", " "), img_code)
                                results.append({
                                    "시추공명": current_bh_id, 
                                    "심도": temp_depth, 
                                    "지층명": soil,
                                    "section_idx": section_idx
                                })
                except Exception: pass
    except Exception as e: _log_error(f"MD 파싱 오류: {e}")

    # [3] PDF 직접 읽기 폴백 (N/A 값 정밀 복구)
    if pdf_path and os.path.exists(pdf_path):
        doc = None
        try:
            import fitz
            doc = fitz.open(pdf_path)
            pages_txt = [unicodedata.normalize('NFKC', p.get_text()) for p in doc]
            bh_to_page = {}
            for b_id in bh_metadata.keys():
                for p_idx, p_txt in enumerate(pages_txt):
                    # PDF 내 검색 시 ID 정규화 적용
                    b_id_norm = b_id.replace("-", "")
                    p_txt_norm = p_txt.replace("-", "").replace(" ", "")
                    if b_id_norm in p_txt_norm:
                        bh_to_page[b_id] = p_idx
                        break
            
            for b_id, meta in bh_metadata.items():
                if any(v == "N/A" for v in meta.values()):
                    p_idx = bh_to_page.get(b_id)
                    if p_idx is not None:
                        page_obj = doc[p_idx]
                        search_ctx = pages_txt[p_idx]
                        
                        # 좌표 쌍 탐색
                        def _extract_pair(y_max):
                            spans = [s for b in page_obj.get_text("dict")["blocks"] if "lines" in b 
                                    for l in b["lines"] for s in l["spans"] if s["bbox"][1] < y_max]
                            nums = []
                            for s in spans:
                                for m in re.finditer(r'(\d{5,7}\.\d{2,4})', s["text"]):
                                    val = clean_float(m.group(1))
                                    if val and val > 1000: nums.append(val)
                            if len(nums) >= 2:
                                s_nums = sorted(list(set(nums)), reverse=True)
                                if len(s_nums) >= 2: return s_nums[0], s_nums[1]
                            return None, None

                        if meta["위도"] == "N/A":
                            lat, lon = _extract_pair(350)
                            if lat is None: lat, lon = _extract_pair(850)
                            if lat is not None: meta["위도"], meta["경도"] = lat, lon
                        
                        # 표고 및 개별 항목 복구
                        if meta["표고"] == "N/A":
                            v = find_value_by_spatial_proximity(page_obj, el_kws, 350)
                            if v is None: v = find_value_by_spatial_proximity(page_obj, el_kws, 850)
                            if v is None: v = find_value_in_cells([search_ctx], el_kws)
                            if v is None: v = extract_from_pdf_fallback(pdf_path, p_idx, el_kws)
                            if v is not None: meta["표고"] = v
                        
                        if meta["위도"] == "N/A":
                            v = find_value_by_spatial_proximity(page_obj, ["X(N)", "위도"], 850)
                            if v is None: v = extract_from_pdf_fallback(pdf_path, p_idx, ["X(N)", "위도"])
                            if v is not None: meta["위도"] = v
                            
                        if meta["경도"] == "N/A":
                            v = find_value_by_spatial_proximity(page_obj, ["Y(E)", "경도"], 850)
                            if v is None: v = extract_from_pdf_fallback(pdf_path, p_idx, ["Y(E)", "경도"])
                            if v is not None: meta["경도"] = v
        except Exception: pass
        finally:
            if doc: doc.close()

    # [4] 최종 포맷팅 (Section 기반 독립성 보장)
    formatted = []
    # (시추공명, section_idx) 튜플을 키로 사용하여 완벽히 분리
    bh_groups = {}
    for r in results:
        key = (r['시추공명'], r['section_idx'])
        if key not in bh_groups: bh_groups[key] = []
        bh_groups[key].append(r)
    
    for (bh_id, s_idx), group in bh_groups.items():
        unique_group = []
        # 같은 섹션 내에서만 중복 제거 수행
        for item in sorted(group, key=lambda x: x['심도']):
            if not unique_group or unique_group[-1]['심도'] != item['심도']: 
                unique_group.append(item)
        
        prev_d = 0.0
        for item in unique_group:
            formatted.append({
                "프로젝트명": project_name, 
                "시추공명": bh_id, 
                "상심도": prev_d, 
                "하심도": item['심도'], 
                "지층명": item['지층명'],
                "경도": bh_metadata.get(bh_id, {}).get('경도', 'N/A'),
                "위도": bh_metadata.get(bh_id, {}).get('위도', 'N/A'),
                "표고": bh_metadata.get(bh_id, {}).get('표고', 'N/A')
            })
            prev_d = item['심도']
    
    gc.collect()
    return [{"page": 1, "data": formatted}]

def extract_from_pdf_text_odl(pdf_path: str, project_name: str = ""):
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    data_dir = os.environ.get(
        "PDF_CONVERT_DATA_DIR",
        os.path.join(os.getcwd(), "pdf_convert", "data"),
    )
    md_path = os.path.join(data_dir, "02_markdown", f"{base_name}.md")
    return extract_all_from_md(md_path, project_name=project_name, pdf_path=pdf_path)
