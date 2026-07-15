# pdf_convert (Phase 2 복사 대상)

이 폴더는 Phase 2에서 외부 레포의 파이프라인 코드를 복사할 자리입니다.

## 원본 경로

```
backend/pdf_convert
```

## Phase 2 작업 절차

1. 원본 레포의 `core/`, `parsers/` 폴더를 이 디렉토리(`backend/pdf_convert/`)로 복사
2. `backend/pyproject.toml` 의존성과 충돌 없는지 확인
3. `backend/app/services/pdf_service.py` 에서 `from pdf_convert.core import ...` 형태로 import
4. Celery 태스크(`app/workers/pdf_tasks.py`)에서 서비스 호출

## 통합 방식

마이크로서비스 분리 없이 **in-process import** 방식으로 통합합니다.
(네트워크 오버헤드 없이 동일 Python 프로세스 내에서 직접 호출)
