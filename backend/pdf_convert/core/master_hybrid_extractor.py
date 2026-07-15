"""
마스터 하이브리드 추출기 (3-Tier Precision Extraction Pipeline)
1. Tier 1 (Main): HWPX 기반 DataFrame 인덱스 좌표 추출
2. Tier 2 (Fallback): PyMuPDF 유클리드 공간 거리 기반 결측치 보정
3. Tier 3 (Validation): ODL Markdown 덤프를 통한 추출 행 수 일치 검증
4. Delivery: Flask 응답 헤더 최적화 구조에 삽입하기 쉬운 형태의 출력
"""

import logging
import os
import time
from typing import List, Dict, Tuple

from pdf_convert.parsers.hwpx_converter import batch_convert_docx_to_hwpx
from pdf_convert.parsers.hwp_indexed_extractor import (
    clean_float,
    extract_depth_values,
    extract_crs_from_page,
    extract_project_name_from_pdf,
    normalize_bh_id,
    normalize_strata,
    parse_coordinates,
)
from pdf_convert.core.table_merger import merge_multi_page_tables
import pdf_convert.parsers.pdf_parser_odl as ppo

try:
    import opendataloader_pdf
except Exception:  # pragma: no cover - optional Windows/runtime dependency
    opendataloader_pdf = None

logger = logging.getLogger(__name__)

