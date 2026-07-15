"""TM ??WGS84 醫뚰몴 蹂??紐⑤뱢.

?쒖닔 Python ?섏떇 寃쎈줈 (?묒? ?섏떇 湲곕컲):
  TM寃쎌쐞?꾨???xls (援?넗吏由ъ젙蹂댁썝 怨듦컻 李몄“ ?먮즺)
  - '!' ?쒗듃: TM(X,Y) ??寃쎌쐞??
  - '!!' ?쒗듃: 寃쎌쐞????TM(X,Y)

GRS80 怨꾩뿴(EPSG:5181/5183/5186/5187): ?쒖닔 Python 寃쎈줈留??ъ슜.
Bessel 怨꾩뿴(EPSG:5174/5176): ?쒖닔 Python?쇰줈 TM?묪essel 吏由ъ쥖??蹂????
    pyproj濡?Bessel?뭌GS84 7-?뚮씪誘명꽣 Helmert 蹂??
"""
import logging
import math
import re

logger = logging.getLogger(__name__)


# ===========================================================================
# 1. ??먯껜 諛?TM ?뚮씪誘명꽣 (?묒? Q???곸닔)
# ===========================================================================

class _TmParams:
    """TM ?ъ쁺 ?뚮씪誘명꽣 而⑦뀒?대꼫.

    ellipsoid : 'bessel' ?먮뒗 'grs80'
    central_meridian : ?ъ쁺 ?먯젏 寃쎈룄(째)
    false_northing   : ?먯젏 X(N) 媛?곗닔 (m)
    false_easting    : ?먯젏 Y(E) 媛?곗닔 (m)  ??怨좎젙 200000
    central_latitude : ?ъ쁺 ?먯젏 ?꾨룄(째)    ??怨좎젙 38
    scale_factor     : 異뺤쿃怨꾩닔              ??怨좎젙 1
    """

    def __init__(self, ellipsoid='grs80', central_meridian=127.0,
                 false_northing=500000.0, false_easting=200000.0,
                 central_latitude=38.0, scale_factor=1.0):

        # ?묒? Q1: ?λ컲寃?a
        # ?묒? Q2: ?명룊瑜?f
        if ellipsoid == 'bessel':
            self.a = 6377397.155
            self.f = 1.0 / 299.1528128
        else:  # grs80
            self.a = 6378137.0
            self.f = 1.0 / 298.257222101

        # ?묒? Q3: ?⑤컲寃?b = a*(1-f)
        self.b = self.a * (1.0 - self.f)
        # ?묒? Q9: ???댁떖瑜졖?e짼 = (a짼-b짼)/a짼
        self.e2 = (self.a**2 - self.b**2) / self.a**2
        # ?묒? Q10: ???댁떖瑜졖?e'짼 = (a짼-b짼)/b짼
        self.ep2 = (self.a**2 - self.b**2) / self.b**2
        # ?묒? Q12: e1 = (1-??1-e짼))/(1+??1-e짼))
        self.e1 = (1.0 - math.sqrt(1.0 - self.e2)) / (1.0 + math.sqrt(1.0 - self.e2))

        # ?묒? Q4: 異뺤쿃怨꾩닔 ko
        self.ko = scale_factor
        # ?묒? Q5: ?먯젏 X(N) 媛?곗닔
        self.fn = false_northing
        # ?묒? Q6: ?먯젏 Y(E) 媛?곗닔
        self.fe = false_easting
        # ?묒? Q7(=R7 蹂??: ?먯젏 ?꾨룄 ?o (radians)
        self.phi0 = math.radians(central_latitude)
        # ?묒? Q8(=R8 蹂??: ?먯젏 寃쎈룄 貫o (radians)
        self.lam0 = math.radians(central_meridian)

        # ?묒? Q11: ?먯젏?먯꽌???먯삤?좏샇 Mo
        e2, a, phi0 = self.e2, self.a, self.phi0
        self.Mo = a * (
            (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi0
            - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*phi0)
            + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*phi0)
            - (35*e2**3/3072) * math.sin(6*phi0)
        )


def _p(ellipsoid, lon0, fn, fe=200000.0, lat0=38.0, k=1.0):
    return _TmParams(
        ellipsoid=ellipsoid,
        central_meridian=lon0,
        false_northing=fn,
        false_easting=fe,
        central_latitude=lat0,
        scale_factor=k,
    )


