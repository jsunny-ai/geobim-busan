import logging
import json

logging.basicConfig(level=logging.INFO)

# === Stage 47: 지층명 정규화 ===
# 토사 세분류는 3D 뷰어 해치 표현의 원천이므로 "토사"로 강제 치환하지 않는다.
# 암반 계열의 도면/시공 용어만 기존 대분류 표시명으로 정리한다.
STRATA_GROUP_MAP = {
    # 토사 그룹
    "매립층": "매립토",
    "매립토": "매립토",
    "퇴적층": "퇴적토",
    "퇴적토": "퇴적토",
    "충적층": "충적토",
    "충적토": "충적토",
    "풍화토": "풍화토",
    "잔류토": "풍화토",
    "점성토": "점토",
    "점토":   "점토",
    "실트":   "실트",
    "사질토": "모래",
    "모래":   "모래",
    "역질토": "자갈",
    "자갈":   "자갈",
    "유기질토": "유기질토",
    "이탄":   "유기질토",
    "부식토": "유기질토",
    "붕적토": "붕적토",
    "토사":   "토사",
    # 풍화암 그룹
    "풍화암": "풍화암",
    # 연암 그룹
    "연암":   "연암",
    "리핑암": "연암",
    # 경암 그룹
    "경암":   "경암",
    # 보통암 그룹
    "보통암": "보통암",
    # 경암 그룹
    "발파암": "경암",
    "화강암": "경암",
}

def apply_strata_group_mapping(rows: list) -> list:
    """지층 표시명을 정리한다. 토사 세분류는 대분류로 접지 않고 보존한다."""
    for row in rows:
        original = row.get("지층명", "토사")
        # 기본값을 original로 설정하여 매핑 테이블에 없는 경우 유실 방지
        row["지층명"] = STRATA_GROUP_MAP.get(original, original)
    return rows

def merge_multi_page_tables(pages_data) -> list:
    """
    여러 페이지에서 추출된 표 데이터를 논리적으로 이어 붙입니다.
    pages_data 구조: 
      1) List: [{ "page": 1, "data": [...] }] 
      2) Dict: { "BH-1": [rows...], "BH-2": [rows...] }
    """
    # 딕셔너리 형태인 경우 표준 리스트 형태로 변환
    if isinstance(pages_data, dict):
        standard_data = []
        for bh_id, rows in pages_data.items():
            standard_data.append({"data": rows})
        pages_data = standard_data

    logging.info("[병합] 다중 페이지/시추공 그룹 데이터 병합을 시작합니다...")
    merged_data = []
    global_metadata = {}
    
    for idx, page in enumerate(pages_data):
        page_num = page.get("page", idx + 1)
        rows = page.get("data", [])
        
        for row in rows:
            # 1. 시추공명이 명시된 경우 메타데이터 갱신 (새로운 시추공 또는 페이지 시작)
            if row.get("시추공명"):
                global_metadata = {
                    "시추공명": row.get("시추공명"),
                    "경도": row.get("경도", global_metadata.get("경도", "N/A")),
                    "위도": row.get("위도", global_metadata.get("위도", "N/A")),
                    "표고": row.get("표고", global_metadata.get("표고", "N/A")),
                    "지하수위": row.get("지하수위", global_metadata.get("지하수위", "N/A"))
                }
            
            # 2. 메타데이터 상속 매핑 (Cascade)
            if global_metadata:
                row.setdefault("시추공명", global_metadata["시추공명"])
                row.setdefault("경도", global_metadata["경도"])
                row.setdefault("위도", global_metadata["위도"])
                row.setdefault("표고", global_metadata["표고"])
                row.setdefault("지하수위", global_metadata["지하수위"])
            
            merged_data.append(row)
            
    # === 불완전 식별자 자동 넘버링 로직 (Anomaly Detection) ===
    import re
    missing_bh_counter = 1
    current_anomalous_id = None
    
    for i, row in enumerate(merged_data):
        raw_bh = str(row.get("시추공명", "")).replace(" ", "")
        # 비어있거나, 영문+하이픈(BH-, TB- 등)으로 끝나거나, UNKNOWN/N/A 인 경우
        is_anomaly = not raw_bh or bool(re.match(r'^[A-Za-z]+-$', raw_bh)) or raw_bh.upper() in ["UNKNOWN", "N/A"]
        
        if is_anomaly:
            row["original_raw_bh"] = raw_bh
            is_same_borehole = False
            if i > 0:
                prev_row = merged_data[i-1]
                if prev_row.get("is_anomaly"):
                    prev_raw_bh = prev_row.get("original_raw_bh", "")
                    if prev_raw_bh == raw_bh:
                        curr_top = float(row.get("상심도", 0.0))
                        prev_bottom = float(prev_row.get("하심도", 0.0))
                        # 상심도가 0.0이 아니고, 이전 하심도 대비 비정상 역행이 없으면 같은 구멍 유지
                        if curr_top > 0.0 and curr_top >= prev_bottom - 2.0:
                            is_same_borehole = True
                            
            if not is_same_borehole:
                current_anomalous_id = f"BH-a{missing_bh_counter}"
                missing_bh_counter += 1
                logging.warning(f"  🚨 [Anomaly Detection] 불완전 식별자 '{raw_bh}'을(를) '{current_anomalous_id}'(으)로 강제 독립 분리")
                
            row["is_anomaly"] = True
            row["시추공명"] = current_anomalous_id
        else:
            row["is_anomaly"] = False
            
    # 1. 중복 제거
    cleaned = deduplicate_overlap_rows(merged_data)
    # 2. 심도 연속성 보정 (A종료 = B시작 강제)
    corrected = apply_depth_continuity_correction(cleaned)
    # 3. 지층 표시명 정규화 (토사 세분류 보존)
    grouped = apply_strata_group_mapping(corrected)
    # 4. 인접 지층 병합
    return merge_consecutive_identical_soil_types(grouped)