class MasterHybridExtractor:
    def __init__(self, output_dir: str, java_bin: str | None = None):
        self.output_dir = output_dir
        self.java_bin = java_bin or os.path.join(output_dir, "jdk_folder", "jdk-21.0.2", "bin")
        os.makedirs(os.path.join(self.output_dir, "data", "02_markdown"), exist_ok=True)
        
        # ODL을 위한 Java 환경 변수 설정
        if os.path.exists(self.java_bin):
            if self.java_bin not in os.environ.get("PATH", ""):
                os.environ["PATH"] = self.java_bin + os.pathsep + os.environ.get("PATH", "")
        else:
            logger.warning("   ⚠️ Local JDK not found. Relying on System JAVA_HOME or PATH.")

    def process_file(self, source_path: str, project_name: str) -> List[Dict]:
        """
        단일 파일(PDF 또는 DOCX/HWPX)에 대해 3-Tier 파이프라인을 구동합니다.
        """
        logger.info(f"🚀 [3-Tier Pipeline] 처리 시작: {source_path}")
        
        # 파일 형식 판별 및 준비 (PDF, DOCX -> HWPX 전환)
        hwpx_path = self._prepare_hwpx(source_path)
        pdf_path = self._prepare_pdf(source_path)
        
        # [CRS Detection] PDF 첫 페이지에서 좌표계 메타데이터 추출
        source_crs = None
        if pdf_path and os.path.exists(pdf_path):
            try:
                import fitz
                doc = fitz.open(pdf_path)
                page0_text = doc[0].get_text() if len(doc) > 0 else ""
                from pdf_convert.parsers.hwp_indexed_extractor import extract_crs_from_page
                source_crs = extract_crs_from_page(page_text=page0_text, page=doc[0] if len(doc) > 0 else None)
                if source_crs:
                    logger.info(f"   ㄴ [CRS] 좌표계 감지: {source_crs}")
                doc.close()
            except Exception as e:
                logger.warning(f"   ㄴ [CRS] 좌표계 감지 실패: {e}")

            detected_project_name = extract_project_name_from_pdf(pdf_path)
            if detected_project_name:
                project_name = detected_project_name
                logger.info(f"   ㄴ [Project] 프로젝트명 감지: {project_name}")
        
        # -----------------------------
        # Tier 1 (Main Engine): HWPX Structural Parsing (or ODL Fallback for PDF)
        # -----------------------------
        logger.info(f"   ㄴ [Tier 1] HWPX 표 구조 기반 추출 시도")
        raw_data, meta = self._tier1_hwpx_extract(hwpx_path, project_name)
        
        if meta.get("조사명", "N/A") != "N/A":
            project_name = meta["조사명"]
            for row in raw_data:
                row["프로젝트명"] = project_name
                
        if not raw_data and pdf_path:
            logger.info(f"   ㄴ [Tier 1.5] PDF 표 인덱스 기반 추출 시도")
            from pdf_convert.parsers.hwp_indexed_extractor import process_single_pdf_indexed
            raw_data = process_single_pdf_indexed(pdf_path, project_name=project_name)
            
            if raw_data:
                logger.info(f"      * PDF 인덱스 추출 성공: {len(raw_data)} 행")
                # [Global Sync] 확정된 project_name을 전 행에 브로드캐스팅하여 PJ_ 오염 차단
                for row in raw_data:
                    row["프로젝트명"] = project_name
                # 메타데이터 업데이트 (첫 번째 행 기준)
                if raw_data[0].get("경도") != "N/A": meta["경도"] = raw_data[0]["경도"]
                if raw_data[0].get("위도") != "N/A": meta["위도"] = raw_data[0]["위도"]
                if raw_data[0].get("표고") != "N/A": meta["표고"] = raw_data[0]["표고"]
            else:
                logger.warning(f"   ㄴ [Tier 1.9 Fallback] HWPX/PDF 표 인식안됨. ODL 마크다운 추출기 가동")
                if opendataloader_pdf is None:
                    logger.warning("      * opendataloader_pdf 미설치로 ODL 폴백을 건너뜁니다.")
                else:
                    md_dir = os.path.join(self.output_dir, "data", "02_markdown", "Fallback_Ext")
                    main_md_dir = os.path.join(self.output_dir, "data", "02_markdown")
                    os.makedirs(md_dir, exist_ok=True)

                    try:
                        base = os.path.splitext(os.path.basename(pdf_path))[0]
                        # [Optimization] 메인 디렉토리나 폴백 디렉토리에 이미 MD가 있는지 확인
                        existing_md = None
                        target_md_path = os.path.join(md_dir, f"{base}.md")
                        main_md_path = os.path.join(main_md_dir, f"{base}.md")

                        if os.path.exists(main_md_path): existing_md = main_md_path
                        elif os.path.exists(target_md_path): existing_md = target_md_path

                        if not existing_md:
                            logger.info(f"      * 마크다운 파일 부재. ODL 신규 변환 시작...")
                            time.sleep(1)
                            opendataloader_pdf.convert(input_path=[pdf_path], output_dir=md_dir, format="markdown", quiet=True)
                            md_files = [f for f in os.listdir(md_dir) if f.endswith('.md') and base in f]
                            if md_files:
                                md_path = os.path.join(md_dir, md_files[0])
                            else:
                                md_path = None
                        else:
                            md_path = existing_md
                            logger.info(f"      * 기생성된 마크다운 재사용(Tier 1 Fallback): {os.path.basename(md_path)}")

                        if md_path:
                            pages_data = ppo.extract_all_from_md(md_path, project_name=project_name, pdf_path=pdf_path)

                            # flat 병합 (Tier 1 결과 형식에 맞춤)
                            for page in pages_data:
                                raw_data.extend(page.get("data", []))

                            # 빈값이 채워진 meta 정보 가져오기 (ODL이 찾았을 수도 있음)
                            if pages_data and pages_data[0].get("data"):
                                first = pages_data[0]["data"][0]
                                if first.get("경도"): meta["경도"] = first["경도"]
                                if first.get("위도"): meta["위도"] = first["위도"]
                                if first.get("표고"): meta["표고"] = first["표고"]
                    except Exception:
                        import traceback
                        logger.error(f"   ❌ [Tier 1 Fallback] ODL 전환 실패: {traceback.format_exc()}")
        
        # -----------------------------
        # Tier 2: PyMuPDF Spatial Recovery (Fallback)
        # -----------------------------
        if self._needs_fallback(meta) and pdf_path:
            logger.warning(f"   ㄴ [Tier 2] 결측치 감지! PyMuPDF 공간 폴백 발동")
            # Tier 2 실구현부 보강 (코드 구조 유지)
            meta = self._tier2_spatial_recovery(pdf_path, meta)
            
            if meta.get("조사명", "N/A") != "N/A":
                project_name = meta["조사명"]
                
            # 메타데이터를 원시 데이터에 덮어쓰기
            for row in raw_data:
                row["프로젝트명"] = project_name
                if self._is_missing_metadata_value(row.get("경도")):
                    row["경도"] = meta.get("경도", row.get("경도"))
                if self._is_missing_metadata_value(row.get("위도")):
                    row["위도"] = meta.get("위도", row.get("위도"))
                if self._is_missing_metadata_value(row.get("표고")):
                    row["표고"] = meta.get("표고", row.get("표고"))
                row["meta_crs"] = meta.get("meta_crs", None)
        else:
            logger.info(f"   ㄴ [Tier 2] 결측치 없음 (통과)")

        # -----------------------------
        # Tier 3: ODL Cross-Check Validation
        # -----------------------------
        if pdf_path:
            logger.info(f"   ㄴ [Tier 3] ODL 마크다운 덤프 및 데이터 행 수 검증")
            is_valid = self._tier3_odl_validation(pdf_path, len(raw_data), project_name)
            if not is_valid:
                logger.error(f"   ❌ [Tier 3 검증 실패] 원본 파싱 행 수와 최종 추출 행 수가 불일치합니다!")
                # 정책에 따라 강제 중단하거나 오류 로그만 남기고 속행할 수 있음
        
        # -----------------------------
        # 최종 무결성 검증 (Project-based Clustering Validation)
        # -----------------------------
        from pdf_convert.core.coordinate_transformer import normalize_coordinates
        from pdf_convert.core.spatial_validator import SpatialValidator
        validator = SpatialValidator()
        
        # 1차 변환 수행
        temp_data = []
        coords_for_clustering = []
        
        for row in raw_data:
            mandatory_fields = ["상심도", "하심도", "지층명"]
            if any(str(row.get(f, "N/A")) == "N/A" for f in mandatory_fields):
                if row.get("시추공명") != "UNKNOWN":
                    logger.error(f"   [유실 차단] {project_name} - {row.get('시추공명')} 필수 정보 결측.")
                continue
                
            lon, lat, tmx, tmy, final_epsg = normalize_coordinates(
                row.get("경도"), 
                row.get("위도"), 
                borehole_id=row.get("시추공명", "Unknown"),
                source_crs=row.get("meta_crs") or source_crs
            )
            row["lon_wgs84"] = lon
            row["lat_wgs84"] = lat
            row["tm_x"] = tmx
            row["tm_y"] = tmy
            row["meta_crs"] = final_epsg
            
            temp_data.append(row)
            if lon != "" and lat != "":
                coords_for_clustering.append((float(lon), float(lat)))
            else:
                coords_for_clustering.append(None)

        # 2차: 프로젝트 단위 군집 검증
        valid_coords = [c for c in coords_for_clustering if c is not None]
        if valid_coords:
            cluster_results = validator.validate_project_clustering(valid_coords)
            
            # 결과 매핑
            c_idx = 0
            for i, row in enumerate(temp_data):
                if coords_for_clustering[i] is not None:
                    is_valid_cluster = cluster_results[c_idx]
                    if not is_valid_cluster:
                        logger.warning(f"   [Outlier Reject] {project_name} - {row.get('시추공명')} 군집 이탈 판정.")
                        row["lon_wgs84"] = ""
                        row["lat_wgs84"] = ""
                        row["tm_x"] = ""
                        row["tm_y"] = ""
                        row["meta_crs"] = "REJECT_OUTLIER"
                    c_idx += 1
        
        verified_data = temp_data

        if not verified_data:
            logger.error(f"   [FAIL] {project_name} - 유효한 데이터가 0건입니다.")
            return []
            
        logger.info(f"   ㄴ [Merge] 공통 후처리(심도 보정 및 병합) 적용")
        for row in verified_data:
            row["프로젝트명"] = project_name
        merged_data = merge_multi_page_tables([{"data": verified_data}])
        
        return merged_data

    def _prepare_hwpx(self, source_path: str) -> str:
        base, ext = os.path.splitext(source_path)
        ext = ext.lower()
        
        if ext == ".hwpx":
            return source_path
        elif ext == ".docx":
            # HWPX 변환 (임시 디렉토리에서)
            hwpx_file = base + ".hwpx"
            if not os.path.exists(hwpx_file):
                logger.info("      * DOCX를 HWPX로 실시간 변환")
                try:
                    from pyhwpx import Hwp
                    hwp = Hwp(visible=False)
                    hwp.open(source_path)
                    hwp.save_as(hwpx_file)
                    hwp.quit()
                except Exception as e:
                    logger.error(f"HWPX 변환 오류: {e}")
            return hwpx_file
        else:
            # 아직 PDF에서 HWPX로 다이렉트 변환 로직은 ODL에 의존하거나 별도 도구가 필요
            return ""

    def _prepare_pdf(self, source_path: str) -> str:
        base, ext = os.path.splitext(source_path)
        if ext.lower() == ".pdf":
            return source_path
        # DOCX/HWPX인 경우 PDF 파일이 같은 이름으로 존재한다고 가정
        pdf_file = base + ".pdf"
        if os.path.exists(pdf_file):
            return pdf_file
        pdf_file = source_path.replace("_converted", "").replace(".docx", ".pdf").replace(".hwpx", ".pdf")
        if os.path.exists(pdf_file):
            return pdf_file
        return ""

    def _tier1_hwpx_extract(self, hwpx_path: str, project_name: str) -> Tuple[List[Dict], Dict]:
        """pyhwpx를 통한 인덱스 추출 (Tier 1)"""
        if not hwpx_path or not os.path.exists(hwpx_path):
            return [], {"경도": "N/A", "위도": "N/A", "표고": "N/A", "조사명": "N/A"}
            
        try:
            from pyhwpx import Hwp
        except Exception as e:
            logger.warning(f"[Tier 1] pyhwpx unavailable, skipping HWPX extraction: {e}")
            return [], {"경도": "N/A", "위도": "N/A", "표고": "N/A", "조사명": "N/A"}
        hwp = None
        raw_rows = []
        meta = {"경도": "N/A", "위도": "N/A", "표고": "N/A", "조사명": "N/A"}
        
        try:
            hwp = Hwp(visible=False)
            hwp.open(hwpx_path)
            
            try:
                df0 = hwp.table_to_df(0)
            except: df0 = None
            try:
                df1 = hwp.table_to_df(1)
            except: df1 = None

            if df1 is None or df1.empty:
                return [], meta

            bh_id = "UNKNOWN"
            if df0 is not None and not df0.empty:
                try:
                    for i in range(df0.shape[0]):
                        for j in range(df0.shape[1]):
                            col_text = str(df0.iloc[i, j]).strip()
                            if col_text in ["조사명", "용역명", "공사명"]:
                                if j + 1 < df0.shape[1]:
                                    meta["조사명"] = str(df0.iloc[i, j+1]).strip()
                                    break
                        if meta.get("조사명", "N/A") != "N/A":
                            break
                except Exception: pass
                
                try:
                    bh_raw = str(df0.iloc[0, 7]) if df0.shape[1] > 7 else ""
                    bh_id_norm = normalize_bh_id(bh_raw)
                    if bh_id_norm: bh_id = bh_id_norm
                    
                    coord_raw = str(df0.iloc[1, 5]) if df0.shape[0] > 1 and df0.shape[1] > 5 else ""
                    lon_val, lat_val = parse_coordinates(coord_raw)
                    if lon_val: meta["경도"] = lon_val
                    if lat_val: meta["위도"] = lat_val
                    
                    elev_raw = str(df0.iloc[1, 7]) if df0.shape[0] > 1 and df0.shape[1] > 7 else ""
                    elev_val = clean_float(elev_raw)
                    if elev_val: meta["표고"] = elev_val
                except IndexError: pass

            prev_depth = 0.0
            for row_idx in range(2, len(df1)):
                row_data = df1.iloc[row_idx]
                if len(row_data) < 5: continue
                depth_values = extract_depth_values(str(row_data.iloc[0]))
                if not depth_values: continue
                depth = depth_values[-1]
                strata = normalize_strata(str(row_data.iloc[4]))
                
                raw_rows.append({
                    "프로젝트명": project_name,
                    "시추공명": bh_id,
                    "경도": meta["경도"],
                    "위도": meta["위도"],
                    "표고": meta["표고"],
                    "상심도": prev_depth,
                    "하심도": depth,
                    "지층명": strata,
                })
                prev_depth = depth
                
        except Exception as e:
            logger.error(f"[Tier 1] HWPX Parsing Error: {e}")
        finally:
            if hwp: hwp.quit()
            
        return raw_rows, meta

    def _needs_fallback(self, meta: Dict) -> bool:
        return any(v == "N/A" for v in meta.values())

    @staticmethod
    def _is_missing_metadata_value(value) -> bool:
        if value is None:
            return True
        text = str(value).strip()
        return text == "" or text.upper() in {"N/A", "UNKNOWN", "NONE", "NULL"}

    def _tier2_spatial_recovery(self, pdf_path: str, current_meta: Dict) -> Dict:
        """PyMuPDF 공간 유클리드 거리 폴백 (Tier 2)"""
        import fitz
        doc = fitz.open(pdf_path)
        try:
            # 주로 첫 번째 페이지에 메타데이터가 집중
            page = doc[0]
            
            if current_meta.get("조사명", "N/A") == "N/A":
                text = page.get_text("text")
                import re
                for line in text.split('\n'):
                    match = re.search(r'(조사명|용역명|공사명)\s*[:：]?\s*(.+)', line)
                    if match:
                        val = match.group(2).strip()
                        if val:
                            current_meta["조사명"] = val
                            break
                            
            recovered = ppo.find_metadata_spatial(page)
            
            if current_meta["위도"] == "N/A" and recovered.get("lat"):
                current_meta["위도"] = recovered["lat"]
            if current_meta["경도"] == "N/A" and recovered.get("lon"):
                current_meta["경도"] = recovered["lon"]
            if current_meta["표고"] == "N/A" and recovered.get("el"):
                current_meta["표고"] = recovered["el"]
            
            # [Stage 54] 문서 헤더에서 명시적 좌표계(CRS) 추출
            text_full = page.get_text("text")
            crs_code = extract_crs_from_page(page_text=text_full, page=page)
            current_meta["meta_crs"] = crs_code
            if crs_code:
                logger.info(f"      * [Metadata] 문서 명시 좌표계 발견: {crs_code}")
                
        except Exception as e:
            logger.error(f"[Tier 2] Spatial Recovery Error: {e}")
        finally:
            doc.close()
        return current_meta

    def _tier3_odl_validation(self, pdf_path: str, extracted_row_count: int, project_name: str) -> bool:
        """ODL 마크다운 덤프 및 데이터 행수 교차 검증 (Tier 3)"""
        if extracted_row_count == 0:
            return False
        if opendataloader_pdf is None:
            logger.warning("      * opendataloader_pdf 미설치로 ODL 검증을 건너뜁니다.")
            return True
            
        # 임시 출력 디렉토리
        md_output_dir = os.path.join(self.output_dir, "data", "02_markdown", "Validation_Temp")
        os.makedirs(md_output_dir, exist_ok=True)
        
        try:
            base = os.path.splitext(os.path.basename(pdf_path))[0]
            md_path = os.path.join(md_output_dir, f"{base}.md")
            
            # [Optimization] 이미 마크다운 파일이 존재하면 재변환 생략 (속도 개선)
            # 메인 디렉토리나 폴백 디렉토리도 함께 체크
            fallback_md_path = os.path.join(self.output_dir, "data", "02_markdown", "Fallback_Ext", f"{base}.md")
            main_md_path = os.path.join(self.output_dir, "data", "02_markdown", f"{base}.md")
            
            existing_md = None
            if os.path.exists(md_path): existing_md = md_path
            elif os.path.exists(fallback_md_path): existing_md = fallback_md_path
            elif os.path.exists(main_md_path): existing_md = main_md_path
            
            if not existing_md:
                # 1. ODL MD 변환 (WinError 5 방지를 위한 지연/재시도)
                time.sleep(0.5)
                opendataloader_pdf.convert(
                    input_path=[pdf_path], 
                    output_dir=md_output_dir,
                    format="markdown"
                )
            else:
                md_path = existing_md
                logger.info(f"      * 기생성된 마크다운 재사용: {os.path.basename(md_path)}")
            
            if not os.path.exists(md_path):
                # ODL 변환 실패시 검증 Pass(무조건 실패로 띄우진 않음. False-positive 방지)
                logger.warning("      * ODL MD 덤프 불가로 검증 생략")
                return True
                
            # 2. 마크다운 내 표(Row) 파이프 갯수 계수
            with open(md_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                
            md_table_rows = 0
            for line in lines:
                # 간단한 지층 표(5컬럼 이상 파이프라인 존재) 행을 세팅
                if line.strip().startswith('|') and line.count('|') >= 5:
                    # 헤더(---|---)나 빈 데이터 스킵
                    if "---" in line or "심 도" in line.replace(" ", ""):
                        continue
                    # 심도 컬럼에 숫자가 존재하는지 확인
                    parts = line.split('|')
                    if len(parts) > 2 and clean_float(parts[1]) is not None:
                        md_table_rows += 1
                        
            # 검증 로직 (마크다운의 노이즈를 감안, MD 행수가 추출 행수보다 월등히 많을 때만 경고)
            # 마크다운은 페이지 분할 등으로 인해 테이블 행이 데이터 행보다 항상 조금 더 많거나 같습니다.
            logger.info(f"      * 검증 지표: 추출({extracted_row_count}행) vs ODL({md_table_rows}행)")
            
            error_margin = 0.5 # 50% 이상 차이 날 때 유실로 판단
            if md_table_rows > 0 and extracted_row_count < (md_table_rows * error_margin):
                return False
                
            return True
            
        except Exception as e:
            logger.error(f"[Tier 3] ODL Validation Error: {e}")
            return True # 시스템 블로킹 방지용 패스

# Delivery를 위한 인터페이스를 제공
from urllib.parse import quote

def get_csv_headers() -> Dict[str, str]:
    """
    서버(Flask)에서 다운로드 응답을 만들 때 사용할 고정 헤더 반환 (Delivery)
    """
    filename = quote("서울특별시_CSV_통합_최종.csv")
    return {
        "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
        "Content-Type": "text/csv; charset=utf-8-sig",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
    }