# ?쒓뎅 醫뚰몴怨??꾨━??
_PRESETS = {
    # GRS80 湲곕컲 (?꾪뻾)
    'EPSG:5186': _p('grs80',   127.0,                600000.0),
    'EPSG:5187': _p('grs80',   129.0,                600000.0),
    'EPSG:5181': _p('grs80',   127.0,                500000.0),
    'EPSG:5183': _p('grs80',   129.0,                500000.0),
    # Bessel 湲곕컲 (援ы삎)
    'EPSG:5174': _p('bessel',  127.0028902777778,    500000.0),
    'EPSG:5176': _p('bessel',  129.0028902777778,    500000.0),
}

_GRS80_EPSG = {'EPSG:5181', 'EPSG:5183', 'EPSG:5186', 'EPSG:5187'}
_BESSEL_EPSG = {'EPSG:5174', 'EPSG:5176'}
_SUPPORTED_EPSG = ('EPSG:5186', 'EPSG:5187', 'EPSG:5181', 'EPSG:5183', 'EPSG:5174', 'EPSG:5176')


# ===========================================================================
# 2. ?쒖닔 Python TM 蹂??(?묒? ?섏떇 1:1 ???
# ===========================================================================

def tm_to_latlon(x_northing: float, y_easting: float,
                 params: _TmParams) -> tuple:
    """TM(X=Northing, Y=Easting) ??(?꾨룄째, 寃쎈룄째).

    ?묒? '!' ?쒗듃 ?????
      A = 蹂댁젙 ?먯삤?좏샇 M
      B = 珥덇린 ?뗮봽由고듃 ?꾨룄 ?1
      C = Bowring 蹂댁젙 ?뗮봽由고듃 ?꾨룄 ?1 (?뺤젙)
      D = ?먯삤??怨〓쪧諛섍꼍 R
      E = C1 = e'짼쨌cos짼?1
      F = T1 = tan짼?1
      G = 臾섏쑀??怨〓쪧諛섍꼍 N
      H = 臾댁감???숈꽌嫄곕━ D
      I = ?꾨룄(째)
      J = 寃쎈룄(째)
    """
    a, e2, ep2, e1, ko = params.a, params.e2, params.ep2, params.e1, params.ko
    fn, fe, Mo, lam0 = params.fn, params.fe, params.Mo, params.lam0

    # ?묒? A?? M = Mo + (X - FN) / ko
    M = Mo + (x_northing - fn) / ko

    # ?묒? B?? 珥덇린 ?뗮봽由고듃 ?꾨룄
    phi1_init = M / (a * (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256))

    # ?묒? C?? Bowring 湲됱닔 蹂댁젙
    phi1 = (phi1_init
            + (3*e1/2    - 27*e1**3/32)  * math.sin(2*phi1_init)
            + (21*e1**2/16 - 55*e1**4/32) * math.sin(4*phi1_init)
            + (151*e1**3/96)              * math.sin(6*phi1_init)
            + (1097*e1**4/512)            * math.sin(8*phi1_init))

    # ?묒? D?? ?먯삤??怨〓쪧諛섍꼍 R
    R = (a * (1 - e2)) / (1 - e2 * math.sin(phi1)**2) ** 1.5

    # ?묒? E?? C1
    C = ep2 * math.cos(phi1)**2

    # ?묒? F?? T1
    T = math.tan(phi1)**2

    # ?묒? G?? 臾섏쑀??怨〓쪧諛섍꼍 N
    N = a / math.sqrt(1 - e2 * math.sin(phi1)**2)

    # ?묒? H?? D (臾댁감???숈꽌 嫄곕━)
    D = (y_easting - fe) / (N * ko)

    # ?묒? I?? ?꾨룄 (??
    lat_rad = (phi1
               - (N * math.tan(phi1) / R)
               * (  D**2 / 2
                  - D**4 / 24 * (5 + 3*T + 10*C - 4*C**2 - 9*ep2)
                  + D**6 / 720 * (61 + 90*T + 298*C + 45*T**2 - 252*ep2 - 3*C**2)))

    # ?묒? J?? 寃쎈룄 (?? ??10.405" 蹂댁젙 ?놁쓬 (N13=FALSE)
    lon_deg = (math.degrees(lam0)
               + math.degrees(
                   (1.0 / math.cos(phi1))
                   * (  D
                      - D**3 / 6   * (1 + 2*T + C)
                      + D**5 / 120 * (5 - 2*C + 28*T - 3*C**2 + 8*ep2 + 24*T**2))))

    return math.degrees(lat_rad), lon_deg


