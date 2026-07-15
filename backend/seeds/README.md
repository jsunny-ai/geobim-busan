# seeds (데이터 시드)

초기 개발·테스트용 샘플 데이터 임포트 스크립트 자리입니다.

## Phase 2 예상 사용법

```bash
# 수원시 시추공 CSV 데이터 임포트
uv run python -m seeds.import_suwon --data-dir <데이터_경로>
```

## 데이터 출처

- 수원시 지반정보 CSV/JSON (공공데이터포털 또는 내부 수집본)
- 파일 형식: UTF-8 CSV, 컬럼 매핑은 스크립트 내 상수로 정의

## 주의

`seeds/data/` 하위 파일(*.csv, *.json)은 `.gitignore`에 의해 추적되지 않습니다.
실제 데이터 파일은 별도 공유 경로에서 수동 복사하세요.
