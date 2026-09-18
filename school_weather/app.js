// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
//  Get a FREE AirNow API key at: https://docs.airnowapi.org/account/request/
//  Replace the placeholder below with your key, then save & refresh.
// ─────────────────────────────────────────────────────────────────────────────
const AIRNOW_API_KEY = '1F7CFC6F-E45F-4123-90F0-C9E66AE25907';
const RYAN_HALL_CHANNEL_ID = 'UCJHAT3Uvv-g3I8H3GhHWV7w';

// ─────────────────────────────────────────────────────────────────────────────
//  LOCATION — default Minooka, IL (updated by search)
// ─────────────────────────────────────────────────────────────────────────────
let currentLocation = { lat: 41.4489, lon: -88.2620, label: 'Minooka, IL' };

// ─────────────────────────────────────────────────────────────────────────────
//  RADAR STATE
// ─────────────────────────────────────────────────────────────────────────────
const RADAR_WMS        = 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows';
const FRAME_INTERVAL_MS = 600;
const LOOP_PAUSE_MS     = 1200;

let radarMap        = null;
let radarFrames     = [];
let currentFrameIdx = 0;
let animPlaying     = true;
let animTimer       = null;
let alertPolygonsLayer = null;
let locationMarker  = null;

// ─────────────────────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────────────────────
(async function init() {
  const { lat, lon, label } = currentLocation;
  document.getElementById('location-display').textContent = `— ${label}`;
  initRadarMap(lat, lon);
  await Promise.all([
    loadAlerts(lat, lon),
    loadAqiPanel(lat, lon),
    loadCurrentConditions(lat, lon),
    loadForecast(lat, lon),
  ]);
  setLastUpdated();
  // Auto-refresh every 5 minutes using current location
  setInterval(async () => {
    const { lat, lon } = currentLocation;
    await Promise.all([loadAlerts(lat, lon), loadAqiPanel(lat, lon), loadCurrentConditions(lat, lon), loadForecast(lat, lon)]);
    setLastUpdated();
  }, 5 * 60 * 1000);
})();

function setLastUpdated() {
  document.getElementById('last-updated').textContent =
    'Last updated: ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RADAR MAP  (Leaflet + NOAA WMS animated loop)
// ─────────────────────────────────────────────────────────────────────────────
function initRadarMap(lat, lon) {
  radarMap = L.map('radar-map', { zoomControl: true }).setView([lat, lon], 8.5);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CartoDB',
    subdomains: 'abcd', maxZoom: 19
  }).addTo(radarMap);

  // Borders overlay
  L.tileLayer(
    'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { opacity: 0.4, attribution: 'Esri', zIndex: 10 }
  ).addTo(radarMap);

  // Location marker (on top)
  locationMarker = L.marker([lat, lon], { icon: makeLocationIcon(), zIndexOffset: 1000 })
    .addTo(radarMap).bindPopup(`📍 ${currentLocation.label}`).openPopup();

  loadRadarAnimation();

  // Move the tornado banner into the Leaflet map container so it
  // overlays only the map area (Leaflet already sets position:relative on it)
  radarMap.getContainer().appendChild(document.getElementById('tornado-banner'));
}

async function fetchRadarTimes() {
  const capUrl = RADAR_WMS +
    '?service=WMS&version=1.3.0&request=GetCapabilities';
  const resp = await fetch(capUrl);
  const text = await resp.text();
  const doc  = new DOMParser().parseFromString(text, 'text/xml');

  // Find <Dimension name="time"> or <Extent name="time">
  let timeStr = '';
  for (const tag of ['Dimension', 'Extent']) {
    for (const el of doc.querySelectorAll(tag)) {
      if ((el.getAttribute('name') || '').toLowerCase() === 'time') {
        timeStr = el.textContent.trim();
        break;
      }
    }
    if (timeStr) break;
  }
  if (!timeStr) throw new Error('No time dimension found in WMS capabilities');

  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  let times = [];

  if (timeStr.includes('/')) {
    // Range format: start/end/interval  (e.g. 2024-01-01T00:00:00Z/2024-01-01T12:00:00Z/PT2M)
    const parts    = timeStr.split('/');
    const start    = new Date(parts[0]);
    const end      = new Date(parts[1]);
    const stepMs   = parseIsoDuration(parts[2]);
    for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
      const d = new Date(t);
      if (d >= cutoff) times.push(d);
    }
  } else {
    // List format: comma-separated ISO timestamps
    times = timeStr.split(',')
      .map(s => new Date(s.trim()))
      .filter(d => !isNaN(d) && d >= cutoff);
  }

  return times.sort((a, b) => a - b);
}