def latlon_to_tm(lat_deg: float, lon_deg: float,
                 params: _TmParams) -> tuple:
    """(?꾨룄째, 寃쎈룄째) ??TM(X=Northing, Y=Easting).

    ?묒? '!!' ?쒗듃 ?????
      A = ? (radians)
      B = 貫 (radians)
      C = T = tan짼?
      D = C = e'짼쨌cos짼?
      E = A_val = (貫-貫o)쨌cos?
      F = N (臾섏쑀??怨〓쪧諛섍꼍)
      G = M (?먯삤?좏샇)
      H = X(N)
      I = Y(E)
    """
    a, e2, ep2, ko = params.a, params.e2, params.ep2, params.ko
    fn, fe, Mo, lam0 = params.fn, params.fe, params.Mo, params.lam0

    # ?묒? A?? ? (rad)
    phi = math.radians(lat_deg)

    # ?묒? B?? 貫 (rad) ??10.405" 蹂댁젙 ?놁쓬
    lam = math.radians(lon_deg)

    # ?묒? C?? T = tan짼?
    T = math.tan(phi)**2

    # ?묒? D?? C = e짼/(1-e짼) 쨌 cos짼?  [= e'짼쨌cos짼?]
    C = (e2 / (1 - e2)) * math.cos(phi)**2

    # ?묒? E?? A_val = (貫 - 貫o) 쨌 cos?
    A_val = (lam - lam0) * math.cos(phi)

    # ?묒? F?? N (臾섏쑀??怨〓쪧諛섍꼍)
    N = a / math.sqrt(1 - e2 * math.sin(phi)**2)

    # ?묒? G?? ?먯삤?좏샇 M
    M = a * (
        (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * phi
        - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*phi)
        + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*phi)
        - 35*e2**3/3072 * math.sin(6*phi)
    )

    # ?묒? H?? X(N)
    x_northing = (fn + ko * (
        M - Mo
        + N * math.tan(phi) * (
              A_val**2 / 2
            + A_val**4 / 24  * (5 - T + 9*C + 4*C**2)
            + A_val**6 / 720 * (61 - 58*T + T**2 + 600*C - 330*ep2)
        )
    ))

    # ?묒? I?? Y(E)
    y_easting = (fe + ko * N * (
          A_val
        + A_val**3 / 6   * (1 - T + C)
        + A_val**5 / 120 * (5 - 18*T + T**2 + 72*C - 58*ep2)
    ))

    return x_northing, y_easting


# ===========================================================================
# 3. Bessel ??WGS84 Helmert 蹂??(pyproj ?꾩엫, GRS80 遺덊븘??
# ===========================================================================

_bessel_transformers = {}
try:
    from pyproj import Transformer
    for _epsg in _BESSEL_EPSG:
        _bessel_transformers[_epsg] = Transformer.from_crs(
            _PRESETS[_epsg].__dict__.get('_proj_str', _epsg),
            'EPSG:4326', always_xy=True
        )
    _bessel_transformers = {}  # reset ??use proj string directly below
    for _epsg in _BESSEL_EPSG:
        _bessel_transformers[_epsg] = Transformer.from_crs(_epsg, 'EPSG:4326', always_xy=True)

    # WGS84 ??EPSG:5186 (tm_x/tm_y ??궛??
    _to_5186 = Transformer.from_crs('EPSG:4326', 'EPSG:5186', always_xy=True)
    _pyproj_ok = True
except Exception as _e:
    logger.warning(f"pyproj unavailable; using pure Python Bessel fallback: {_e}")
    _pyproj_ok = False

from pdf_convert.core.spatial_validator import SpatialValidator
_validator = SpatialValidator()


# ===========================================================================
# 4. 怨듦컻 API
# ===========================================================================

