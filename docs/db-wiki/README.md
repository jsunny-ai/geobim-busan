# GeoBIM DB Wiki

이 디렉터리는 데이터베이스를 사람과 LLM이 함께 이해하기 위한 지식 기준점입니다.

## 파일 구성

- `SCHEMA.md`: ORM 모델에서 자동 생성한 테이블·컬럼·관계 문서
- `schema.json`: 검색·RAG·도구 연동에 사용하는 기계 판독 스키마
- `SEMANTICS.md`: 자동 추론하기 어려운 업무 의미·단위·계산 규칙

`SCHEMA.md`와 `schema.json`은 직접 수정하지 않습니다.

## 명령

저장소 루트에서 실행합니다.

```powershell
python backend/scripts/generate_db_wiki.py
python backend/scripts/generate_db_wiki.py --check
python backend/scripts/generate_db_wiki.py --check-live
```

호스트 Python 환경에는 최소한 SQLAlchemy와 GeoAlchemy2가 필요합니다. CI는 이 최소
의존성을 설치한 뒤 `--check`를 자동 실행합니다.

실행 DB 비교는 백엔드 컨테이너에서 임시 산출물을 만들며 수행할 수 있습니다.

```powershell
docker exec geobim-stratum-backend-1 python scripts/generate_db_wiki.py --output-dir /tmp/db-wiki --check-live
```

`--check`는 모델 변경 후 생성 문서가 갱신되지 않았으면 실패합니다.  
`--check-live`는 `DATABASE_URL`의 실제 DB 테이블·컬럼과 ORM 모델을 비교합니다.

## 갱신 원칙

1. DB 모델 또는 Alembic 마이그레이션을 변경한다.
2. DB Wiki 생성기를 실행한다.
3. 자동 생성 파일의 변경 내용을 검토한다.
4. 업무 의미가 바뀌면 `SEMANTICS.md`도 수정한다.
5. `--check`와 `--check-live`를 통과시킨다.

향후 벡터 검색을 추가할 때는 `schema.json`, `SEMANTICS.md`, 관련 API 문서를 청크 단위로 색인합니다.