function parseIsoDuration(iso) {
  // Parses PT#M, PT#S, PT#H, P#D (covers NWS radar intervals)
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 2 * 60 * 1000; // default 2 min
  const days  = parseInt(m[1] || 0);
  const hours = parseInt(m[2] || 0);
  const mins  = parseInt(m[3] || 0);
  const secs  = parseInt(m[4] || 0);
  return ((days * 86400) + (hours * 3600) + (mins * 60) + secs) * 1000;
}

async function loadRadarAnimation() {
  const msgEl = document.getElementById('radar-loading-msg');
  try {
    let times = await fetchRadarTimes();

    if (times.length === 0) {
      msgEl.textContent = 'No recent data';
      return;
    }

    msgEl.textContent = `Loading ${times.length} frames…`;
    const scrubber = document.getElementById('radar-scrubber');
    scrubber.max   = times.length - 1;
    scrubber.value = times.length - 1;

    // Build one WMS layer per timestamp and pre-add them all at opacity 0 so
    // tiles load in the background — no add/remove during animation = no flicker
    radarFrames = times.map(t => {
      const layer = L.tileLayer.wms(RADAR_WMS, {
        layers: 'conus_bref_qcd',
        format: 'image/png',
        transparent: true,
        opacity: 0,
        TIME: t.toISOString(),
        attribution: 'NOAA/NWS Radar',
        zIndex: 5
      });
      layer.addTo(radarMap);
      return { time: t, layer };
    });

    // Reveal the newest frame
    currentFrameIdx = radarFrames.length - 1;
    radarFrames[currentFrameIdx].layer.setOpacity(0.8);
    updateRadarUI();
    msgEl.textContent = '';

    startAnimation();
  } catch (e) {
    msgEl.textContent = '⚠️ Radar animation unavailable';
    console.error('Radar animation error:', e);
    // Fall back to static latest frame
    L.tileLayer.wms(RADAR_WMS, {
      layers: 'conus_bref_qcd', format: 'image/png',
      transparent: true, opacity: 0.75, attribution: 'NOAA/NWS Radar', zIndex: 5
    }).addTo(radarMap);
  }
}

function showFrame(idx) {
  if (!radarFrames.length) return;
  radarFrames[currentFrameIdx].layer.setOpacity(0);
  currentFrameIdx = idx;
  radarFrames[currentFrameIdx].layer.setOpacity(0.8);
  updateRadarUI();
}

function updateRadarUI() {
  const frame = radarFrames[currentFrameIdx];
  document.getElementById('radar-timestamp').textContent =
    frame.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('radar-scrubber').value = currentFrameIdx;
}

function startAnimation() {
  clearTimeout(animTimer);
  animPlaying = true;
  document.getElementById('radar-play-btn').textContent = '⏸';
  stepForward();
}

function stepForward() {
  if (!animPlaying || !radarFrames.length) return;
  const nextIdx = (currentFrameIdx + 1) % radarFrames.length;
  showFrame(nextIdx);
  // Pause longer on the newest (last) frame before looping
  const delay = nextIdx === radarFrames.length - 1 ? LOOP_PAUSE_MS : FRAME_INTERVAL_MS;
  animTimer = setTimeout(stepForward, delay);
}

function toggleAnimation() {
  if (animPlaying) {
    animPlaying = false;
    clearTimeout(animTimer);
    document.getElementById('radar-play-btn').textContent = '▶';
  } else {
    startAnimation();
  }
}