def normalize_coordinates(
    x_val,
    y_val,
    borehole_id='Unknown',
    source_crs=None,
    coordinate_order=None,
):
    """TM ?먮뒗 WGS84 ?낅젰 醫뚰몴瑜?WGS84(lon, lat)濡??뺢퇋??

    Parameters
    ----------
    x_val : str | float   寃쎈룄/X(N) ?먯떆媛?
    y_val : str | float   ?꾨룄/Y(E) ?먯떆媛?
    borehole_id : str     濡쒓렇 ?앸퀎??
    source_crs  : str     臾몄꽌?먯꽌 異붿텧??EPSG 肄붾뱶 (?? 'EPSG:5186')

    Returns
    -------
    (lon_wgs84, lat_wgs84, tm_x, tm_y, final_epsg)  ???ㅽ뙣 ??('','','','', epsg)
    """
    # --- ?낅젰 ?뺢퇋??---
    try:
        if not x_val or not y_val:
            return '', '', '', '', source_crs or 'UNKNOWN'
        x_str = re.sub(r'[^\d.\-]', '', str(x_val).replace(',', '').strip())
        y_str = re.sub(r'[^\d.\-]', '', str(y_val).replace(',', '').strip())
        if not x_str or not y_str:
            return '', '', '', '', source_crs or 'UNKNOWN'
        x = float(x_str)
        y = float(y_str)
    except Exception:
        return '', '', '', '', source_crs or 'UNKNOWN'

    source_crs = _normalize_source_crs(source_crs, x, y)
    lon_wgs84 = lat_wgs84 = None
    final_epsg = source_crs or 'UNKNOWN'

    # [Scale Error 蹂댁젙] ?숇??먯젏(lon_0=129)? ?쒖쇅
    _DONGBU = ('EPSG:5187', 'EPSG:5183', 'EPSG:5176')
    if x < 30000 and source_crs != 'WGS84' and source_crs not in _DONGBU:
        x *= 10

    # --- WGS84 吏곸젒 ?낅젰 ---
    if source_crs == 'WGS84':
        lon_wgs84, lat_wgs84 = x, y

    # --- GRS80 TM ??WGS84 (?쒖닔 Python, ?묒? ?섏떇) ---
    elif source_crs in _GRS80_EPSG:
        params = _PRESETS[source_crs]
        try:
            if coordinate_order == 'easting_northing':
                lat_wgs84, lon_wgs84 = tm_to_latlon(y, x, params)
            else:
                lon_wgs84, lat_wgs84 = _best_grs80_candidate(x, y, params)
        except Exception as e:
            logger.error(f'[GRS80 蹂???ㅽ뙣: {borehole_id}] {e}')

    # --- Bessel TM ??WGS84 (pyproj Helmert 蹂?? ---
    elif source_crs in _BESSEL_EPSG:
        try:
            if coordinate_order == 'easting_northing' and _pyproj_ok:
                lon_wgs84, lat_wgs84 = _bessel_transformers[source_crs].transform(x, y)
            elif coordinate_order == 'easting_northing':
                lat_bessel, lon_bessel = tm_to_latlon(y, x, _PRESETS[source_crs])
                lon_wgs84, lat_wgs84 = _bessel_to_wgs84(lon_bessel, lat_bessel)
            elif _pyproj_ok:
                lon_wgs84, lat_wgs84 = _best_pyproj_candidate(x, y, _bessel_transformers[source_crs])
            else:
                lon_wgs84, lat_wgs84 = _best_bessel_candidate(x, y, _PRESETS[source_crs])
        except Exception as e:
            logger.error(f'[Bessel 蹂???ㅽ뙣: {borehole_id}] {e}')

    # --- CRS 誘명솗?? Northing ?섏튂濡?異붿젙 ---
    elif source_crs is None and max(x, y) > 100000:
        try:
            lon_wgs84, lat_wgs84, inferred = _best_auto_epsg_candidate(x, y)
            final_epsg = f'{inferred}_INFERRED' if inferred else 'UNKNOWN'
        except Exception as e:
            logger.error(f'[Auto CRS conversion failed: {borehole_id}] {e}')

    else:
        logger.warning(f'[Missing CRS: {borehole_id}] 醫뚰몴怨?誘명솗????WGS84 蹂???앸왂.')

    # --- ??궛: WGS84 ??EPSG:5186 TM (tm_x, tm_y) ---
    tm_x = tm_y = ''
    if lon_wgs84 is not None and lat_wgs84 is not None:
        try:
            if _pyproj_ok:
                _tx, _ty = _to_5186.transform(lon_wgs84, lat_wgs84)
            else:
                _ty, _tx = latlon_to_tm(lat_wgs84, lon_wgs84, _PRESETS['EPSG:5186'])
            tm_x = round(_tx, 3)
            tm_y = round(_ty, 3)
            lon_wgs84 = round(lon_wgs84, 7)
            lat_wgs84 = round(lat_wgs84, 7)
        except Exception:
            pass
    else:
        lon_wgs84 = lat_wgs84 = ''

    return lon_wgs84, lat_wgs84, tm_x, tm_y, final_epsg