def apply_depth_continuity_correction(rows: list) -> list:
    """
    이전 행의 하심도가 다음 행의 상심도보다 크면(중첩), 다음 행의 상심도를 이전 행의 하심도와 일치시킵니다.
    보정 결과 상심도가 하심도보다 크거나 같아지면 해당 행은 삭제합니다.
    """
    if not rows: return []
    
    # 시추공별 그룹화
    bh_groups = {}
    for r in rows:
        bh = r.get("시추공명", "Unknown")
        if bh not in bh_groups: bh_groups[bh] = []
        bh_groups[bh].append(r)
        
    all_corrected = []
    # 시추공 이름을 자연 정렬하여 순차 보정 진행
    import pdf_convert.parsers.pdf_parser_odl as ppo
    natural_sort_key = ppo.natural_sort_key
    sorted_bh_names = sorted(bh_groups.keys(), key=natural_sort_key)
    
    for bh in sorted_bh_names:
        # 상심도 순으로 정렬
        sorted_rows = sorted(bh_groups[bh], key=lambda x: float(x.get("상심도", 0.0)))
        if not sorted_rows: continue
        
        bh_corrected = []
        current = sorted_rows[0].copy()
        bh_corrected.append(current)
        
        for i in range(1, len(sorted_rows)):
            nxt = sorted_rows[i].copy()
            prev_bottom = float(current.get("하심도", 0.0))
            nxt_top = float(nxt.get("상심도", 0.0))
            
            # 중첩(Overlap) 발생 시 보정
            if prev_bottom > nxt_top:
                # 심도 역행이 너무 심하면(2.0m 이상) 다른 섹션으로 간주하거나 데이터 오류로 보고 유지는 함
                if prev_bottom > nxt_top + 2.0:
                    logging.warning(f"  ⚠️ [심도 역행] {bh}: {prev_bottom} -> {nxt_top}. 강제 연속성 부여.")
                nxt["상심도"] = prev_bottom
            
            # 유효한 두께를 가진 행만 유지 (A종료 = B시작 보장)
            # 하심도가 상심도보다 작아지면 하심도를 상심도 + 0.1m로 강제 조정하여 데이터 유실 방지
            if float(nxt.get("하심도", 0.0)) <= float(nxt.get("상심도", 0.0)):
                nxt["하심도"] = float(nxt.get("상심도", 0.0)) + 0.1
                
            bh_corrected.append(nxt)
            current = nxt
        
        all_corrected.extend(bh_corrected)
        
    return all_corrected