function scrubFrame(val) {
  animPlaying = false;
  clearTimeout(animTimer);
  document.getElementById('radar-play-btn').textContent = '▶';
  showFrame(parseInt(val));
}

// ─────────────────────────────────────────────────────────────────────────────
//  ALERT POLYGON OVERLAYS  (draws watch/warning areas on the radar map)
// ─────────────────────────────────────────────────────────────────────────────
function getAlertStyle(event) {
  const e = (event || '').toLowerCase();
  // Red for anything tornado
  if (e.includes('tornado'))             return '#ff2020';
  // Yellow for severe thunderstorm
  if (e.includes('severe thunderstorm')) return '#ffe000';
  // Green shades for flood
  if (e.includes('flash flood warning') || e.includes('flood warning')) return '#00e550';
  if (e.includes('flood'))               return '#2eb870';
  // Purple/pink for winter hazards
  if (e.includes('winter storm') || e.includes('blizzard') || e.includes('ice storm')) return '#cc77ff';
  // Orange for high-wind events
  if (e.includes('high wind') || e.includes('wind advisory')) return '#ff8800';
  return '#ffff00'; // default yellow
}

async function drawAlertPolygons(alerts) {
  if (!radarMap) return;
  if (!alertPolygonsLayer) {
    alertPolygonsLayer = L.featureGroup().addTo(radarMap);
  }
  alertPolygonsLayer.clearLayers();

  if (!alerts.length) return;

  // Collect all zone URLs we need for zone-based alerts (watches, etc.)
  const allZoneUrls = [];
  for (const f of alerts) {
    if (!f.geometry && f.properties.affectedZones) {
      for (const url of f.properties.affectedZones.slice(0, 12)) {
        if (!allZoneUrls.includes(url)) allZoneUrls.push(url);
      }
    }
  }

  // Fetch all zone geometries in parallel
  const zoneGeoms = {};
  if (allZoneUrls.length > 0) {
    await Promise.all(allZoneUrls.map(async url => {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } });
        zoneGeoms[url] = r.ok ? ((await r.json()).geometry || null) : null;
      } catch { zoneGeoms[url] = null; }
    }));
  }

  // Draw each alert
  for (const f of alerts) {
    const p      = f.properties;
    const color  = getAlertStyle(p.event || '');
    const isWatch = (p.event || '').toLowerCase().includes('watch');
    const layerStyle = {
      color, fillColor: color,
      weight: 2, opacity: 0.9, fillOpacity: 0.15,
      dashArray: isWatch ? '7,5' : null  // dashed outline for watches
    };
    const label = p.event || 'Alert';

    if (f.geometry) {
      L.geoJSON(f.geometry, { style: layerStyle })
        .bindTooltip(label, { sticky: true, className: 'alert-map-tooltip' })
        .addTo(alertPolygonsLayer);
    } else {
      for (const url of (p.affectedZones || []).slice(0, 12)) {
        if (zoneGeoms[url]) {
          L.geoJSON(zoneGeoms[url], { style: layerStyle })
            .bindTooltip(label, { sticky: true, className: 'alert-map-tooltip' })
            .addTo(alertPolygonsLayer);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ALERTS & HAZARDS  (NWS API — no key required)
// ─────────────────────────────────────────────────────────────────────────────
async function loadAlerts(lat, lon) {
  const el    = document.getElementById('alerts-body');
  const panel = document.getElementById('alerts-panel');
  try {
    const r = await fetch(
      `https://api.weather.gov/alerts/active?point=${lat},${lon}`,
      { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();
    const alerts = data.features || [];

    if (alerts.length === 0) {
      panel.style.display = 'none';
      drawAlertPolygons([]);
      document.getElementById('tornado-banner').classList.remove('active');
      return;
    }

    panel.style.display = '';
    drawAlertPolygons(alerts);

    const hasTornadoWarning = alerts.some(f =>
      (f.properties.event || '').toLowerCase().includes('tornado warning')
    );
    document.getElementById('tornado-banner').classList.toggle('active', hasTornadoWarning);

    el.innerHTML = alerts.map((f, i) => {
      const p        = f.properties;
      const severity = (p.severity || 'Unknown').toLowerCase();
      const cls      = ['extreme','severe','moderate','minor'].includes(severity) ? severity : 'unknown';
      const descId   = `alert-desc-${i}`;
      const full     = (p.description || '').replace(/\n+/g, ' ');
      return `
        <div class="alert-item ${cls}">
          <div class="alert-headline">${alertIcon(p.event)} ${p.headline || p.event || 'Alert'}</div>
          <div class="alert-meta">
            🔺 ${capitalize(p.severity || '—')} &nbsp;|&nbsp; 
            Effective: ${p.effective ? formatDate(p.effective) : '—'} &nbsp;|&nbsp;
            Expires: ${p.expires ? formatDate(p.expires) : '—'}
          </div>
          ${full ? `<button class="expand-btn" onclick="toggleDesc('${descId}', this)">Details ▾</button>
          <div class="alert-desc" id="${descId}" data-full="${escHtml(full)}"></div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    panel.style.display = '';
    el.innerHTML = `<div class="error-msg">⚠️ Could not load alerts: ${e.message}</div>`;
  }
}

function toggleDesc(id, btn) {
  const el = document.getElementById(id);
  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    btn.textContent = 'Details ▾';
  } else {
    el.textContent = el.dataset.full;  // populate on first open
    el.classList.add('expanded');
    btn.textContent = 'Details ▴';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AIR QUALITY  (AirNow API — free key required)
// ─────────────────────────────────────────────────────────────────────────────
const AQI_BANDS = [
  { max: 50,  cat: 'Good',                  cls: 'aqi-good',         emoji: '😊' },
  { max: 100, cat: 'Moderate',              cls: 'aqi-moderate',     emoji: '😐' },
  { max: 150, cat: 'Unhealthy for Some',    cls: 'aqi-usg',          emoji: '😷' },
  { max: 200, cat: 'Unhealthy',             cls: 'aqi-unhealthy',    emoji: '🤧' },
  { max: 300, cat: 'Very Unhealthy',        cls: 'aqi-very-unhealthy', emoji: '☠️' },
  { max: 500, cat: 'Hazardous',             cls: 'aqi-hazardous',    emoji: '⛔' },
];

function aqiBand(val) {
  for (const b of AQI_BANDS) if (val <= b.max) return b;
  return { cat: 'Unknown', cls: 'aqi-unknown', emoji: '❓' };
}

// ─────────────────────────────────────────────────────────────────────────────
//  YOUTUBE LIVE PLAYER  (IFrame API + auto-play keeper)
// ─────────────────────────────────────────────────────────────────────────────
let ytLivePlayer    = null;
let ytAutoPlayTimer = null;

// Called when switching away from live view
function stopLivePlayer() {
  clearInterval(ytAutoPlayTimer); ytAutoPlayTimer = null;
  if (ytLivePlayer) { try { ytLivePlayer.destroy(); } catch(e){} ytLivePlayer = null; }
  const livePanel = document.getElementById('live-panel');
  livePanel.style.display = 'none';
  document.getElementById('live-panel-body').innerHTML = '';
}

function initLivePlayer(videoId, title) {
  const livePanel = document.getElementById('live-panel');
  document.getElementById('live-panel-title').textContent = '📺 Ryan Hall Y\'all — Live Now';
  document.getElementById('live-panel-body').innerHTML = `
    <div class="live-embed-wrap">
      <div id="yt-live-player"></div>
    </div>
    <div class="live-label"><span class="live-dot"></span>${escHtml(title)}</div>`;
  livePanel.style.display = '';

  const setup = () => {
    ytLivePlayer = new YT.Player('yt-live-player', {
      videoId,
      playerVars: {
        autoplay: 1, mute: 0,
        cc_load_policy: 1,
        cc_lang_pref: 'en',
        rel: 0, modestbranding: 1,
      },
      events: {
        onReady(e) {
          e.target.playVideo();
          startAutoPlayKeeper();
        }
      }
    });
  };

  // YT API may already be ready (if page was loaded before)
  if (window.YT?.Player) { setup(); }
  else { window.onYouTubeIframeAPIReady = setup; }
}

// Check every 5 s — if paused/stopped, resume
function startAutoPlayKeeper() {
  clearInterval(ytAutoPlayTimer);
  ytAutoPlayTimer = setInterval(() => {
    if (!ytLivePlayer?.getPlayerState) return;
    const s = ytLivePlayer.getPlayerState();
    // 2=paused, 0=ended, -1=unstarted
    if (s === 2 || s === 0 || s === -1) ytLivePlayer.playVideo();
  }, 5000);
}

async function loadAqiPanel(lat, lon) {
  try {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${RYAN_HALL_CHANNEL_ID}`;
    const r = await fetch(
      `https://corsproxy.io/?${encodeURIComponent(feedUrl)}`,
      { cache: 'no-store' }
    );
    if (r.ok) {
      const xml   = await r.text();
      const doc   = new DOMParser().parseFromString(xml, 'text/xml');
      const entry = doc.querySelector('entry');
      if (entry) {
        const videoId = entry.querySelector('videoId')?.textContent?.trim();
        const title   = entry.querySelector('title')?.textContent || '';
        const updated = new Date(entry.querySelector('updated')?.textContent || 0);
        const ageHrs  = (Date.now() - updated.getTime()) / 3600000;
        const isLive  = title.includes('🔴') && ageHrs < 8;

        if (isLive && videoId) {
          initLivePlayer(videoId, title);
          await loadAirQuality(lat, lon);
          return;
        }
      }
    }
  } catch (e) {
    console.warn('Live stream check failed:', e);
  }

  // Not live — hide video panel and show air quality
  stopLivePlayer();
  await loadAirQuality(lat, lon);
}

async function loadAirQuality(lat, lon) {
  const el = document.getElementById('aqi-body');
  if (AIRNOW_API_KEY === 'YOUR_API_KEY_HERE') {
    el.innerHTML = `
      <div class="aqi-setup">
        <strong>🔑 Air Quality requires a free API key</strong><br><br>
        1. Visit <a href="https://docs.airnowapi.org/account/request/" target="_blank">docs.airnowapi.org</a> and request a free key (takes ~5 minutes).<br>
        2. Open <code>index.html</code> in a text editor.<br>
        3. Find the line: <code>const AIRNOW_API_KEY = 'YOUR_API_KEY_HERE';</code><br>
        4. Replace <code>YOUR_API_KEY_HERE</code> with your key and save.<br><br>
        📊 Air quality data is provided by <a href="https://www.airnow.gov" target="_blank">AirNow.gov</a> (EPA &amp; NOAA).
      </div>`;
    return;
  }

  try {
    const url =
      `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json` +
      `&latitude=${lat}&longitude=${lon}&distance=50&API_KEY=${AIRNOW_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    if (!Array.isArray(data) || data.length === 0) {
      el.innerHTML = `<div class="no-alerts">ℹ️ No air quality readings available near your location.</div>`;
      return;
    }

    el.innerHTML = `<div class="aqi-grid">` + data.map(obs => {
      const band = aqiBand(obs.AQI);
      return `
        <div class="aqi-card ${band.cls}">
          <div class="aqi-pollutant">${obs.ParameterName || 'AQI'}</div>
          <div class="aqi-value">${obs.AQI}</div>
          <div class="aqi-category">${band.emoji} ${band.cat}</div>
          <div class="aqi-area">${obs.ReportingArea || ''}</div>
        </div>`;
    }).join('') + `</div>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠️ Could not load air quality data: ${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CURRENT CONDITIONS  (NWS nearest observation station — no key required)
// ─────────────────────────────────────────────────────────────────────────────
async function loadCurrentConditions(lat, lon) {
  const el = document.getElementById('conditions-body');
  try {
    // Step 1: resolve grid + observation stations URL
    const pR = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    if (!pR.ok) throw new Error('Location not supported by NWS.');
    const pData = await pR.json();

    // Step 2: get nearest station
    const stR = await fetch(pData.properties.observationStations,
      { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    if (!stR.ok) throw new Error('Could not fetch stations.');
    const stData = await stR.json();
    const stationId = stData.features?.[0]?.properties?.stationIdentifier;
    const stationName = stData.features?.[0]?.properties?.name || '';
    if (!stationId) throw new Error('No nearby station found.');

    // Step 3: latest observation
    const obR = await fetch(
      `https://api.weather.gov/stations/${stationId}/observations/latest`,
      { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    if (!obR.ok) throw new Error('Could not fetch observation.');
    const ob = (await obR.json()).properties;

    const cToF = c => c != null ? (c * 9 / 5 + 32).toFixed(1) : null;
    const paToInHg = pa => pa != null ? (pa / 3386.39).toFixed(2) : null;
    const kmhToMph = k  => k  != null ? Math.round(k * 0.621371) : null;
    const degsToCardinal = d => {
      if (d == null) return null;
      const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      return dirs[Math.round(d / 22.5) % 16];
    };

    const tempF       = cToF(ob.temperature?.value);
    const dewF        = cToF(ob.dewpoint?.value);
    const humidity    = ob.relativeHumidity?.value != null
      ? Math.round(ob.relativeHumidity.value) + '%' : '—';
    const pressureInHg = paToInHg(ob.barometricPressure?.value);
    const windMph     = kmhToMph(ob.windSpeed?.value);
    const windDir     = degsToCardinal(ob.windDirection?.value);
    const windStr     = windMph != null
      ? (windDir ? `${windDir} ${windMph} mph` : `${windMph} mph`) : '—';
    const description = ob.textDescription || '';

    el.innerHTML = `
      <div class="conditions-grid">
        <div>
          <div class="conditions-temp">${tempF != null ? Math.round(tempF) : '—'}<sup>°F</sup></div>
          ${description ? `<div class="conditions-desc">${description}</div>` : ''}
        </div>
        <div class="conditions-stats">
          <div class="conditions-stat">
            <span class="conditions-label">💧 Humidity</span>
            <span class="conditions-value">${humidity}</span>
          </div>
          <div class="conditions-stat">
            <span class="conditions-label">🌫️ Dew Point</span>
            <span class="conditions-value">${dewF != null ? Math.round(dewF) + '°F' : '—'}</span>
          </div>
          <div class="conditions-stat">
            <span class="conditions-label">🔵 Pressure</span>
            <span class="conditions-value">${pressureInHg != null ? pressureInHg + ' inHg' : '—'}</span>
          </div>
          <div class="conditions-stat">
            <span class="conditions-label">💨 Wind</span>
            <span class="conditions-value">${windStr}</span>
          </div>
        </div>
      </div>
      <div class="conditions-station">📍 ${stationName} (${stationId})</div>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠️ Could not load conditions: ${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  7-DAY FORECAST  (NWS API — no key required)
// ─────────────────────────────────────────────────────────────────────────────
async function loadForecast(lat, lon) {
  const el = document.getElementById('forecast-body');
  try {
    // Step 1: resolve grid point
    const pR = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    if (!pR.ok) throw new Error('Location not supported by NWS (may be outside the US).');
    const pData = await pR.json();
    const forecastUrl = pData.properties.forecast;

    // Step 2: get forecast periods
    const fR = await fetch(forecastUrl, { headers: { 'User-Agent': 'JuniorHighWeatherStation/1.0' } });
    if (!fR.ok) throw new Error(fR.statusText);
    const fData = await fR.json();
    const periods = fData.properties.periods || [];

    // Group into day/night pairs; show up to 14 periods (7 days)
    el.innerHTML = `<div class="forecast-grid">` + periods.slice(0, 14).map(p => {
      const isDaytime = p.isDaytime;
      const tempClass = isDaytime ? 'high' : 'low';
      const label     = p.name; // "Tonight", "Monday", "Monday Night", etc.
      return `
        <div class="forecast-card">
          <div class="forecast-day">${label}</div>
          <img class="forecast-icon" src="${p.icon}" alt="${p.shortForecast}" title="${p.shortForecast}" />
          <div class="forecast-temp ${tempClass}">${p.temperature}°${p.temperatureUnit}</div>
          <div class="forecast-short">${p.shortForecast}</div>
        </div>`;
    }).join('') + `</div>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠️ Could not load forecast: ${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOCATION SEARCH
// ─────────────────────────────────────────────────────────────────────────────
function makeLocationIcon() {
  return L.divIcon({
    html: '<div style="background:#3a9bd5;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 6px rgba(58,155,213,0.8)"></div>',
    iconSize: [14, 14], iconAnchor: [7, 7], className: ''
  });
}

function toggleSearch() {
  const wrap = document.getElementById('search-wrap');
  const opening = wrap.classList.toggle('open');
  if (opening) {
    document.getElementById('search-input').focus();
  } else {
    document.getElementById('search-status').textContent = '';
  }
}

// Close search on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('search-wrap').classList.remove('open');
    document.getElementById('search-status').textContent = '';
  }
});

async function doLocationSearch(e) {
  e.preventDefault();
  const query  = document.getElementById('search-input').value.trim();
  const status = document.getElementById('search-status');
  if (!query) return false;

  status.textContent = 'Searching…';
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'JuniorHighWeatherStation/1.0' } }
    );
    const results = await r.json();
    if (!results.length) { status.textContent = '⚠️ Location not found'; return false; }

    const { lat, lon, display_name } = results[0];
    // Build a short label: "City, State" from the full display_name
    const parts = display_name.split(',');
    const label = parts.slice(0, 2).map(s => s.trim()).join(', ');

    document.getElementById('search-wrap').classList.remove('open');
    document.getElementById('search-input').value = '';
    status.textContent = '';

    await goToLocation(parseFloat(lat), parseFloat(lon), label);
  } catch (err) {
    status.textContent = '⚠️ Search failed';
  }
  return false;
}

async function goToLocation(lat, lon, label) {
  currentLocation = { lat, lon, label };
  document.getElementById('location-display').textContent = `— ${label}`;

  radarMap.setView([lat, lon], 7);
  if (locationMarker) locationMarker.remove();
  locationMarker = L.marker([lat, lon], { icon: makeLocationIcon(), zIndexOffset: 1000 })
    .addTo(radarMap).bindPopup(`📍 ${label}`).openPopup();

  await Promise.all([
    loadAlerts(lat, lon),
    loadAqiPanel(lat, lon),
    loadCurrentConditions(lat, lon),
    loadForecast(lat, lon),
  ]);
  setLastUpdated();
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function alertIcon(event) {
  const e = (event || '').toLowerCase();
  if (e.includes('tornado'))                          return '🌪️';
  if (e.includes('flood watch'))                      return '🌊';
  if (e.includes('flood warning') || e.includes('flood advisory')) return '🌊';
  if (e.includes('flood'))                            return '🌊';
  if (e.includes('severe thunderstorm'))              return '⛈️';
  if (e.includes('thunderstorm'))                     return '🌩️';
  if (e.includes('hurricane') || e.includes('typhoon')) return '🌀';
  if (e.includes('tropical storm'))                   return '🌀';
  if (e.includes('winter storm') || e.includes('blizzard')) return '❄️';
  if (e.includes('snow') || e.includes('ice'))        return '🌨️';
  if (e.includes('wind'))                             return '💨';
  if (e.includes('fog'))                              return '🌫️';
  if (e.includes('fire') || e.includes('red flag'))   return '🔥';
  if (e.includes('heat'))                             return '🌡️';
  if (e.includes('freeze') || e.includes('frost'))    return '🥶';
  return '⚠️';
}

function formatDate(iso) {
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
