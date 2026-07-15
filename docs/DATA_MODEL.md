# 데이터 모델

> 최신 자동 생성 스키마와 LLM용 데이터 사전은
> [DB Wiki](./db-wiki/README.md)를 기준으로 합니다.
> 이 문서는 초기 설계 참고 자료이며 현재 ORM 모델과 차이가 있을 수 있습니다.

## 공통 컬럼 (모든 테이블)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | Integer PK | 자동 증가 기본키 |
| `created_at` | DateTime | 생성 시각 (UTC) |
| `updated_at` | DateTime | 수정 시각 (UTC, 자동 갱신) |
| `deleted_at` | DateTime? | 소프트 삭제 시각 (NULL = 유효) |

---

## ER 관계도

```
User 1──*──Project
User *──*──Project  (ProjectMember 중간 테이블)
User 1──*──PdfTemplate

Project 1──*──Borehole
Project 1──*──PdfExtractionJob

Borehole 1──*──Stratum

PdfExtractionJob *──1──PdfTemplate  (nullable)
```

---

## 테이블 명세

### `users`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| email | VARCHAR(255) | UNIQUE, NOT NULL |
| hashed_password | VARCHAR(255) | NOT NULL |
| role | ENUM | `designer` / `expert` / `reviewer` |

### `projects`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| name | VARCHAR(200) | NOT NULL |
| owner_id | FK → users.id | NOT NULL |
| region | VARCHAR(100) | nullable |
| source_crs | VARCHAR(50) | nullable (예: EPSG:5186) |
| bbox | JSON | nullable (지도 범위) |

### `project_members`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| project_id | FK → projects.id | PK |
| user_id | FK → users.id | PK |
| role | VARCHAR(50) | NOT NULL |

### `boreholes`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| project_id | FK → projects.id | NOT NULL |
| name | VARCHAR(100) | NOT NULL |
| location | Geography(POINT, 4326) | NOT NULL (PostGIS) |
| elevation | FLOAT | nullable |
| source_crs | VARCHAR(50) | nullable |
| source_file | VARCHAR(500) | nullable |

### `strata`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| borehole_id | FK → boreholes.id | NOT NULL |
| depth_top | FLOAT | NOT NULL |
| depth_bottom | FLOAT | NOT NULL |
| soil_type | VARCHAR(100) | nullable |
| raw_text | TEXT | nullable |
| source_file | VARCHAR(500) | nullable |

### `pdf_templates`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| name | VARCHAR(200) | NOT NULL |
| owner_id | FK → users.id | NOT NULL |
| region | VARCHAR(100) | nullable |
| box_definitions | JSON | NOT NULL (아래 스키마 참조) |
| sample_pdf | VARCHAR(500) | nullable (파일 경로) |

#### `box_definitions` JSON 스키마 예시
```json
{
  "boxes": [
    { "label": "borehole_id",      "page": 1, "rect": [0.05, 0.10, 0.30, 0.15] },
    { "label": "coordinate",       "page": 1, "rect": [0.35, 0.10, 0.65, 0.15] },
    { "label": "strata_table_depth","page": 2, "rect": [0.10, 0.20, 0.25, 0.80] }
  ]
}
```

### `pdf_extraction_jobs`
| 컬럼 | 타입 | 제약 |
|------|------|------|
| project_id | FK → projects.id | NOT NULL |
| file_path | VARCHAR(500) | NOT NULL |
| status | ENUM | `pending` / `running` / `done` / `failed` |
| template_id | FK → pdf_templates.id | nullable |
| result | JSON | nullable |
| error | TEXT | nullable |
| celery_task_id | VARCHAR(100) | nullable |
