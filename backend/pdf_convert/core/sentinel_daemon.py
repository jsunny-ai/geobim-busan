import os
import re
import time
import json
import logging
import threading
import sys
from datetime import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import pystray
from PIL import Image, ImageDraw
from plyer import notification

# ==========================================
# 1. 설정 및 상수 정의
# ==========================================
CONFIG_FILE = "sentinel_config.json"
DEFAULT_CONFIG = {
    "watch_dir": os.path.expanduser("~/Downloads"),
    "enabled": True,
    "naming_format": "sentinel_{date}_{time}_{name}{ext}",
    "log_level": "INFO",
    "backup_dir": "sentinel_backups"
}

UUID_REGEX = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)

SIGNATURES = {
    b"%PDF-": ".pdf",
    b"PK\x03\x04": ".zip",
    b"\x89PNG\r\n\x1a\n": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"\xef\xbb\xbf": ".csv",
    b"MZ": ".exe"
}

# ==========================================
# 2. 파일 이벤트 핸들러 (Watchdog Handler)
# ==========================================
class SentinelHandler(FileSystemEventHandler):
    def __init__(self, daemon_instance):
        self.daemon = daemon_instance

    def on_created(self, event):
        if not event.is_directory:
            self.daemon.process_file_with_retry(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self.daemon.process_file_with_retry(event.dest_path)

# ==========================================
# 3. 메인 데몬 클래스
# ==========================================
class FileNameSentinel:
    def __init__(self):
        self.config = self.load_config()
        self.enabled = self.config.get("enabled", True)
        self.observer = None
        self.running = True
        
        # 로깅 설정
        logging.basicConfig(
            level=getattr(logging, self.config.get("log_level", "INFO")),
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[logging.FileHandler("sentinel.log", encoding='utf-8'), logging.StreamHandler()]
        )

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return DEFAULT_CONFIG
        return DEFAULT_CONFIG

    def save_config(self):
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.config, f, indent=4, ensure_ascii=False)

    def process_file_with_retry(self, file_path, retries=5, delay=1):
        """파일이 대규모인 경우 기록 중일 수 있으므로 재시도 로직 포함"""
        if not self.enabled: return

        for i in range(retries):
            try:
                # 파일이 잠겨있지 않은지 확인 (쓰기 완료 대기)
                with open(file_path, 'rb') as f:
                    pass
                self.analyze_and_rename(file_path)
                break
            except (IOError, PermissionError):
                time.sleep(delay)
            except Exception as e:
                logging.error(f"Error checking file {file_path}: {e}")
                break

    def analyze_and_rename(self, file_path):
        filename = os.path.basename(file_path)
        base, ext = os.path.splitext(filename)
        
        # UUID 패턴인지 확인
        if not UUID_REGEX.match(base):
            return

        logging.info(f"🔍 UUID 탐지: {filename}")
        
        # Magic Number 분석
        inferred_ext = ".bin"
        try:
            with open(file_path, 'rb') as f:
                header = f.read(16)
                for sig, s_ext in SIGNATURES.items():
                    if header.startswith(sig):
                        inferred_ext = s_ext
                        break
        except Exception as e:
            logging.error(f"Header analysis failed: {e}")

        # 새 이름 생성
        now = datetime.now()
        date_str = now.strftime('%Y%m%d')
        time_str = now.strftime('%H%M%S')
        
        new_name = self.config["naming_format"].format(
            date=date_str,
            time=time_str,
            name=base[:8],
            ext=inferred_ext
        )
        
        dest_path = os.path.join(os.path.dirname(file_path), new_name)
        
        # 중복 방지
        counter = 1
        while os.path.exists(dest_path):
            n_base, n_ext = os.path.splitext(new_name)
            dest_path = os.path.join(os.path.dirname(file_path), f"{n_base}_{counter}{n_ext}")
            counter += 1

        # 리네임 실행
        try:
            os.rename(file_path, dest_path)
            logging.info(f"✅ 복구 성공: {filename} -> {os.path.basename(dest_path)}")
            self.notify("파일명 복구 완료", f"{filename} -> {os.path.basename(dest_path)}")
        except Exception as e:
            logging.error(f"Rename failed for {filename}: {e}")

    def notify(self, title, message):
        try:
            notification.notify(
                title=f"[Sentinel] {title}",
                message=message,
                app_name="FileName Sentinel",
                timeout=5
            )
        except:
            pass

    def start_monitoring(self):
        watch_path = self.config.get("watch_dir", os.path.expanduser("~/Downloads"))
        if not os.path.exists(watch_path):
            logging.error(f"Watch directory does not exist: {watch_path}")
            return

        event_handler = SentinelHandler(self)
        self.observer = Observer()
        self.observer.schedule(event_handler, watch_path, recursive=False)
        self.observer.start()
        logging.info(f"🚀 Sentinel 감시 시작: {watch_path}")

    def stop_monitoring(self):
        if self.observer:
            self.observer.stop()
            self.observer.join()
            logging.info("🛑 Sentinel 감시 중단")

    def run_tray(self):
        # 트레이 아이콘 이미지 생성 (간이 캔버스)
        width, height = 64, 64
        image = Image.new('RGB', (width, height), (79, 70, 229)) # Indigo color
        dc = ImageDraw.Draw(image)
        dc.rectangle([16, 16, 48, 48], fill=(255, 255, 255))
        dc.polygon([(32, 48), (16, 32), (48, 32)], fill=(79, 70, 229)) # Arrow

        def on_toggle(icon, item):
            self.enabled = not self.enabled
            self.config["enabled"] = self.enabled
            self.save_config()
            logging.info(f"Sentinel {'활성화' if self.enabled else '비활성화'}")

        def on_exit(icon, item):
            self.running = False
            icon.stop()
            self.stop_monitoring()
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("실시간 감시 활성화", on_toggle, checked=lambda item: self.enabled),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료 (Exit)", on_exit)
        )

        icon = pystray.Icon("FileName Sentinel", image, "FileName Sentinel", menu)
        icon.run()

if __name__ == "__main__":
    sentinel = FileNameSentinel()
    
    # 1. 감시 엔진 시작
    sentinel.start_monitoring()
    
    # 2. 트레이 아이콘 시작 (메인 스레드 점유)
    sentinel.run_tray()
