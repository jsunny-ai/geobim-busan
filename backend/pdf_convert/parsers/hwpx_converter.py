import os
import glob
import logging

try:
    from pyhwpx import Hwp
except Exception:  # pragma: no cover - optional Windows/Hancom dependency
    Hwp = None

logger = logging.getLogger(__name__)

def batch_convert_docx_to_hwpx(base_dir: str):
    """지정된 디렉토리 내의 _converted.docx 파일을 찾아서 hwpx로 변환합니다."""
    # 하위 디렉토리까지 재귀 탐색
    docx_files = glob.glob(os.path.join(base_dir, "**", "*_converted.docx"), recursive=True)
    
    if not docx_files:
        logger.warning(f"⚠️ '{base_dir}' 하위에서 변환 대상 문서(*_converted.docx)를 찾을 수 없습니다.")
        return []

    logger.info(f"🚀 총 {len(docx_files)}개의 DOCX 파일을 HWPX로 변환 시작...")
    
    converted_files = []
    hwp = None
    if Hwp is None:
        logger.warning("pyhwpx is unavailable; DOCX to HWPX conversion skipped.")
        return converted_files

    try:
        # 한컴오피스를 백그라운드 모드로 실행
        hwp = Hwp(visible=False)
        
        for docx_path in docx_files:
            hwpx_path = docx_path.replace(".docx", ".hwpx")
            
            # 이미 변환된 파일이 있으면 스킵
            if os.path.exists(hwpx_path):
                logger.info(f"⏭️ 기변환 스킵: {os.path.basename(hwpx_path)}")
                converted_files.append(hwpx_path)
                continue
                
            try:
                # pyhwpx의 내장 메서드를 통해 Open/SaveAs 실행
                logger.info(f"🔄 변환 중: {os.path.basename(docx_path)}")
                hwp.open(docx_path)
                hwp.save_as(hwpx_path)
                
                if os.path.exists(hwpx_path):
                    logger.info(f"✅ 변환 완료: {os.path.basename(hwpx_path)}")
                    converted_files.append(hwpx_path)
                else:
                    logger.error(f"❌ 변환 실패 (파일 생성 안됨): {docx_path}")
            except Exception as e:
                logger.error(f"❌ 변환 중 오류 발생 [{os.path.basename(docx_path)}]: {e}")
                
    except Exception as e:
        logger.error(f"❌ 한컴오피스 HWP 컨트롤 초기화 오류: {e}")
    finally:
        if hwp:
            hwp.quit()
            
    return converted_files

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    base_dir = os.environ.get("PDF_CONVERT_DATA_DIR", os.getcwd())
    batch_convert_docx_to_hwpx(base_dir)
