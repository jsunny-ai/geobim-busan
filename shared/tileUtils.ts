// Web Mercator 타일 좌표 헬퍼 함수
export function lngToWorldX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 256 * Math.pow(2, z);
}

export function latToWorldY(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
}

/** bbox 영역의 V-World 타일을 합성 + crop → HTMLCanvasElement */
export async function buildAreaCanvas(
  bbox: [number, number, number, number],
  layers: string[],
): Promise<HTMLCanvasElement> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  let zoom = 19;
  while (zoom > 10) {
    const txCount =
      Math.floor(lngToWorldX(maxLng, zoom) / 256) -
      Math.floor(lngToWorldX(minLng, zoom) / 256) + 1;
    const tyCount =
      Math.floor(latToWorldY(minLat, zoom) / 256) -
      Math.floor(latToWorldY(maxLat, zoom) / 256) + 1;
    if (txCount * tyCount <= 100) break;
    zoom--;
  }

  const wxMin = lngToWorldX(minLng, zoom);
  const wxMax = lngToWorldX(maxLng, zoom);
  const wyMin = latToWorldY(maxLat, zoom);
  const wyMax = latToWorldY(minLat, zoom);
  const txMin = Math.floor(wxMin / 256), txMax = Math.floor(wxMax / 256);
  const tyMin = Math.floor(wyMin / 256), tyMax = Math.floor(wyMax / 256);

  const grid = document.createElement('canvas');
  grid.width = (txMax - txMin + 1) * 256;
  grid.height = (tyMax - tyMin + 1) * 256;
  const gctx = grid.getContext('2d')!;
  gctx.fillStyle = '#e8e8e8';
  gctx.fillRect(0, 0, grid.width, grid.height);

  const loadTile = (layer: string, x: number, y: number) =>
    new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `/api/v1/tiles/vworld/${layer}/${zoom}/${x}/${y}`;
    });

  for (const layer of layers) {
    const jobs: Promise<void>[] = [];
    for (let tx = txMin; tx <= txMax; tx++)
      for (let ty = tyMin; ty <= tyMax; ty++)
        jobs.push(loadTile(layer, tx, ty).then((img) => {
          if (img) gctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256);
        }));
    await Promise.all(jobs);
  }

  const cropX = wxMin - txMin * 256;
  const cropY = wyMin - tyMin * 256;
  const cropW = Math.max(1, Math.round(wxMax - wxMin));
  const cropH = Math.max(1, Math.round(wyMax - wyMin));
  const out = document.createElement('canvas');
  out.width = cropW; out.height = cropH;
  out.getContext('2d')!.drawImage(grid, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return out;
}