def _normalize_source_crs(source_crs, x=None, y=None):
    if source_crs is None:
        return None

    text = str(source_crs).strip()
    if not text or text.upper() in {'N/A', 'UNKNOWN', 'NONE', 'NULL'}:
        return None

    upper = text.upper().replace(" ", "")
    if upper in {'EPSG:4326', 'EPSG4326', '4326'}:
        return 'WGS84'

    epsg_match = re.search(r'EPSG[:\s-]*(\d{4})', upper)
    if epsg_match:
        epsg = f'EPSG:{epsg_match.group(1)}'
        return epsg if epsg in _SUPPORTED_EPSG else None

    bare_epsg_match = re.search(r'\b(\d{4})\b', upper)
    if bare_epsg_match:
        epsg = f'EPSG:{bare_epsg_match.group(1)}'
        return epsg if epsg in _SUPPORTED_EPSG else None

    if 'WGS84' in upper or 'WGS-84' in upper or '경위도' in text:
        return 'WGS84'

    is_grs80 = 'GRS80' in upper or 'GRS-80' in upper or '한국측지계2000' in text
    is_bessel = 'BESSEL' in upper or '베셀' in text or 'BESSEL1841' in upper
    if not is_grs80 and not is_bessel:
        return None

    if '서부' in text or '동해' in text:
        return None

    east_origin = '동부' in text
    false_600k = bool(re.search(r'60만|600,?000', text))
    false_500k = bool(re.search(r'50만|500,?000', text))

    if is_bessel:
        return 'EPSG:5176' if east_origin else 'EPSG:5174'

    if false_600k:
        return 'EPSG:5187' if east_origin else 'EPSG:5186'
    if false_500k:
        return 'EPSG:5183' if east_origin else 'EPSG:5181'

    if x is not None and y is not None:
        return 'EPSG:5187' if east_origin else 'EPSG:5186'

    return None


def _split_korean_tm_xy(x, y):
    """Return (X/Northing, Y/Easting) for Korean boring logs."""
    x_abs = abs(float(x))
    y_abs = abs(float(y))
    if 100000 <= x_abs <= 300000 and y_abs >= 300000:
        return x_abs, y_abs
    if 100000 <= y_abs <= 300000 and x_abs >= 300000:
        return y_abs, x_abs
    return (x_abs, y_abs) if x_abs < y_abs else (y_abs, x_abs)


def _is_korea_wgs84(lon, lat):
    return lon is not None and lat is not None and 124.0 <= lon <= 132.0 and 33.0 <= lat <= 39.0


def _coordinate_order_candidates(x, y):
    """Return plausible (easting, northing) candidates without assuming x<y is always true."""
    legacy = (float(x), float(y)) if float(x) < float(y) else (float(y), float(x))
    pairs = [legacy, (float(x), float(y)), (float(y), float(x))]

    ordered = []
    seen = set()
    for easting, northing in pairs:
        key = (round(easting, 6), round(northing, 6))
        if key in seen:
            continue
        ordered.append((easting, northing))
        seen.add(key)
    return ordered


def _candidate_score(lon, lat):
    if lon is None or lat is None:
        return -1000
    if not _is_korea_wgs84(lon, lat):
        return -100
    score = 10
    try:
        zone = _validator.classify(lon, lat)
        if zone == 'hard':
            score += 30
        elif zone == 'soft':
            score += 20
        elif zone == 'out_of_region':
            score += 5
    except Exception:
        pass
    return score


