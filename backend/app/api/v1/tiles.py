"""타일 프록시 라우터.

GET /api/v1/tiles/vworld/{layer}/{z}/{x}/{y}
    → V-World WMTS 타일 프록시 (API 키 서버사이드 보호)

GET /api/v1/tiles/terrain/{z}/{x}/{y}
    → AWS Terrain Tiles (Terrarium RGB 인코딩, 무료)
"""

import httpx
from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import Response
from pathlib import Path as FilePath

from app.core.config import settings

router = APIRouter()

# 글로벌 HTTP 클라이언트 (커넥션 풀 유지로 성능 최적화)
http_client = httpx.AsyncClient(timeout=30.0)

# 로컬 디스크 캐시 경로 설정
CACHE_DIR = FilePath("data/tile_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

_VWORLD_LAYERS = frozenset({"Satellite", "Hybrid", "Base", "gray", "midnight"})
_TILE_EXT: dict[str, str] = {
    "Satellite": "jpeg",
    "Hybrid":    "png",
    "Base":      "png",
    "gray":      "png",
    "midnight":  "png",
}

# AWS Terrain Tiles — Terrarium 인코딩, API 키 불필요
_TERRAIN_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
_OSM_BASE = "https://tile.openstreetmap.org"


async def _osm_base_tile(z: int, x: int, y: int) -> Response:
    cache_path = CACHE_DIR / "osm" / str(z) / str(x) / f"{y}.png"
    if cache_path.exists():
        try:
            content = cache_path.read_bytes()
            if len(content) > 0:
                return Response(
                    content=content,
                    media_type="image/png",
                    headers={
                        "Cache-Control": "public, max-age=86400, s-maxage=3600, stale-while-revalidate=604800",
                        "X-Tile-Source": "OSM-Cache",
                    },
                )
        except Exception:
            pass

    r = await http_client.get(
        f"{_OSM_BASE}/{z}/{x}/{y}.png",
        headers={"User-Agent": "GeoBIM-Stratum/0.1"},
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"OSM upstream HTTP {r.status_code}")

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(r.content)
    except Exception:
        pass

    return Response(
        content=r.content,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=86400, s-maxage=3600, stale-while-revalidate=604800",
            "X-Tile-Source": "OSM",
        },
    )


@router.get("/vworld/{layer}/{z}/{x}/{y}", name="vworld_tile")
async def vworld_tile(
    layer: str = Path(..., description="V-World 레이어 (Satellite|Hybrid|Base|gray|midnight)"),
    z: int = Path(..., ge=0, le=20),
    x: int = Path(..., ge=0),
    y: int = Path(..., ge=0),
) -> Response:
    """V-World WMTS 타일 프록시.

    클라이언트는 API 키를 절대 볼 수 없음 — 서버에서만 환경변수 참조.
    캐시: 브라우저 24h / CDN 1h / stale-while-revalidate 7d.
    """
    if layer not in _VWORLD_LAYERS:
        raise HTTPException(status_code=400, detail=f"Invalid layer '{layer}'. Allowed: {sorted(_VWORLD_LAYERS)}")

    api_key = getattr(settings, "vworld_api_key", None)
    if not api_key:
        if layer == "Base":
            return await _osm_base_tile(z, x, y)
        raise HTTPException(status_code=500, detail="VWORLD_API_KEY 가 설정되지 않았습니다.")

    ext = _TILE_EXT[layer]
    content_type = "image/jpeg" if layer == "Satellite" else "image/png"

    # 1. 로컬 디스크 캐시 확인
    cache_path = CACHE_DIR / "vworld" / layer / str(z) / str(x) / f"{y}.{ext}"
    if cache_path.exists():
        try:
            content = cache_path.read_bytes()
            if len(content) > 0:
                return Response(
                    content=content,
                    media_type=content_type,
                    headers={
                        "Cache-Control": "public, max-age=86400, s-maxage=3600, stale-while-revalidate=604800",
                        "X-Tile-Source": "V-World-Cache",
                    },
                )
        except Exception:
            pass

    # 2. 캐시가 없을 시 원격 V-World 서버에 요청
    base = getattr(settings, "vworld_api_base", "https://api.vworld.kr")
    url = f"{base}/req/wmts/1.0.0/{api_key}/{layer}/{z}/{y}/{x}.{ext}"

    try:
        r = await http_client.get(url, headers={"User-Agent": "GeoBIM-Stratum/0.1"})
    except httpx.TimeoutException:
        if layer == "Base":
            return await _osm_base_tile(z, x, y)
        raise HTTPException(status_code=504, detail="V-World 응답 시간 초과")
    except httpx.RequestError as e:
        if layer == "Base":
            return await _osm_base_tile(z, x, y)
        raise HTTPException(status_code=502, detail=f"V-World 요청 오류: {e}")

    if not r.is_success:
        if layer == "Base":
            return await _osm_base_tile(z, x, y)
        raise HTTPException(
            status_code=502,
            detail=f"V-World upstream HTTP {r.status_code}",
        )

    response_content_type = r.headers.get("content-type", "image/png")

    # V-World가 XML 에러 문서를 반환하는 경우 차단
    if "xml" in response_content_type.lower() or r.content[:5] == b"<?xml":
        if layer == "Base":
            return await _osm_base_tile(z, x, y)
        raise HTTPException(status_code=404, detail="Tile not available (V-World returned XML error)")

    # 3. 수신 완료 시 로컬 디스크에 캐시 기록
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(r.content)
    except Exception:
        pass

    return Response(
        content=r.content,
        media_type=response_content_type,
        headers={
            "Cache-Control": "public, max-age=86400, s-maxage=3600, stale-while-revalidate=604800",
            "X-Tile-Source": "V-World",
        },
    )


@router.get("/terrain/{z}/{x}/{y}", name="terrain_tile")
async def terrain_tile(
    z: int = Path(..., ge=0, le=14),
    x: int = Path(..., ge=0),
    y: int = Path(..., ge=0),
) -> Response:
    """AWS Terrain Tiles 프록시 (Terrarium RGB 인코딩).

    표고(m) = R*256 + G + B/256 - 32768
    zoom 0~14, 해상도 256px 타일.
    """
    # 1. 로컬 디스크 캐시 확인
    cache_path = CACHE_DIR / "terrain" / str(z) / str(x) / f"{y}.png"
    if cache_path.exists():
        try:
            content = cache_path.read_bytes()
            if len(content) > 0:
                return Response(
                    content=content,
                    media_type="image/png",
                    headers={
                        "Cache-Control": "public, max-age=604800",
                        "X-Tile-Source": "AWS-Terrain-Cache",
                        "Access-Control-Allow-Origin": "*",
                    },
                )
        except Exception:
            pass

    # 2. 캐시가 없을 시 원격 AWS S3에 요청
    url = f"{_TERRAIN_BASE}/{z}/{x}/{y}.png"

    try:
        r = await http_client.get(url, headers={"User-Agent": "GeoBIM-Stratum/0.1"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="지형 타일 응답 시간 초과")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"지형 타일 요청 오류: {e}")

    if not r.is_success:
        raise HTTPException(
            status_code=502,
            detail=f"Terrain upstream HTTP {r.status_code}",
        )

    # 3. 수신 완료 시 로컬 디스크에 캐시 기록
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(r.content)
    except Exception:
        pass

    return Response(
        content=r.content,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=604800",
            "X-Tile-Source": "AWS-Terrain",
            "Access-Control-Allow-Origin": "*",
        },
    )