def merge_consecutive_identical_soil_types(rows: list) -> list:
    """
    연속된 행이 같은 시추공명과 지층명을 가지면 하나의 행으로 묶어 병합하고 심도 및 두께를 재계산합니다.
    """
    if not rows: return []
    
    # 자연 정렬 적용하여 프로젝트별, 시추공별, 상심도순 정합성 확보
    import pdf_convert.parsers.pdf_parser_odl as ppo
    natural_sort_key = ppo.natural_sort_key
    sorted_rows = sorted(rows, key=lambda x: (
        natural_sort_key(x.get("프로젝트명", "")),
        natural_sort_key(x.get("시추공명", "")), 
        float(x.get("상심도", 0.0))
    ))
    
    merged = []
    if not sorted_rows: return []
    
    current_row = sorted_rows[0].copy()
    
    for i in range(1, len(sorted_rows)):
        row = sorted_rows[i]
        
        # 병합 조건: 시추공명이 같고, 지층명이 같으며, 심도가 연속되는 경우
        # 토사 세분류가 다르면 서로 다른 해치가 필요하므로 병합하지 않는다.
        # 1. 시추공명 및 지층명 정규화 (공백 및 제어문자 노이즈 제거)
        curr_soil = str(row.get("지층명", "")).strip()
        last_soil = str(current_row.get("지층명", "")).strip()
        
        # 하이픈 유무와 상관없이 순수 영문/숫자만으로 비교하여 TB-02와 TB02 등을 일치시킴
        import re
        def clean_id(s): return re.sub(r'[^A-Z0-9]', '', str(s).upper())
        
        if (current_row.get("프로젝트명") == row.get("프로젝트명") and 
            clean_id(current_row.get("시추공명")) == clean_id(row.get("시추공명")) and 
            curr_soil == last_soil):
            
            # 하심도 업데이트 (연속된 구간 확장)
            current_row["하심도"] = max(float(current_row.get("하심도", 0.0)), float(row.get("하심도", 0.0)))
            
            # N치 통합 로직 제거 (요청에 따름)
            pass
                    
            # 이미지코드 통합 (이미지 코드가 다르더라도 같은 지층명이면 병합)
            if row.get("이미지코드") and row["이미지코드"] != current_row.get("이미지코드"):
                if current_row.get("이미지코드"):
                    current_row["이미지코드"] = f"{current_row['이미지코드']}/{row['이미지코드']}"
                else:
                    current_row["이미지코드"] = row["이미지코드"]
        else:
            # 이전 행 확정 및 두께 계산
            current_row["두께"] = round(abs(float(current_row["하심도"]) - float(current_row["상심도"])), 2)
            merged.append(current_row)
            current_row = row.copy()
            
    # 마지막 행 처리
    current_row["두께"] = round(abs(float(current_row["하심도"]) - float(current_row["상심도"])), 2)
    merged.append(current_row)
    
    # [로그] 병합 후 상태 출력
    logging.info(f"  [병합 완료] 총 행 수: {len(rows)} -> {len(merged)}")
    return merged

def deduplicate_overlap_rows(merged_rows: list) -> list:
    """심도 구간 비교를 이용해 중복된 행(행 잘림 이슈 등) 필터링 및 제거"""
    seen_depths = set()
    cleaned = []
    
    for row in merged_rows:
        depth_key = (row.get("시추공명"), row.get("상심도"), row.get("하심도"))
        if depth_key not in seen_depths:
            seen_depths.add(depth_key)
            cleaned.append(row)
        else:
            logging.info(f"  * 중복 행 병합 처리 완료: 구간 {depth_key}")
            
    return cleaned

if __name__ == "__main__":
    # [Mock 테스트] 페이지 경계에서 중복되고, 2페이지엔 헤더가 누락된 상황 세팅
    mock = [
        { "page": 1, "data": [
            {"Hole_No": "BH-01", "Coordinates": "X:10", "Groundwater": "GL-1", "Depth_From": 0.0, "Depth_To": 1.5, "N_Value": "10/30"}
        ]},
        { "page": 2, "data": [
            {"Depth_From": 0.0, "Depth_To": 1.5, "N_Value": "10/30"}, # 1페이지와 겹친 부분 (중복 제거 대상)
            {"Depth_From": 1.5, "Depth_To": 3.0, "N_Value": "50/15"}  # 정상 이어짐, 메타데이터 누락됨
        ]}
    ]
    result = merge_multi_page_tables(mock)
    print("\n[병합 완료 최종 데이터]")
    print(json.dumps(result, indent=2, ensure_ascii=False))