def _choose_best_candidate(candidates):
    valid = [item for item in candidates if item[0] is not None and item[1] is not None]
    if not valid:
        return None, None
    lon, lat, _score = max(valid, key=lambda item: item[2])
    return lon, lat


def _best_grs80_candidate(x, y, params):
    candidates = []
    for easting, northing in _coordinate_order_candidates(x, y):
        lat, lon = tm_to_latlon(northing, easting, params)
        candidates.append((lon, lat, _candidate_score(lon, lat)))
    return _choose_best_candidate(candidates)


def _best_pyproj_candidate(x, y, transformer):
    candidates = []
    for easting, northing in _coordinate_order_candidates(x, y):
        lon, lat = transformer.transform(easting, northing)
        candidates.append((lon, lat, _candidate_score(lon, lat)))
    return _choose_best_candidate(candidates)


def _bessel_to_wgs84(lon_deg, lat_deg, h=0.0):
    source = _TmParams('bessel')
    target = _TmParams('grs80')

    phi = math.radians(lat_deg)
    lam = math.radians(lon_deg)
    sin_phi = math.sin(phi)
    cos_phi = math.cos(phi)
    sin_lam = math.sin(lam)
    cos_lam = math.cos(lam)
    n = source.a / math.sqrt(1 - source.e2 * sin_phi**2)

    x = (n + h) * cos_phi * cos_lam
    y = (n + h) * cos_phi * sin_lam
    z = (n * (1 - source.e2) + h) * sin_phi

    dx, dy, dz = -145.907, 505.034, 685.756
    rx = math.radians(-1.162 / 3600.0)
    ry = math.radians(2.347 / 3600.0)
    rz = math.radians(1.592 / 3600.0)
    scale = 1 + 6.342e-6

    x2 = dx + scale * x - rz * y + ry * z
    y2 = dy + rz * x + scale * y - rx * z
    z2 = dz - ry * x + rx * y + scale * z

    p = math.hypot(x2, y2)
    lon = math.atan2(y2, x2)
    lat = math.atan2(z2, p * (1 - target.e2))
    for _ in range(8):
        n2 = target.a / math.sqrt(1 - target.e2 * math.sin(lat) ** 2)
        lat = math.atan2(z2 + target.e2 * n2 * math.sin(lat), p)

    return math.degrees(lon), math.degrees(lat)


def _best_bessel_candidate(x, y, params):
    candidates = []
    for easting, northing in _coordinate_order_candidates(x, y):
        lat, lon = tm_to_latlon(northing, easting, params)
        lon_wgs84, lat_wgs84 = _bessel_to_wgs84(lon, lat)
        candidates.append((lon_wgs84, lat_wgs84, _candidate_score(lon_wgs84, lat_wgs84)))
    return _choose_best_candidate(candidates)


def _best_auto_epsg_candidate(x, y):
    candidates = []

    for epsg in _SUPPORTED_EPSG:
        if epsg not in _GRS80_EPSG:
            continue
        params = _PRESETS[epsg]
        for easting, northing in _coordinate_order_candidates(x, y):
            try:
                lat, lon = tm_to_latlon(northing, easting, params)
                score = _candidate_score(lon, lat)
                candidates.append((lon, lat, epsg, score))
            except Exception:
                continue

    for epsg in _SUPPORTED_EPSG:
        if epsg not in _BESSEL_EPSG:
            continue
        for easting, northing in _coordinate_order_candidates(x, y):
            try:
                if _pyproj_ok:
                    transformer = _bessel_transformers.get(epsg)
                    if transformer is None:
                        continue
                    lon, lat = transformer.transform(easting, northing)
                else:
                    lat_bessel, lon_bessel = tm_to_latlon(northing, easting, _PRESETS[epsg])
                    lon, lat = _bessel_to_wgs84(lon_bessel, lat_bessel)
                score = _candidate_score(lon, lat)
                candidates.append((lon, lat, epsg, score))
            except Exception:
                continue

    valid = [item for item in candidates if item[0] is not None and item[1] is not None and item[3] >= 0]
    if not valid:
        return None, None, None

    lon, lat, epsg, _score = max(valid, key=lambda item: item[3])
    return lon, lat, epsg
