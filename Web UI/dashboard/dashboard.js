// Dynamic Configuration & Baselines
let alertThresholdVal = 50.0;
let currentGraphTension = 0.4;
let currentGraphWindow = 12;
let modelWeights = { pres: 40, hum: 20, light: 20, rain: 20 };
let sensorOffsets = { temp: 0, water: 0 };
let physicalMountHeight = 200;
let maxClearSkyLux = 65000;
let standardBasePressure = 1013;
let lastSeenTimestamp = null;
let currentSensorData = {
    temp: NaN,
    rainRate: 0,
    water: -1,
    light: -1,
    cloudCover: 0
};
let isFetchingForecast = false;

// Real-time splash dismissal: removes the loading overlay the instant the
// page is actually usable (auth resolved + first live snapshot rendered).
// Idempotent, so the responsive cap, the data handlers and the crash-net can
// all fire safely without double-running.
let __splashDone = false;
function dismissSplash() {
    if (__splashDone) return;
    __splashDone = true;
    if (window.SplashBar) window.SplashBar.fill();
    // Wait for the 100% fill transition (width 0.45s) to finish so the
    // user always sees the bar complete before the splash fades out.
    const bar = document.querySelector('.splash-loader-inner');
    const fillWait = bar
        ? (parseFloat(getComputedStyle(bar).transitionDuration) || 0.45) * 1000 + 60
        : 510;
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => splash.remove(), 400);
        }
    }, fillWait);
}
if (window.SplashBar) window.SplashBar.set(25); // main script executing

// Initialize Lucide Icons (guarded: if the CDN fails the page must still load)
if (typeof lucide !== 'undefined') lucide.createIcons();

// Throttled icon refresh for high-frequency paths (sensor ticks).
// Full-DOM scans every ~10s are wasteful; 2s coalescing keeps new
// dynamic icons appearing quickly without the per-tick cost.
let __lucideTimer = null;
function scheduleLucideRefresh() {
    if (__lucideTimer) return;
    __lucideTimer = setTimeout(() => {
        __lucideTimer = null;
        if (window.lucide) lucide.createIcons();
    }, 2000);
}

// Firebase is initialized by firebase-config.js

// UI Elements
const rainfallValue = document.getElementById('rainfall-value');
const rainRateValue = document.getElementById('rain-rate-value');
const rainIntensityBadge = document.getElementById('rain-intensity-badge');
const maxRainfall = document.getElementById('max-rainfall');
const lastUpdate = document.getElementById('last-update');
const locationNameDisplay = document.getElementById('location-name-display');
const mapLinkSidebar = document.getElementById('map-link-sidebar');
const mapLinkMobile = document.getElementById('map-link-mobile');
const stationMapEl = document.getElementById('station-map');
const stationMapPanel = document.getElementById('station-map-panel');
const stationMapPlaceholder = document.getElementById('station-map-placeholder');
const stationMapExternal = document.getElementById('station-map-external');
let stationMap = null;
let stationMapMarker = null;
let stationMapCoverage = null; // 800 m coverage circle
let stationMapReady = false;
const systemStatusText = document.getElementById('system-status-text');
const systemStatusDot = document.getElementById('system-status-dot');
const systemStatusTextDesktop = document.getElementById('system-status-text-desktop');
const systemStatusDotDesktop = document.getElementById('system-status-dot-desktop');
const systemStatusContainer = document.getElementById('system-status-container');
const systemStatusContainerDesktop = document.getElementById('system-status-container-desktop');

const tempEl = document.getElementById('temp-value');
const humidityEl = document.getElementById('humidity-value');
const pressureEl = document.getElementById('pressure-value');
const pressureTrendBadge = document.getElementById('pressure-trend-badge');
const lightEl = document.getElementById('light-value');
const cloudCoverEl = document.getElementById('cloud-cover-value');
const waterLevelEl = document.getElementById('water-level-value');
const waterRiseRateEl = document.getElementById('water-rise-rate-value');
let latestRiseRateUnit = 'cm/min';   // updated from weather/current (cm/min canonical vs cm/h display)
const dewPointEl = document.getElementById('dew-point-value');
const heatIndexEl = document.getElementById('heat-index-value');

const adminMessageDisplay = document.getElementById('admin-message-display');
const liveDateText = document.getElementById('live-date-text');

// ── Risk Tier & Emergency Quick Strip System ─────────────────────────────
let currentRiskTier = 'safe'; // safe | watch | warning | danger

const heroBannerEl = document.getElementById('hero-flood-banner');
const emergencyQuickStrip = document.getElementById('emergency-quick-strip');
const waterThresholdFill = document.getElementById('water-threshold-fill');
const aiGaugeArc = document.getElementById('ai-gauge-arc');
const aiGaugeScore = document.getElementById('ai-gauge-score');
const aiGaugeBox = document.getElementById('ai-risk-gauge');

function applyHeroTier(tier) {
    if (heroBannerEl) {
        heroBannerEl.classList.remove('tier-safe', 'tier-watch', 'tier-warning', 'tier-danger');
        heroBannerEl.classList.add(`tier-${tier}`);
    }
    const elevated = (tier === 'warning' || tier === 'danger');
    document.body.classList.toggle('risk-elevated', elevated);
    setAlertFavicon(tier);
    currentRiskTier = tier;
    renderEmergencyQuickStrip();
}

// ── Dynamic Alert Favicon (catches attention on background tabs) ──
const __originalFavicon = (document.querySelector('link[rel="icon"]') || {}).href || '';
let __alertFaviconCache = null;

function setAlertFavicon(tier) {
    if (tier === 'safe') {
        const link = document.querySelector('link[rel="icon"]');
        if (link && link.href !== __originalFavicon) link.href = __originalFavicon;
        return;
    }
    try {
        if (!__alertFaviconCache) {
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = tier === 'danger' ? '#dc2626' : '#f59e0b';
            ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 44px Arial';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('!', 32, 35);
            __alertFaviconCache = canvas.toDataURL('image/png');
        }
        let link = document.querySelector('link[rel="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        link.href = __alertFaviconCache;
    } catch (e) { /* canvas unavailable — ignore */ }
}

// ── Rain Threshold Bar ─────────────────────────────────────────
function updateRainThresholdBar(dailyRain) {
    const fill = document.getElementById('rain-threshold-fill');
    if (!fill) return;
    let pct = alertThresholdVal > 0 ? (dailyRain / alertThresholdVal) * 100 : 0;
    pct = Math.max(0, Math.min(100, pct));
    fill.style.width = pct + '%';
    fill.classList.remove('safe', 'warning', 'danger');
    if (pct >= 100) fill.classList.add('danger');
    else if (pct >= 50) fill.classList.add('warning');
    else fill.classList.add('safe');
}

// ── Dynamic Sensor System Notice ─────────────────────────────────
// Headline + explanation adapt to the highest-priority active state:
// stale sensor data > danger > warning > watch > normal. Refreshed on every
// dashboard data update and by the staleness monitor every 30 s.
let __adminAlertMessage = ''; // admin-configured L2 alert text (set in fetchAdminConfig)

// Human-friendly elapsed formatting: minutes → hours; past 24 h the caller
// shows the date/time of the last report instead ("Sat, Sep 6, 2:15 PM").
function formatReportElapsed(mins) {
    if (mins < 1) return 'under a minute';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return null;
}
function formatReportDate(d) {
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function updateSensorSystemNotice() {
    const panel = document.getElementById('system-notice-panel');
    const headline = document.getElementById('notice-headline');
    const explanation = document.getElementById('notice-explanation');
    if (!panel || !headline || !explanation) return;

    const grab = (id) => { const el = document.getElementById(id); return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''; };
    const minsAgo = lastSeenTimestamp ? Math.max(0, Math.round((Date.now() - lastSeenTimestamp.getTime()) / 60000)) : null;
    const elapsedText = minsAgo === null ? null : formatReportElapsed(minsAgo);
    const stale = !!(lastSeenTimestamp && (Date.now() - lastSeenTimestamp.getTime()) > STALE_THRESHOLD_MS);

    let type, head, text;
    if (stale) {
        type = 'notice-stale';
        head = 'Sensor Data Unavailable';
        text = elapsedText
            ? `The monitoring station has not reported for ${elapsedText}. The readings on this page may not reflect current conditions — please use extra caution around water and rely on official warnings until updates resume.`
            : `The monitoring station last reported on ${formatReportDate(lastSeenTimestamp)}. The readings on this page may not reflect current conditions — please use extra caution around water and rely on official warnings until updates resume.`;
    } else if (currentRiskTier === 'danger') {
        type = 'notice-danger';
        head = 'Flash Flood Emergency';
        text = `Water is rising rapidly (currently ${grab('water-rise-rate-value') || 'elevated'}) with ${grab('rainfall-value') || 'heavy'} of rain recorded today. Move to higher ground immediately and avoid flooded roads and waterways. Emergency SMS alerts are being sent to registered residents.`;
    } else if (currentRiskTier === 'warning') {
        type = 'notice-warning';
        head = 'Flood Warning — Prepare to Move';
        text = `Heavy rainfall is raising water levels (${grab('water-rise-rate-value') || 'rising'}). Residents in low-lying areas should prepare to evacuate, secure belongings, and stay tuned for further escalation.`;
    } else if (currentRiskTier === 'watch') {
        type = 'notice-watch';
        head = 'Flood Advisory — Rainfall Detected';
        text = `Rainfall has been recorded today (currently ${grab('rainfall-value') || 'light'}). The station is monitoring conditions continuously — no immediate action is needed, but stay alert for escalation.`;
    } else {
        type = 'notice-normal';
        head = 'All Systems Normal';
        const lastReportPart = minsAgo === null
            ? ''
            : (elapsedText ? ` (last report ${elapsedText} ago)` : ` (last report on ${formatReportDate(lastSeenTimestamp)})`);
        text = `The monitoring station is online${lastReportPart} and tracking rainfall, water level, and weather conditions continuously. No flood-related action is needed right now.`;
    }

    if (panel.dataset.noticeType !== type) {
        panel.className = panel.className.replace(/ ?notice-(normal|watch|warning|danger|stale)/g, '');
        panel.classList.add(type);
        panel.dataset.noticeType = type;
        headline.innerText = head;
    }
    explanation.innerText = text;

    // The quoted line below is the admin-configured Level-2 alert message —
    // it belongs only when an elevated state is active, otherwise it reads as
    // a contradiction next to the live state above.
    const adminLine = document.getElementById('admin-message-display');
    if (adminLine) {
        if ((type === 'notice-warning' || type === 'notice-danger') && __adminAlertMessage) {
            adminLine.innerText = `Official alert message: "${__adminAlertMessage}"`;
            adminLine.style.display = '';
        } else {
            adminLine.style.display = 'none';
        }
    }
}

// ── Relative "last update" label ───────────────────────────────
// LIVE tag shows how long ago the station last reported,
// escalating mins → hours → days → months
function formatRelativeUpdate(ts) {
    if (!ts || isNaN(ts.getTime())) return '--:--';
    const mins = Math.floor((Date.now() - ts.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hr ago' : ' hrs ago');
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    const months = Math.floor(days / 30);
    return months + (months === 1 ? ' month ago' : ' months ago');
}

// ── Stale Sensor Data Detection ────────────────────────────────
let __staleStateActive = false;
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes without reports

function checkDataFreshness() {
    const banner = document.getElementById('stale-data-banner');
    const isStale = lastSeenTimestamp && (Date.now() - lastSeenTimestamp.getTime()) > STALE_THRESHOLD_MS;
    if (banner) {
        banner.style.display = isStale ? 'flex' : 'none';
        if (isStale) {
            const mins = Math.max(0, Math.round((Date.now() - lastSeenTimestamp.getTime()) / 60000));
            const elapsedText = formatReportElapsed(mins);
            const textEl = document.getElementById('stale-data-text');
            if (textEl) {
                textEl.innerText = elapsedText
                    ? `Sensor data may be outdated — no reports received for ${elapsedText}. Do not rely on these readings during a storm.`
                    : `Sensor data may be outdated — no reports since ${formatReportDate(lastSeenTimestamp)}. Do not rely on these readings during a storm.`;
            }
        }
    }
    if (isStale !== __staleStateActive) {
        __staleStateActive = isStale;
    }
    updateSensorSystemNotice();

    // Keep the LIVE tag ticking as relative time (mins → hrs → days → months)
    if (lastUpdate) lastUpdate.innerText = formatRelativeUpdate(lastSeenTimestamp);
}
setInterval(checkDataFreshness, 30000);

function updateWaterThresholdBar(water) {
    if (!waterThresholdFill) return;
    const capacity = Math.max(0, physicalMountHeight - 25); // highest measurable level (sensor height − 25 cm blind zone) // mirrors risk logic
    let pct = capacity > 0 ? (water / capacity) * 100 : 0;
    pct = Math.max(0, Math.min(100, pct));
    waterThresholdFill.style.width = pct + '%';
    waterThresholdFill.classList.remove('safe', 'warning', 'danger');
    if (pct >= 75) waterThresholdFill.classList.add('danger');
    else if (pct >= 50) waterThresholdFill.classList.add('warning');
    else waterThresholdFill.classList.add('safe');
}

function updateAiRiskGauge(score) {
    if (!aiGaugeArc || !aiGaugeScore) return;
    const clamped = Math.max(0, Math.min(10, score));
    const circumference = 2 * Math.PI * 19;
    aiGaugeArc.style.strokeDasharray = circumference.toFixed(1);
    aiGaugeArc.style.strokeDashoffset = (circumference * (1 - clamped / 10)).toFixed(1);
    aiGaugeScore.innerText = clamped.toFixed(1);
    if (aiGaugeBox) {
        aiGaugeBox.classList.remove('g-safe', 'g-warning', 'g-danger');
        if (clamped >= 6.5) aiGaugeBox.classList.add('g-danger');
        else if (clamped >= 3.5) aiGaugeBox.classList.add('g-warning');
        else aiGaugeBox.classList.add('g-safe');
    }
}

// Live directory data cache for the quick strip (populated by the
// emergency directory snapshot listener further below).
window.__brianeDirectoryCache = { hotlines: null, shelters: null };

function renderEmergencyQuickStrip() {
    if (!emergencyQuickStrip) return;
    const elevated = (currentRiskTier === 'warning' || currentRiskTier === 'danger');
    emergencyQuickStrip.style.display = elevated ? 'flex' : 'none';
    if (!elevated) return;

    const cache = window.__brianeDirectoryCache || {};
    const hotlineLink = document.getElementById('eqs-hotline-link');
    const hotlineLabel = document.getElementById('eqs-hotline-label');
    const shelterLabel = document.getElementById('eqs-shelter-label');

    if (Array.isArray(cache.hotlines) && cache.hotlines.length > 0 && hotlineLink && hotlineLabel) {
        const h = cache.hotlines.find(x => x.badgeClass === 'priority') || cache.hotlines[0];
        hotlineLink.href = `tel:${escapeHtmlAttr(h.callNumber || h.number || '')}`;
        hotlineLabel.innerText = h.org ? `Call ${h.org}` : 'Emergency Call';
    }
    if (Array.isArray(cache.shelters) && shelterLabel) {
        const openShelter = cache.shelters.find(s => s.status === 'open');
        if (openShelter && openShelter.name) {
            shelterLabel.innerText = openShelter.name.length > 26 ? openShelter.name.slice(0, 24) + '…' : openShelter.name;
        }
    }
}

// Live Date & Time Clock
function updateLiveDateTime() {
    if (!liveDateText) return;
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', options);
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    liveDateText.textContent = `${dateStr} • ${timeStr}`;
}
updateLiveDateTime();
setInterval(updateLiveDateTime, 1000);

// Navigation Logic
const navLinks = document.querySelectorAll('.nav-item[data-section], .bottom-nav-item[data-section]');
const sections = document.querySelectorAll('.dashboard-section');

function switchToSection(sectionId) {
    // Update Active Nav States
    navLinks.forEach(l => l.classList.remove('active'));
    document.querySelectorAll(`[data-section="${sectionId}"]`).forEach(l => l.classList.add('active'));

    // Switch View
    sections.forEach(s => s.classList.remove('active'));
    const targetSection = document.getElementById(`section-${sectionId}`);
    if (targetSection) targetSection.classList.add('active');

    // Fix for Chart.js layout bugs: force resize when section becomes visible
    if (sectionId === 'forecast') {
        triggerForecastLoad();
        loadWeeklyData();
    }

    // Ensure the embedded map renders when its section becomes active.
    if (sectionId === 'livemap' && currentLatitude !== 0 && currentLongitude !== 0) {
        updateStationMap(currentLatitude, currentLongitude);
        // Re-measure the map a few times: flex layout + the section-entrance
        // animation (translateY/opacity over ~0.45s) settle asynchronously, and
        // Leaflet only renders the viewport it measured at the last invalidate.
        resizeStationMap();
        setTimeout(resizeStationMap, 100);
        setTimeout(resizeStationMap, 400);
        setTimeout(resizeStationMap, 900);
    }

    setTimeout(() => {
        const allCharts = [
            chartRain, chartAtmo,
            detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart,
            detailedWaterChart, detailedLightChart,
            hourlyPrecipChart, weeklyRainChart
        ];
        allCharts.forEach(c => {
            if (c) {
                c.resize();
                c.update("none");
            }
        });
    }, 400);

    // Refresh icons for new view
    lucide.createIcons();
}

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const sectionId = link.getAttribute('data-section');
        switchToSection(sectionId);
    });
});

// Emergency Quick Strip: jump to the full directory
document.querySelectorAll('[data-goto-section]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        switchToSection(btn.getAttribute('data-goto-section'));
        const scrollArea = document.querySelector('.scroll-area');
        if (scrollArea) scrollArea.scrollTo({ top: 0, behavior: 'smooth' });
    });
});

// ── In-page Live Map ──────────────────────────────────────────────
// The sidebar "Live Map" and bottom-nav "Map" links are now
// data-section="livemap" items handled by the generic nav switcher, so
// this only wires the hero "Live Map" button into the same section.
function openStationMap() {
    switchToSection('livemap');
    if (currentLatitude !== 0 && currentLongitude !== 0) {
        updateStationMap(currentLatitude, currentLongitude);
    }
    resizeStationMap();
    setTimeout(resizeStationMap, 150);
    setTimeout(resizeStationMap, 450);
    const scrollArea = document.querySelector('.scroll-area');
    const panel = stationMapPanel || document.querySelector('.map-panel');
    if (panel && scrollArea) {
        setTimeout(() => {
            const rect = panel.getBoundingClientRect();
            const containerRect = scrollArea.getBoundingClientRect();
            const target = rect.top - containerRect.top + scrollArea.scrollTop - 12;
            try {
                scrollArea.scrollTo({ top: target, behavior: 'smooth' });
            } catch (err) {
                scrollArea.scrollTop = target;
            }
            setTimeout(resizeStationMap, 350);
        }, 60);
    }
}

// Re-measure the Leaflet map so tiles fill the (possibly grown/flexed)
// container. Leaflet keeps its own cached viewport size, so whenever the
// container's dimensions change we must tell it to invalidate and re-fit.
function resizeStationMap() {
    if (stationMap && typeof stationMap.invalidateSize === 'function') {
        try { stationMap.invalidateSize(); } catch (e) { /* non-critical */ }
    }
}

// The hero "Live Map" button was removed — the Monitoring Station location
// name itself is now the clickable link into the Live Map section.
if (locationNameDisplay) {
    locationNameDisplay.addEventListener('click', (e) => {
        e.preventDefault();
        openStationMap();
    });
}

// Keep the embedded map filling its container on viewport changes.
let resizeStationMapTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeStationMapTimer);
    resizeStationMapTimer = setTimeout(resizeStationMap, 120);
});
// Also re-fit after splash/scroll layout settles (initial page load).
document.addEventListener('DOMContentLoaded', () => setTimeout(resizeStationMap, 500));
setTimeout(resizeStationMap, 1500);


// Date/Time label helper for clean graph tooltips & x-axis ticks
function formatDateTimeLabel(date) {
    if (!date || isNaN(date.getTime())) date = new Date();
    const isToday = new Date().toDateString() === date.toDateString();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return timeStr;
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateStr}, ${timeStr}`;
}

// Downsamples a large array of historical entries to a clean target number of points (e.g. 30)
function downsampleHistoricalPoints(rawDocs, targetCount = 30) {
    if (!rawDocs || rawDocs.length <= targetCount) return rawDocs;
    const step = (rawDocs.length - 1) / (targetCount - 1);
    const sampled = [];
    for (let i = 0; i < targetCount; i++) {
        const index = Math.round(i * step);
        sampled.push(rawDocs[index]);
    }
    return sampled;
}

// Aggregates raw historical readings into ONE record per calendar day.
// Used by the Weekly (7D) / Monthly (30D) chart views so each day shows a single
// point instead of every raw reading. rainfall is a running daily total (per the
// device's flood logic), so the day's MAX represents that day's accumulation;
// all other metrics are averaged across the day's readings.
function aggregateHistoryByDay(rawDocs) {
    if (!rawDocs || rawDocs.length === 0) return rawDocs;

    const buckets = new Map();
    rawDocs.forEach(doc => {
        const time = parseFirestoreTimestamp(doc.timestamp);
        if (isNaN(time.getTime())) return;
        const dayKey = `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
        if (!buckets.has(dayKey)) buckets.set(dayKey, []);
        buckets.get(dayKey).push({ doc, time });
    });

    const aggregated = [];
    for (const entries of buckets.values()) {
        // entries are already in chronological order (rawHistory is sorted asc)
        const lastEntry = entries[entries.length - 1].doc;
        const numOf = (doc, fields) => {
            for (const f of fields) {
                if (doc[f] !== undefined && !isNaN(parseFloat(doc[f]))) return parseFloat(doc[f]);
            }
            return NaN;
        };
        const avgOf = (fields) => {
            let sum = 0, count = 0;
            entries.forEach(({ doc }) => {
                const v = numOf(doc, fields);
                if (!isNaN(v)) { sum += v; count++; }
            });
            return count > 0 ? sum / count : 0;
        };
        // waterLevel / lightLevel upload "-1" when the sensor read fails, so a
        // plain average would drag the day's value down with phantom negatives.
        // Skip any negative readings — they are failure sentinels, not real data.
        const levelAvgOf = (fields) => {
            let sum = 0, count = 0;
            entries.forEach(({ doc }) => {
                const v = numOf(doc, fields);
                if (!isNaN(v) && v >= 0) { sum += v; count++; }
            });
            return count > 0 ? sum / count : 0;
        };
        const maxOf = (fields) => {
            let max = 0;
            entries.forEach(({ doc }) => {
                const v = numOf(doc, fields);
                if (!isNaN(v)) max = Math.max(max, v);
            });
            return max;
        };

        aggregated.push({
            ...lastEntry,
            timestamp: lastEntry.timestamp,
            rainfall: maxOf(['rainfall']),
            temperature: avgOf(['temperature']),
            humidity: avgOf(['humidity']),
            pressure: avgOf(['pressure']),
            waterLevel: levelAvgOf(['waterLevel', 'water']),
            lightLevel: levelAvgOf(['lightLevel', 'light'])
        });
    }

    return aggregated;
}

// Charts Logic
const ctxRain = document.getElementById('mainRainfallChart')?.getContext('2d');
const chartRain = ctxRain ? new Chart(ctxRain, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Rainfall (mm)',
            data: [],
            borderColor: '#2c5f97',
            backgroundColor: 'rgba(44, 95, 151, 0.08)',
            fill: true,
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHitRadius: 14,
            pointHoverBackgroundColor: '#2c5f97',
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2.5,
            borderWidth: 2.5
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: true,
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#ffffff',
                bodyColor: '#cbd5e1',
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    label: function(context) {
                        return ` Rainfall: ${context.parsed.y.toFixed(2)} mm`;
                    }
                }
            }
        },
        scales: {
            y: { 
                beginAtZero: true, 
                grace: '5%',
                grid: { color: 'rgba(0,0,0,0.04)' }, 
                ticks: { font: { family: 'Outfit', weight: '600', size: 11 } } 
            },
            x: {
                grid: { display: false },
                ticks: {
                    maxTicksLimit: 6,
                    maxRotation: 0,
                    autoSkip: true,
                    font: { family: 'Outfit', weight: '600', size: 11 }
                }
            }
        }
    }
}) : null;

const ctxAtmo = document.getElementById('atmosphericChart')?.getContext('2d');
const chartAtmo = ctxAtmo ? new Chart(ctxAtmo, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Temp (°C)',
                data: [],
                borderColor: '#d97706',
                backgroundColor: 'rgba(217, 119, 6, 0.05)',
                fill: true,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                yAxisID: 'y',
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHitRadius: 14,
                pointHoverBackgroundColor: '#d97706',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2.5,
                borderWidth: 2.5
            },
            {
                label: 'Hum (%)',
                data: [],
                borderColor: '#0d9488',
                backgroundColor: 'rgba(13, 148, 136, 0.05)',
                fill: true,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                yAxisID: 'y1',
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHitRadius: 14,
                pointHoverBackgroundColor: '#0d9488',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2.5,
                borderWidth: 2.5
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false
        },
        plugins: {
            legend: { position: 'top', labels: { font: { family: 'Outfit', weight: '700', size: 11 } } },
            tooltip: {
                enabled: true,
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#ffffff',
                padding: 10,
                cornerRadius: 8
            }
        },
        scales: {
            y: { type: 'linear', display: true, position: 'left', grace: '5%', title: { display: true, text: 'Temp (°C)' }, grid: { color: 'rgba(0,0,0,0.04)' } },
            y1: { type: 'linear', display: true, position: 'right', grace: '5%', grid: { drawOnChartArea: false }, title: { display: true, text: 'Hum (%)' } },
            x: {
                grid: { display: false },
                ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { family: 'Outfit', weight: '600', size: 11 } }
            }
        }
    }
}) : null;

// Detailed Charts Initialization
const createDetailedChart = (id, label, color, bgColor) => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: label,
                data: [],
                borderColor: color,
                backgroundColor: bgColor,
                fill: true,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                borderWidth: 2.5,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHitRadius: 14,
                pointHoverBackgroundColor: color,
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2.5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            resizeDelay: 0,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#cbd5e1',
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: true
                }
            },
            scales: {
                y: { beginAtZero: false, grace: '5%', grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { family: 'Outfit', size: 10, weight: '600' } } },
                x: {
                    grid: { display: false },
                    ticks: {
                        maxTicksLimit: 6,
                        maxRotation: 0,
                        autoSkip: true,
                        font: { family: 'Outfit', size: 10, weight: '600' }
                    }
                }
            }
        }
    });
};

const detailedTempChart = createDetailedChart('detailedTempChart', 'Temperature (°C)', '#d97706', 'rgba(217, 119, 6, 0.04)');
const detailedHumChart = createDetailedChart('detailedHumChart', 'Humidity (%)', '#0d9488', 'rgba(13, 148, 136, 0.04)');
const detailedPresChart = createDetailedChart('detailedPresChart', 'Pressure (hPa)', '#64748b', 'rgba(100, 116, 139, 0.04)');
const detailedRainChart = createDetailedChart('detailedRainChart', 'Rainfall (mm)', '#2c5f97', 'rgba(44, 95, 151, 0.04)');
const detailedWaterChart = createDetailedChart('detailedWaterChart', 'Water Level (cm)', '#2f8f6d', 'rgba(47, 143, 109, 0.04)');
const detailedLightChart = createDetailedChart('detailedLightChart', 'Light Intensity (lux)', '#a16207', 'rgba(161, 98, 7, 0.04)');

let hourlyPrecipChart = null;
let weeklyRainChart = null;
let currentLatitude = 0.0;
let currentLongitude = 0.0;
let loadedForecastLatitude = null;
let loadedForecastLongitude = null;

let lastFetchedLocationNameLat = null;
let lastFetchedLocationNameLng = null;

async function updateLocationName(lat, lng) {
    if (lat === 0 || lng === 0) return;
    if (lastFetchedLocationNameLat === lat && lastFetchedLocationNameLng === lng) return;

    try {
        // ── Persistent cache: the station never moves, so a resolved name is
        // stored in localStorage (7-day TTL) keyed by rounded coordinates.
        // This avoids re-hitting Nominatim on every page load, which is the
        // main cause of the free service rate-limiting us (HTTP 429/503) and
        // showing "Location lookup failed".
        const cacheKey = `stationPlace_${lat.toFixed(4)}_${lng.toFixed(4)}`;
        const cached = (() => {
            try {
                const raw = JSON.parse(localStorage.getItem(cacheKey) || 'null');
                if (raw && raw.name && Date.now() - raw.t < 7 * 24 * 3600 * 1000) return raw.name;
            } catch (_) { /* ignore corrupt cache entries */ }
            return null;
        })();
        if (cached) {
            if (locationNameDisplay) locationNameDisplay.innerText = cached;
            lastFetchedLocationNameLat = lat;
            lastFetchedLocationNameLng = lng;
            return;
        }

        if (locationNameDisplay) locationNameDisplay.innerText = 'Resolving location...';
        // zoom=18 + addressdetails=1 returns the barangay-level fields
        // (neighbourhood/suburb/quarter) that the coarser zoom=10 omits.
        // NOTE: no custom headers here — browsers forbid setting `User-Agent`
        // via fetch (it throws a TypeError), which used to land us in the
        // catch block below ("Location lookup failed") even though the map
        // tiles themselves loaded fine.
        // Nominatim is a free shared service (1 req/sec per client), so a
        // single 429/503 is common. Retry with backoff before giving up.
        let response = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
            try {
                response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
                if (response.ok) break;
            } catch (err) {
                if (attempt === 2) throw err;
            }
        }
        if (!response || !response.ok) throw new Error(`geocode HTTP ${response ? response.status : 'no response'}`);
        const data = await response.json();
        if (data && data.error) throw new Error(data.error);

        let placeName = 'Unknown Location';
        if (data && data.address) {
            const addr = data.address;
            // Nominatim maps the subdivision/site to `neighbourhood` and the
            // Philippine barangay to `suburb`/`quarter`/`village`. Show them as
            // "Subdivision, Barangay" (e.g. "Golden Horizon, Hugo Perez") and
            // leave out the city/country for a compact station label.
            const subdivision = addr.neighbourhood || '';
            const barangay = addr.suburb || addr.quarter || addr.village || addr.hamlet || addr.neighbourhood || '';

            if (subdivision && barangay && subdivision.toLowerCase() !== barangay.toLowerCase()) {
                placeName = `${subdivision}, ${barangay}`;
            } else {
                placeName = subdivision || barangay || (addr.city || addr.town || 'Unknown Location');
            }
        } else if (data && data.display_name) {
            placeName = data.display_name.split(',')[0];
        }

        if (locationNameDisplay) locationNameDisplay.innerText = placeName;
        lastFetchedLocationNameLat = lat;
        lastFetchedLocationNameLng = lng;
        // Cache the resolved name so future page loads skip the Nominatim call.
        try {
            localStorage.setItem(cacheKey, JSON.stringify({ name: placeName, t: Date.now() }));
        } catch (_) { /* localStorage full/unavailable — lookup still works */ }
    } catch (e) {
        console.error("Error fetching location name:", e);
        // Fallback: show the raw coordinates instead of an error message —
        // the station's position is still useful even if the geocoder is
        // unreachable or rate-limited.
        if (locationNameDisplay) {
            locationNameDisplay.innerText = `(${lat.toFixed(5)}, ${lng.toFixed(5)})`;
        }
    }
}

// ── Embedded Live Station Map (Leaflet + OpenStreetMap) ─────────────
// Station pin (Google-Maps-style red teardrop) plus the 800 m coverage
// circle. Fully additive: if Leaflet or the tile server is unavailable,
// it logs a warning and leaves the "Waiting for sensor location…"
// placeholder — never blocking the rest of the dashboard.

// Google-Maps-style red teardrop pin (replaces Leaflet's default blue
// marker). The tip is the anchor so the pin points exactly at the station.
// Created lazily (guarded) because L may not be loaded yet — the function
// is only called after the `typeof L === 'undefined'` check in
// updateStationMap().
let stationPinIcon = null;
function getStationPinIcon() {
    if (!stationPinIcon) {
        stationPinIcon = L.divIcon({
            className: 'station-map-pin',
            html: `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 24 30">
                <path d="M12 1C6.48 1 2 5.34 2 10.71c0 6.79 10 19.29 10 19.29s10-12.5 10-19.29C22 5.34 17.52 1 12 1z" fill="#EA4335" stroke="#B31412" stroke-width="1.2"/>
                <circle cx="12" cy="10.5" r="4.6" fill="#fff"/>
                <circle cx="12" cy="10.5" r="2.1" fill="#EA4335"/>
            </svg>`,
            iconSize: [34, 42],
            iconAnchor: [17, 42],
            popupAnchor: [0, -38]
        });
    }
    return stationPinIcon;
}

function updateStationMap(lat, lng) {
    if (lat === 0 || lng === 0) return;
    if (stationMapExternal) stationMapExternal.href = `https://www.google.com/maps?q=${lat},${lng}`;

    // Leaflet not loaded (script blocked / offline) — keep placeholder, don't crash.
    if (typeof L === 'undefined' || !stationMapEl) {
        if (stationMapPlaceholder) {
            stationMapPlaceholder.innerHTML = '<i data-lucide="map-off"></i><p>Map unavailable — location still resolves.</p>';
            if (window.lucide) lucide.createIcons();
        }
        return;
    }

    // The map card now lives in its own section (section-livemap) which starts
    // hidden. Leaflet cannot measure a display:none container, so defer map
    // creation/placement until the section becomes active (switchToSection
    // re-invokes this function).
    const mapSection = document.getElementById('section-livemap');
    const isMapSectionVisible = !mapSection || mapSection.classList.contains('active');
    if (!isMapSectionVisible) {
        return;
    }

    try {
        if (!stationMapReady) {
            stationMap = L.map('station-map', {
                scrollWheelZoom: false, // avoid hijacking page scroll
                attributionControl: true
            });

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(stationMap);

            stationMapReady = true;
            // Clear the placeholder overlay once the map is live.
            if (stationMapPlaceholder) stationMapPlaceholder.remove();
        }

        const popupHtml = '<strong>Monitoring Station</strong>' +
            (locationNameDisplay && locationNameDisplay.innerText && locationNameDisplay.innerText !== 'Resolving location...'
                ? `<br>${locationNameDisplay.innerText.replace(/[<>]/g, '')}`
                : '');

        // 800 m coverage circle at the station location.
        if (!stationMapCoverage) {
            stationMapCoverage = L.circle([lat, lng], {
                radius: 800, // meters = 800 m coverage radius
                color: '#c5221f',
                weight: 1.5,
                opacity: 0.6,
                fillColor: '#ea4335',
                fillOpacity: 0.07
            }).addTo(stationMap);
        } else {
            stationMapCoverage.setLatLng([lat, lng]);
        }

        if (!stationMapMarker) {
            stationMapMarker = L.marker([lat, lng], { icon: getStationPinIcon() }).addTo(stationMap)
                .bindPopup(popupHtml);
            // Start with an explicit view — safe even when the container is
            // still 0-sized (hidden section / mid-entrance animation). Leaflet
            // fitBounds() on an unmeasured container divides by zero and
            // blanks the map with a NaN zoom, so only attempt the fit once the
            // container has a real height.
            stationMap.setView([lat, lng], 13);
            const fitCoverage = () => {
                try {
                    if (stationMap && stationMapCoverage &&
                        stationMapEl && stationMapEl.clientHeight > 50) {
                        stationMap.fitBounds(stationMapCoverage.getBounds(), { padding: [40, 40] });
                    }
                } catch (e) { /* non-critical: keep the explicit view above */ }
            };
            fitCoverage();
            requestAnimationFrame(() => setTimeout(fitCoverage, 120));
            setTimeout(fitCoverage, 500);  // after section-entrance animation settles
            setTimeout(fitCoverage, 1000);
        } else {
            stationMapMarker.setLatLng([lat, lng]);
            stationMapMarker.setPopupContent(popupHtml);
        }

        // Keep map tiles sized correctly even if hidden bubble had tiny dimensions.
        setTimeout(() => { if (stationMap) stationMap.invalidateSize(); }, 250);
    } catch (e) {
        console.warn("Station map init failed (non-critical):", e);
        if (stationMapPlaceholder) {
            stationMapPlaceholder.innerHTML = '<i data-lucide="map-off"></i><p>Map unavailable right now.</p>';
            if (window.lucide) lucide.createIcons();
        }
    }
}

function triggerForecastLoad() {
    if (currentLatitude !== 0.0 && currentLongitude !== 0.0) {
        loadOpenMeteoForecast(currentLatitude, currentLongitude);
    } else {
        // Fallback to the station site (7VMG+6CJ Trece Martires, Cavite) if GPS is not yet loaded
        loadOpenMeteoForecast(14.283049, 120.876088);
    }
}

async function loadWeeklyData() {
    const canvas = document.getElementById('weeklyRainChart');
    const ctx = canvas ? canvas.getContext('2d') : null;

    // Fetch data for the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    try {
        const snapshot = await db.collection('weather_history')
            .where('timestamp', '>=', sevenDaysAgo)
            .orderBy('timestamp', 'asc')
            .get();

        const dailyTotals = {};
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const labels = [];
        const data = [];

        let totalTempSum = 0;
        let tempCount = 0;

        // Initialize last 7 days with 0
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dayName = days[d.getDay()];
            dailyTotals[dayName] = 0;
            labels.push(dayName);
        }

        snapshot.forEach(doc => {
            const entry = doc.data();
            const date = entry.timestamp ? (entry.timestamp.toDate ? entry.timestamp.toDate() : new Date(entry.timestamp)) : new Date();
            const dayName = days[date.getDay()];

            if (dailyTotals.hasOwnProperty(dayName)) {
                dailyTotals[dayName] = Math.max(dailyTotals[dayName], parseFloat(entry.rainfall) || 0);
            }

            // Track temperature for weekly average
            const t = parseFloat(entry.temperature);
            if (!isNaN(t) && t !== 0) {
                totalTempSum += t;
                tempCount++;
            }
        });

        labels.forEach(label => data.push(dailyTotals[label]));

        if (ctx) {
            if (weeklyRainChart) {
                weeklyRainChart.data.labels = labels;
                weeklyRainChart.data.datasets[0].data = data;
                weeklyRainChart.update("none");
            } else {
                weeklyRainChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Daily Rainfall (mm)',
                            data: data,
                            backgroundColor: 'rgba(44, 95, 151, 0.35)',
                            borderColor: '#2c5f97',
                            borderWidth: 2,
                            borderRadius: 8
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                            x: { grid: { display: false } }
                        }
                    }
                });
            }
        }

        // Update Summary Stats
        const totalRain = data.reduce((a, b) => a + b, 0);
        const peakRain = Math.max(...data, 0);
        const rainDays = data.filter(d => d > 0.1).length;
        const avgTemp = tempCount > 0 ? (totalTempSum / tempCount) : 0;

        if (document.getElementById('weekly-total-rain')) document.getElementById('weekly-total-rain').innerText = totalRain.toFixed(1) + " mm";
        if (document.getElementById('weekly-peak-rain')) document.getElementById('weekly-peak-rain').innerText = peakRain.toFixed(1) + " mm";
        if (document.getElementById('weekly-rain-days')) document.getElementById('weekly-rain-days').innerText = rainDays;
        if (document.getElementById('weekly-avg-temp')) document.getElementById('weekly-avg-temp').innerText = avgTemp > 0 ? avgTemp.toFixed(1) + " °C" : "-- °C";

    } catch (error) {
        console.error("Error loading weekly data:", error);
    }
}

// Forecast chip label: resolve the SAME "Subdivision, Barangay" name the
// hero map shows (e.g. "Golden Horizon, Hugo Perez"). Reads the station
// cache first (populated by updateLocationName); falls back to a zoom=18
// reverse geocode so the coarse city ("Trece Martires") never wins unless
// nothing else is available.
async function attachForecastPlaceName(lat, lng, locLabel) {
    if (!locLabel) return;
    const cacheKey = `stationPlace_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    try {
        const raw = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (raw && raw.name && Date.now() - raw.t < 7 * 24 * 3600 * 1000) {
            locLabel.innerText = `Location: ${raw.name}`;
            locLabel.title = raw.name; // full name on hover/long-press
            return;
        }
    } catch (_) { /* ignore corrupt cache */ }
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.address) return;
        const addr = data.address;
        const subdivision = addr.neighbourhood || '';
        const barangay = addr.suburb || addr.quarter || addr.village || addr.hamlet || addr.neighbourhood || '';
        let name = 'Unknown';
        if (subdivision && barangay && subdivision.toLowerCase() !== barangay.toLowerCase()) {
            name = `${subdivision}, ${barangay}`;
        } else {
            name = subdivision || barangay || (addr.city || addr.town || addr.municipality || addr.county || 'Unknown');
        }
        locLabel.innerText = `Location: ${name}`;
        locLabel.title = name; // full name on hover/long-press
    } catch (_) { /* keep default "Location: --" while offline */ }
}

async function loadOpenMeteoForecast(lat, lng) {
    // Don't re-fetch if we already have data for this approximate location
    if (loadedForecastLatitude === lat.toFixed(3) && loadedForecastLongitude === lng.toFixed(3)) return;

    loadedForecastLatitude = lat.toFixed(3);
    loadedForecastLongitude = lng.toFixed(3);
    const container = document.getElementById('forecast-days-container');
    const locLabel = document.getElementById('forecast-location-label');

    // Start weather and geo requests in parallel for maximum speed
    const weatherPromise = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weathercode&hourly=temperature_2m,precipitation,precipitation_probability,weathercode,is_day&timezone=auto`);

    // Use the same station place name as the hero map label ("Subdivision,
    // Barangay", e.g. "Golden Horizon, Hugo Perez") instead of the coarse
    // city token ("Trece Martires") that the old zoom=10 lookup returned.
    // The station name is cached by updateLocationName; the city is only a
    // fallback while that name is still resolving.
    attachForecastPlaceName(lat, lng, locLabel);

    try {
        const res = await weatherPromise;
        const data = await res.json();

        if (!data || !data.daily) throw new Error("Invalid API response");

        if (container) {
            container.innerHTML = '';
        }

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const weatherIcons = {
            0: 'sun', // Clear sky
            1: 'cloudy', 2: 'cloudy', 3: 'cloudy', // Mainly clear, partly cloudy, and overcast
            45: 'cloud', 48: 'cloud', // Fog and depositing rime fog
            51: 'cloud-drizzle', 53: 'cloud-drizzle', 55: 'cloud-drizzle', // Drizzle
            61: 'cloud-rain', 63: 'cloud-rain', 65: 'cloud-rain', // Rain
            71: 'snowflake', 73: 'snowflake', 75: 'snowflake', // Snow
            80: 'cloud-rain', 81: 'cloud-rain', 82: 'cloud-rain', // Rain showers
            95: 'cloud-lightning', 96: 'cloud-lightning', 99: 'cloud-lightning' // Thunderstorm
        };

        let maxRainProb = 0;
        let maxRainDay = '';
        let totalTemps = 0;
        let dailyCount = data.daily.time.length;

        for (let i = 0; i < dailyCount; i++) {
            const date = new Date(data.daily.time[i]);
            const dayName = days[date.getDay()];
            const maxTemp = data.daily.temperature_2m_max[i];
            const minTemp = data.daily.temperature_2m_min[i];
            const rainProb = data.daily.precipitation_probability_max[i];
            const code = data.daily.weathercode[i];
            const iconName = weatherIcons[code] || 'cloud';

            totalTemps += (maxTemp + minTemp) / 2;

            if (rainProb > maxRainProb) {
                maxRainProb = rainProb;
                maxRainDay = dayName;
            }

            const card = document.createElement('div');
            card.className = 'forecast-day-card';
            card.innerHTML = `
                <div class="forecast-day-name">${dayName.substring(0, 3)}</div>
                <div class="forecast-day-icon"><i data-lucide="${iconName}"></i></div>
                <div class="forecast-day-temps">
                    <span class="max">${maxTemp.toFixed(0)}°</span>
                    <span class="min">${minTemp.toFixed(0)}°</span>
                </div>
                <div class="forecast-day-rain">
                    <i data-lucide="droplet" style="width:12px;height:12px;"></i>
                    <span>${rainProb}%</span>
                </div>
            `;
            if (container) {
                container.appendChild(card);
            }
        }

        // Update summaries
        const avgTemp = totalTemps / dailyCount;
        if (document.getElementById('forecast-risk-day')) {
            document.getElementById('forecast-risk-day').innerText = maxRainProb > 30 ? `${maxRainDay} (${maxRainProb}%)` : 'Low Risk';
        }
        if (document.getElementById('forecast-avg-temp')) {
            document.getElementById('forecast-avg-temp').innerText = `${avgTemp.toFixed(1)} °C`;
        }

        // Render weekly precipitation chart
        renderWeeklyForecastChart(data.daily);

        lucide.createIcons();
    } catch (err) {
        console.error("Open-Meteo API load failed: ", err);
        if (container) {
            const msg = document.createElement('div');
            msg.className = 'forecast-error';
            msg.textContent = `Failed to load weather forecast: ${err.message}`;
            container.replaceChildren(msg);
        }
    }
}

function renderWeeklyForecastChart(dailyData) {
    const canvas = document.getElementById('hourlyPrecipChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const labels = [];
    const probData = [];
    const precipData = [];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let i = 0; i < dailyData.time.length; i++) {
        const date = new Date(dailyData.time[i]);
        labels.push(days[date.getDay()]);
        probData.push(dailyData.precipitation_probability_max[i]);
        precipData.push(dailyData.precipitation_sum ? dailyData.precipitation_sum[i] : 0);
    }

    if (hourlyPrecipChart) {
        hourlyPrecipChart.data.labels = labels;
        hourlyPrecipChart.data.datasets[0].data = probData;
        hourlyPrecipChart.data.datasets[1].data = precipData;
        hourlyPrecipChart.update("none");
    } else {
        hourlyPrecipChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Rain Prob (%)',
                        data: probData,
                        backgroundColor: 'rgba(44, 95, 151, 0.35)',
                        borderColor: '#2c5f97',
                        borderWidth: 1,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Expected (mm)',
                        data: precipData,
                        type: 'line',
                        borderColor: '#2c5f97',
                        backgroundColor: 'rgba(44, 95, 151, 0.05)',
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        title: { display: true, text: 'Prob (%)', font: { size: 10 } }
                    },
                    y1: {
                        beginAtZero: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: 'Amount (mm)', font: { size: 10 } }
                    },
                    x: { grid: { display: false } }
                },
                plugins: {
                    legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } }
                }
            }
        });
    }
}

// Helper to safely parse any Firestore timestamp format (native, serialized JSON, string, etc.)
function parseFirestoreTimestamp(timestamp) {
    if (!timestamp) return new Date();
    if (typeof timestamp.toDate === 'function') return timestamp.toDate();
    if (timestamp.seconds !== undefined) return new Date(timestamp.seconds * 1000);
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? new Date() : date;
}

let lastForecastFetch = 0;
let cachedForecastData = null;

async function populateHourlyTempTimeline() {
    const container = document.getElementById('hourly-temp-timeline');
    if (!container) return;

    // Render immediately with whatever we have (Now card + cached forecast)
    renderTimeline(cachedForecastData);

    const nowTime = Date.now();
    // Cache forecast data for 30 minutes to improve performance and prevent rendering lag
    if (cachedForecastData && (nowTime - lastForecastFetch < 30 * 60 * 1000)) {
        return;
    }

    if (isFetchingForecast) return;
    isFetchingForecast = true;

    try {
        const lat = currentLatitude || 14.283049;  // station site (7VMG+6CJ) fallback
        const lng = currentLongitude || 120.876088;
        const forecastRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,weathercode,is_day&timezone=auto&forecast_hours=24`
        );
        cachedForecastData = await forecastRes.json();
        lastForecastFetch = nowTime;
        renderTimeline(cachedForecastData);
    } catch (err) {
        console.error("Error loading hourly timeline:", err);
    } finally {
        isFetchingForecast = false;
    }
}

function renderTimeline(forecastData) {
    const container = document.getElementById('hourly-temp-timeline');
    if (!container) return;

    // Process future entries
    const futureEntries = [];
    const weatherCodeIcons = {
        0: { day: 'sun', night: 'moon' },
        1: { day: 'cloudy', night: 'cloud-moon' },
        2: { day: 'cloudy', night: 'cloud-moon' },
        3: { day: 'cloudy', night: 'cloud-moon' },
        45: { day: 'cloud', night: 'cloud' },
        48: { day: 'cloud', night: 'cloud' },
        51: { day: 'cloud-drizzle', night: 'cloud-drizzle' },
        53: { day: 'cloud-drizzle', night: 'cloud-drizzle' },
        55: { day: 'cloud-drizzle', night: 'cloud-drizzle' },
        56: { day: 'cloud-drizzle', night: 'cloud-drizzle' },
        57: { day: 'cloud-drizzle', night: 'cloud-drizzle' },
        61: { day: 'cloud-rain', night: 'cloud-rain' },
        63: { day: 'cloud-rain', night: 'cloud-rain' },
        65: { day: 'cloud-rain', night: 'cloud-rain' },
        66: { day: 'cloud-rain', night: 'cloud-rain' },
        67: { day: 'cloud-rain', night: 'cloud-rain' },
        71: { day: 'cloud-snow', night: 'cloud-snow' },
        73: { day: 'cloud-snow', night: 'cloud-snow' },
        75: { day: 'cloud-snow', night: 'cloud-snow' },
        77: { day: 'cloud-snow', night: 'cloud-snow' },
        80: { day: 'cloud-rain', night: 'cloud-rain' },
        81: { day: 'cloud-rain', night: 'cloud-rain' },
        82: { day: 'cloud-rain', night: 'cloud-rain' },
        85: { day: 'cloud-snow', night: 'cloud-snow' },
        86: { day: 'cloud-snow', night: 'cloud-snow' },
        95: { day: 'cloud-lightning', night: 'cloud-lightning' },
        96: { day: 'cloud-lightning', night: 'cloud-lightning' },
        99: { day: 'cloud-lightning', night: 'cloud-lightning' }
    };

    if (forecastData && forecastData.hourly) {
        const now = new Date();
        for (let i = 0; i < forecastData.hourly.time.length; i++) {
            const forecastTime = new Date(forecastData.hourly.time[i]);
            if (forecastTime > now) {
                futureEntries.push({
                    time: forecastTime,
                    temp: forecastData.hourly.temperature_2m[i],
                    weatherCode: forecastData.hourly.weathercode ? forecastData.hourly.weathercode[i] : 0,
                    isDay: forecastData.hourly.is_day ? forecastData.hourly.is_day[i] === 1 : true
                });
                if (futureEntries.length >= 12) break;
            }
        }
    }

    container.innerHTML = '';

    // "Now" card
    const currentTempDisplay = (isNaN(currentSensorData.temp)) ? "--" : Math.round(currentSensorData.temp);

    let currentIcon = 'sun';
    const rainRate = currentSensorData.rainRate || 0;
    const water = currentSensorData.water || 0;
    const lightVal = currentSensorData.light || 0;
    const maxChannelCapacity = Math.max(0, physicalMountHeight - 25); // highest measurable level (sensor height − 25 cm blind zone)

    if (water >= maxChannelCapacity || rainRate >= 15.0) currentIcon = 'cloud-lightning';
    else if (rainRate > 0.0) currentIcon = 'cloud-rain';
    else {
        const hour = new Date().getHours();
        const isDaytime = hour >= 5 && hour < 18;
        if (hour >= 18 || hour < 5) currentIcon = 'moon';
        else if (isDaytime && lightVal >= 0 && lightVal < 6000) currentIcon = 'cloudy';
        else currentIcon = 'sun';
    }

    const nowCard = document.createElement('div');
    nowCard.className = 'hourly-item is-now';
    nowCard.id = 'timeline-now-card';
    nowCard.innerHTML = `
        <span class="hourly-time"><span class="timeline-pulse-dot"></span>Now</span>
        <div class="hourly-icon"><i data-lucide="${currentIcon}"></i></div>
        <span class="hourly-temp">${currentTempDisplay}°</span>
    `;
    container.appendChild(nowCard);

    futureEntries.forEach(entry => {
        const label = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        let iconName = 'cloud';
        const iconConfig = weatherCodeIcons[entry.weatherCode];
        if (iconConfig) iconName = entry.isDay ? iconConfig.day : iconConfig.night;

        const card = document.createElement('div');
        card.className = 'hourly-item hourly-predicted';
        card.innerHTML = `
            <span class="hourly-time">${label}</span>
            <div class="hourly-icon"><i data-lucide="${iconName}"></i></div>
            <span class="hourly-temp">${Math.round(entry.temp)}°</span>
        `;
        container.appendChild(card);
    });

    lucide.createIcons();
}

// Modern fix for container-based resizing
const resizeObserver = new ResizeObserver(() => {
    const allCharts = [
        chartRain, chartAtmo,
        detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart,
        detailedWaterChart, detailedLightChart,
        hourlyPrecipChart, weeklyRainChart
    ];
    allCharts.forEach(c => {
        if (c && c.canvas && c.canvas.offsetParent !== null) { // Only resize if visible
            c.resize();
        }
    });
});

// Observe the main content area for any size changes
const scrollArea = document.querySelector('.scroll-area');
if (scrollArea) resizeObserver.observe(scrollArea);

// Fallback for window resize
window.addEventListener('resize', () => {
    const allCharts = [
        chartRain, chartAtmo,
        detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart,
        detailedWaterChart, detailedLightChart,
        hourlyPrecipChart, weeklyRainChart
    ];
    allCharts.forEach(c => {
        if (c) c.resize();
    });
});

// Check Auth State
auth.onAuthStateChanged(async (user) => {
    if (user) {
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (userDoc.exists) {
                const data = userDoc.data();
                if (data.disabled === true) {
                    await auth.signOut();
                    window.location.href = "../index.html";
                    return;
                }
            }
        } catch (e) { console.error("Auth check failed:", e); }

        loadUserSettings(user);
        startRealtimeUpdates();
        fetchAdminConfig();
        triggerForecastLoad();
        loadWeeklyData();
        populateHourlyTempTimeline(); // Render timeline immediately on startup
        if (typeof updateBackgroundByTime === 'function') updateBackgroundByTime();
    } else {
        window.location.href = "../index.html";
    }
});

let historyInitialized = false;
let lastProcessedTime = null;
let firstSnapshotReceived = false;
let latestRtdbCurrentData = null;

function startRealtimeUpdates() {
    // 0. Initialize History once on load
    if (!historyInitialized) {
        historyInitialized = true;
        initializeChartHistory();
        setupRealtimeHistoryListener();
    }

    // Responsive cap: if Firestore is slow to deliver the first snapshot,
    // reveal the (already placeholder-safe) dashboard anyway — the page
    // renders -- / OFFLINE states gracefully, so a stuck splash is worse
    // than showing the ready-to-use shell.
    setTimeout(dismissSplash, 2500);

    const handleCurrentData = (data) => {
        latestRtdbCurrentData = data;
        if (window.SplashBar) window.SplashBar.set(75); // first live snapshot rendered
        if (!data) {
            updateStatusUI("No Data", "#94a3b8", false);
            populateHourlyTempTimeline();
            if (typeof updateBackgroundByTime === 'function') updateBackgroundByTime();
        } else {
            const rain = data.rainfall !== undefined ? parseFloat(data.rainfall) : (data.dailyRainfall !== undefined ? parseFloat(data.dailyRainfall) : 0.0);
            const lat = data.lat !== undefined ? parseFloat(data.lat) : 0.0;
            const lng = data.lng !== undefined ? parseFloat(data.lng) : 0.0;
            const temp = data.temperature !== undefined ? parseFloat(data.temperature) : NaN;
            const hum = data.humidity !== undefined ? parseFloat(data.humidity) : NaN;
            const pres = data.pressure !== undefined ? parseFloat(data.pressure) : NaN;
            const light = data.lightLevel !== undefined ? parseFloat(data.lightLevel) : (data.light !== undefined ? parseFloat(data.light) : -1.0);
            const water = data.waterLevel !== undefined ? parseFloat(data.waterLevel) : -1.0;
            const dewPoint = data.dewPoint !== undefined ? parseFloat(data.dewPoint) : NaN;
            const heatIndex = data.heatIndex !== undefined ? parseFloat(data.heatIndex) : NaN;
            const rainRate = data.rainRate !== undefined ? parseFloat(data.rainRate) : 0.0;
            const rainIntensity = data.rainIntensity || 'None';

            let cloudCover = data.cloudCover !== undefined ? parseFloat(data.cloudCover) : 0.0;
            if ((data.cloudCover === undefined || cloudCover === 0) && light >= 0) {
                const ratio = Math.min(1.0, light / maxClearSkyLux);
                cloudCover = (1.0 - ratio) * 100.0;
            }
            const pressureTrend = data.pressureTrend !== undefined ? parseFloat(data.pressureTrend) : 0.0;
            const waterRiseRate = data.waterRiseRate !== undefined ? parseFloat(data.waterRiseRate) : 0.0;

            currentLatitude = lat;
            currentLongitude = lng;

            // Update reactive global state
            currentSensorData = { rain, temp, rainRate, water, light, cloudCover };

            if (rainfallValue) rainfallValue.innerText = rain.toFixed(2);
            const shownRainUnit = data.rainRateUnit === 'mm/min' ? 'mm/min' : 'mm/h';
            const shownRain = shownRainUnit === 'mm/min' ? (rainRate / 60) : rainRate;
            if (rainRateValue) rainRateValue.innerText = `${shownRain.toFixed(shownRainUnit === 'mm/min' ? 2 : 1)} ${shownRainUnit}`;
            if (rainIntensityBadge) {
                rainIntensityBadge.innerText = rainIntensity;
                rainIntensityBadge.className = `risk-badge ${getRainIntensityClass(rainIntensity)}`;
            }

            updateLocationName(lat, lng);

            if (tempEl) tempEl.innerText = !isNaN(temp) ? temp.toFixed(1) : "--.-";
            if (humidityEl) humidityEl.innerText = !isNaN(hum) ? hum.toFixed(0) : "--";
            if (pressureEl) pressureEl.innerText = !isNaN(pres) ? pres.toFixed(1) : "----";

            if (pressureTrendBadge) {
                const trendStr = pressureTrend > 0.5 ? 'Rising' : (pressureTrend < -0.5 ? 'Falling' : 'Stable');
                pressureTrendBadge.innerText = `${trendStr} (${pressureTrend > 0 ? '+' : ''}${pressureTrend.toFixed(1)} hPa)`;
                // Plain chip-sub text — no pill/background (matches the other sensor chips).
                pressureTrendBadge.className = '';
            }

            if (lightEl) lightEl.innerText = light >= 0 ? light.toFixed(0) : "--";
            if (cloudCoverEl) cloudCoverEl.innerText = light >= 10 ? `${cloudCover.toFixed(0)}%` : "Night";
            if (waterLevelEl) waterLevelEl.innerText = water >= 0 ? water.toFixed(1) : "--";
            const shownRiseUnit = data.riseRateUnit === 'cm/h' ? 'cm/h' : 'cm/min';
            latestRiseRateUnit = shownRiseUnit;
            const shownRise = shownRiseUnit === 'cm/h' ? (waterRiseRate * 60) : waterRiseRate;
            if (waterRiseRateEl) waterRiseRateEl.innerText = waterRiseRate !== 0 ? `${waterRiseRate > 0 ? '+' : ''}${shownRise.toFixed(2)} ${shownRiseUnit}` : `0.00 ${shownRiseUnit}`;
            if (dewPointEl) dewPointEl.innerText = !isNaN(dewPoint) ? dewPoint.toFixed(1) : "--.-";
            if (heatIndexEl) heatIndexEl.innerText = !isNaN(heatIndex) ? heatIndex.toFixed(1) : "--.-";

            if (lat !== 0 && lng !== 0) {
                const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;
                if (mapLinkSidebar) mapLinkSidebar.href = mapUrl;
                if (mapLinkMobile) mapLinkMobile.href = mapUrl;
                updateStationMap(lat, lng);
            }

            const lastSeen = data.lastSeen;
            const lastSeenDate = parseFirestoreTimestamp(lastSeen);
            lastSeenTimestamp = lastSeenDate;
            const lastSeenStr = (lastSeenDate && !isNaN(lastSeenDate.getTime())) ? lastSeenDate.toISOString() : new Date().toISOString();

            // Trigger status check immediately
            refreshSystemStatus();

            // Auto load/update forecast if board location changed and coordinates are valid
            if (lat !== 0 && lng !== 0 && (lat.toFixed(3) !== loadedForecastLatitude || lng.toFixed(3) !== loadedForecastLongitude)) {
                loadOpenMeteoForecast(lat, lng);
            }

            updateStatusAndRisk(rain, rainRate, water, cloudCover, light);
            updatePredictions(temp, hum, pres, rain, light, water, pressureTrend, cloudCover, waterRiseRate);
            scheduleLucideRefresh(); // throttled — avoids full-DOM rescan every sensor tick

            // Populate today's live forecast cards
            updateTodayForecastDisplay(temp, cloudCover, light, water);

            const currentMax = (maxRainfall && maxRainfall.innerText) ? parseFloat(maxRainfall.innerText) || 0 : 0;
            if (maxRainfall && rain > currentMax) maxRainfall.innerText = rain.toFixed(2);

            const now = new Date();
            if (lastUpdate) lastUpdate.innerText = formatRelativeUpdate(lastSeenTimestamp || now);

            if (lastSeenStr && lastSeenStr !== lastProcessedTime) {
                const isFirstSnapshot = !firstSnapshotReceived;
                firstSnapshotReceived = true;
                lastProcessedTime = lastSeenStr;
                // Skip chart update on the very first snapshot — that data is
                // already represented in the historical chart loaded by
                // initializeChartHistory(). Only genuinely NEW readings should
                // add points to the live chart.
                if (!isFirstSnapshot) {
                    updateCharts(rain, temp, hum, pres, water, light);
                }
                populateHourlyTempTimeline();

                // Live-update today's bar in weeklyRainChart in real time!
                if (weeklyRainChart && weeklyRainChart.data && weeklyRainChart.data.datasets.length > 0) {
                    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const todayName = days[new Date().getDay()];
                    const todayIdx = weeklyRainChart.data.labels.indexOf(todayName);
                    if (todayIdx !== -1) {
                        const curBarVal = weeklyRainChart.data.datasets[0].data[todayIdx] || 0;
                        if (rain > curBarVal) {
                            weeklyRainChart.data.datasets[0].data[todayIdx] = rain;
                            weeklyRainChart.update('none');
                        }
                    }
                }
            }
        }

        dismissSplash();
    };

    // Subscribe to Firestore (single source of truth for live telemetry)
    db.collection('weather').doc('current').onSnapshot(doc => {
        handleCurrentData(doc.exists ? doc.data() : null);
    }, error => {
        console.warn("Firestore current doc error:", error);
        handleCurrentData(null);
    });
}

function getRainIntensityClass(intensity) {
    if (intensity === 'Light') return 'alert-level';
    if (intensity === 'Moderate') return 'warning';
    if (intensity === 'Heavy' || intensity === 'Violent') return 'danger';
    return 'safe';
}

function updateTodayForecastDisplay(temp, cloudCover, light, water) {
    const todayTemp = document.getElementById('today-temp');
    const todayClouds = document.getElementById('today-clouds');
    const todayWater = document.getElementById('today-water');

    if (todayTemp) todayTemp.innerText = `${temp.toFixed(1)}°C`;
    if (todayClouds) todayClouds.innerText = light >= 10 ? `${cloudCover.toFixed(0)}%` : "Night";
    if (todayWater) todayWater.innerText = water >= 0 ? `${water.toFixed(1)} cm` : "--";
}

function updatePredictions(temp, hum, pres, rain, light, water, pressureTrend, cloudCover, waterRiseRate) {
    let prediction = "Stable";
    let desc = "Atmospheric conditions are currently normal.";
    let icon = "sun";
    let rainProb = 5;
    let floodRisk = 0;

    // Apply Sensor Offsets
    temp += (sensorOffsets ? sensorOffsets.temp : 0);
    water += (sensorOffsets ? sensorOffsets.water : 0);

    // Advanced Local Mathematical Model: Multi-Factor Weighted Scoring (0-10)
    // Normalize weights to 10 points total
    const weights = modelWeights || { pres: 40, hum: 20, light: 20, rain: 20 };
    const wPres = weights.pres / 10;
    const wHum = weights.hum / 10;
    const wLight = weights.light / 10;
    const wRain = weights.rain / 10;

    // 1. Barometric Pressure Drop (Relative to weight)
    const baseScore = Math.max(0, (standardBasePressure - pres) * 0.4);
    const trendFactor = pressureTrend < 0 ? Math.min(2.0, Math.abs(pressureTrend) * 1.5) : 0;
    const pressureScore = Math.min(wPres, (baseScore + trendFactor) * (wPres / 4.0));

    // 2. Moisture Saturation (Relative to weight)
    const humidityScore = (hum / 100) * wHum;

    // 3. Solar Radiation Drop / Cloud Cover Proxy (Relative to weight)
    let lightScore = 0;
    if (light >= 10) {
        lightScore = (cloudCover / 100) * wLight;
    }

    // 4. Current Precipitation Intensity (Relative to weight)
    const rainScore = Math.min(wRain, (rain / alertThresholdVal) * wRain);

    let predictionScore = Math.min(10, pressureScore + humidityScore + lightScore + rainScore);

    // Dynamic Rain Probability based on multi-factor score
    rainProb = Math.max(5, Math.round(predictionScore * 10));

    // Display Factor Breakdown in prediction card
    const fPres = document.getElementById('factor-pressure');
    const fHum = document.getElementById('factor-humidity');
    const fLight = document.getElementById('factor-light');
    const fRain = document.getElementById('factor-rain');

    if (fPres) fPres.innerText = `${pressureScore.toFixed(1)} / ${wPres.toFixed(1)}`;
    if (fHum) fHum.innerText = `${humidityScore.toFixed(1)} / ${wHum.toFixed(1)}`;
    if (fLight) fLight.innerText = light >= 10 ? `${lightScore.toFixed(1)} / ${wLight.toFixed(1)}` : 'Night';
    if (fRain) fRain.innerText = `${rainScore.toFixed(1)} / ${wRain.toFixed(1)}`;

    // Local Forecast Determination logic
    if (pressureTrend < -1.5 && hum > 85) {
        prediction = "Storm Imminent";
        desc = "Rapid pressure drop and high humidity suggest heavy rainfall and wind.";
        icon = "cloud-lightning";
        rainProb = Math.max(rainProb, 95);
    } else if (pres < 1008 && hum > 78) {
        prediction = "Rain Expected";
        desc = "Unstable atmospheric system producing localized precipitation.";
        icon = "cloud-rain";
        rainProb = Math.max(rainProb, 80);
    } else if (light !== undefined && light >= 0 && light < 6000) {
        prediction = "Mostly Overcast";
        desc = "Heavy cloud cover or reduced light level detected.";
        icon = "cloud";
        rainProb = Math.max(rainProb, 45);
    } else if (temp > 33 && hum < 55) {
        prediction = "Hot & Clear";
        desc = "High temperature and dry atmosphere. Clear conditions.";
        icon = "sun";
        rainProb = 5;
    }

    // Advanced Flood Risk Computation (Combined Factors)
    const rainRisk = (rain / alertThresholdVal) * 100;
    const maxChannelCapacity = Math.max(0, physicalMountHeight - 25); // highest measurable level (sensor height − 25 cm blind zone) // Assume 80% is critical
    const waterLevelRisk = water >= 0 ? (water / maxChannelCapacity) * 100 : 0;

    let combinedFloodRisk = Math.max(rainRisk, waterLevelRisk);
    if (waterRiseRate > 0) {
        combinedFloodRisk += (waterRiseRate * 150); // Boost risk if rising fast (x150 keeps the old cm/h risk scale: 0.17 cm/min = 10 cm/h)
    }
    floodRisk = Math.min(100, combinedFloodRisk);

    // Water level specific risk (Visual Gauge)
    let waterGaugeRisk = water >= 0 ? Math.min(100, (water / maxChannelCapacity) * 100) : 0;

    // Update UI
    const pTitle = document.getElementById('prediction-title');
    const pDesc = document.getElementById('prediction-desc');
    const pIconBox = document.getElementById('prediction-icon-box');
    const pRain = document.getElementById('prob-rain');
    const pFlood = document.getElementById('prob-flood');
    const pWater = document.getElementById('prob-water');
    const pScore = document.getElementById('prediction-score-value');

    const todayRainChance = document.getElementById('today-rain-chance');
    if (todayRainChance) todayRainChance.innerText = `${rainProb}%`;

    // Update Today Forecast section main condition
    const todayCondition = document.getElementById('today-condition');
    const todayDetail = document.getElementById('today-detail');
    const todayWeatherIcon = document.getElementById('today-weather-icon');
    if (todayCondition) todayCondition.innerText = prediction;
    if (todayDetail) todayDetail.innerText = desc;
    if (todayWeatherIcon) todayWeatherIcon.innerHTML = `<i data-lucide="${icon}"></i>`;

    if (pTitle) pTitle.innerText = prediction;
    if (pDesc) pDesc.innerText = desc;
    if (pIconBox) pIconBox.innerHTML = `<i data-lucide="${icon}"></i>`;
    if (pRain) pRain.style.width = rainProb + "%";
    if (pFlood) {
        pFlood.style.width = floodRisk + "%";
        // Color the flood-risk bar by actual risk level: green when calm,
        // amber when elevated, red only when critical.
        pFlood.className = 'progress-fill ' + (floodRisk >= 66 ? 'danger' : (floodRisk >= 33 ? 'warning' : 'safe'));
    }
    if (pWater) pWater.style.width = waterGaugeRisk + "%";
    if (pScore) pScore.innerText = predictionScore.toFixed(1);
    updateAiRiskGauge(predictionScore);

    // Update model guidance
    const guidanceText = document.getElementById('model-guidance-text');
    if (guidanceText) {
        if (waterRiseRate > 0.17) {
            const rrShown = latestRiseRateUnit === 'cm/h' ? waterRiseRate * 60 : waterRiseRate;
            guidanceText.innerText = `ALERT: Flood water is rising rapidly (+${rrShown.toFixed(2)} ${latestRiseRateUnit}). Drainage overflows could occur in less than 2 hours.`;
        } else if (pressureTrend < -2.0) {
            guidanceText.innerText = `WARNING: Sudden barometric drop detected (${pressureTrend.toFixed(1)} hPa). Highly unstable storm system incoming.`;
        } else if (rain > 0) {
            guidanceText.innerText = `Active rainfall detected. local water level is currently at ${water.toFixed(1)} cm. Monitoring rise rate.`;
        } else {
            guidanceText.innerText = "All atmospheric parameters and localized water levels are currently within safe limits.";
        }
    }

    lucide.createIcons();
}

let currentSelectedRange = 'today';
let customSelectedDate = null;
let historyQuerySeq = 0;

async function initializeChartHistory(rangeMode = currentSelectedRange, customDateStr = customSelectedDate) {
    currentSelectedRange = rangeMode;
    customSelectedDate = customDateStr;
    const thisQueryId = ++historyQuerySeq;

    const allCharts = [
        chartRain, chartAtmo,
        detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart,
        detailedWaterChart, detailedLightChart,
        weeklyRainChart
    ];

    allCharts.forEach(c => {
        if (c) {
            c.data.labels = [];
            c.data.datasets.forEach(d => {
                d.data = [];
                d.tension = currentGraphTension;
            });
        }
    });

    let startDate, endDate;
    const now = new Date();

    if (rangeMode === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        endDate = new Date();
    } else if (rangeMode === '7d') {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date();
    } else if (rangeMode === '30d') {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date();
    } else if (rangeMode === 'custom' && customDateStr) {
        const [y, m, d] = customDateStr.split('-').map(Number);
        startDate = new Date(y, m - 1, d, 0, 0, 0);
        endDate = new Date(y, m - 1, d, 23, 59, 59);
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        endDate = new Date();
    }

    try {
        let rawHistory = [];

        if (rangeMode === 'today') {
            const snapshot = await db.collection('weather_history')
                .where('timestamp', '>=', startDate)
                .orderBy('timestamp', 'asc')
                .limit(200)
                .get();

            if (!snapshot.empty) {
                rawHistory = snapshot.docs.map(doc => doc.data());
            }
        } else if (rangeMode === 'custom' && customDateStr) {
            const snapshot = await db.collection('weather_history')
                .where('timestamp', '>=', startDate)
                .where('timestamp', '<=', endDate)
                .orderBy('timestamp', 'asc')
                .limit(200)
                .get();

            if (!snapshot.empty) {
                rawHistory = snapshot.docs.map(doc => doc.data());
            }
        } else {
            // 7d / 30d: fetch the NEWEST readings first (desc + reverse) so the
            // limit(500) cap keeps recent data instead of the oldest in the range
            const snapshot = await db.collection('weather_history')
                .where('timestamp', '>=', startDate)
                .orderBy('timestamp', 'desc')
                .limit(500)
                .get();

            if (!snapshot.empty) {
                rawHistory = snapshot.docs.map(doc => doc.data()).reverse();
            }
        }

        // Combine weather_history + RTDB live reading only if RTDB reading is genuinely from the active time window
        if (latestRtdbCurrentData && (rangeMode === 'today' || rangeMode === '7d' || rangeMode === '30d')) {
            const rtdbTime = parseFirestoreTimestamp(latestRtdbCurrentData.lastSeen || new Date());
            const lastHistTime = rawHistory.length > 0 ? parseFirestoreTimestamp(rawHistory[rawHistory.length - 1].timestamp) : null;

            // Only append if the live reading timestamp falls within the requested range and is newer than the last recorded history point
            if (rtdbTime >= startDate && (!lastHistTime || (rtdbTime.getTime() - lastHistTime.getTime() > 60000))) {
                rawHistory.push({
                    ...latestRtdbCurrentData,
                    timestamp: latestRtdbCurrentData.lastSeen || new Date().toISOString()
                });
            }
        }

        // If a newer query was fired while waiting for Firestore, discard this stale result
        if (thisQueryId !== historyQuerySeq) return;

        // Weekly/Monthly views show ONE aggregated point per calendar day;
        // Today/Custom views downsample smoothly to max 30 clean points
        const history = (rangeMode === '7d' || rangeMode === '30d')
            ? aggregateHistoryByDay(rawHistory)
            : downsampleHistoricalPoints(rawHistory, 30);

        history.forEach(data => {
            const time = parseFirestoreTimestamp(data.timestamp);
            
            let timeLabel;
            if (rangeMode === 'today' || rangeMode === 'custom') {
                timeLabel = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else if (rangeMode === '7d') {
                // One point per day, so label by day (weekday can repeat across an 8-day window)
                timeLabel = time.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
            } else {
                timeLabel = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
            }

            const r = parseFloat(data.rainfall) || 0;
            const t = parseFloat(data.temperature) || 0;
            const h = parseFloat(data.humidity) || 0;
            const p = parseFloat(data.pressure) || 0;
            const rawW = data.waterLevel !== undefined ? data.waterLevel : (data.water !== undefined ? data.water : NaN);
            // -1 is the sensor-failure sentinel for waterLevel/lightLevel — render
            // those as a gap (null) instead of dipping the line to -1 or faking 0.
            const w = (!isNaN(parseFloat(rawW)) && parseFloat(rawW) >= 0) ? parseFloat(rawW) : null;
            const rawL = data.lightLevel !== undefined ? data.lightLevel : (data.light !== undefined ? data.light : NaN);
            const l = (!isNaN(parseFloat(rawL)) && parseFloat(rawL) >= 0) ? parseFloat(rawL) : null;

            if (chartRain) {
                chartRain.data.labels.push(timeLabel);
                chartRain.data.datasets[0].data.push(r);
            }
            if (chartAtmo) {
                chartAtmo.data.labels.push(timeLabel);
                chartAtmo.data.datasets[0].data.push(t);
                chartAtmo.data.datasets[1].data.push(h);
            }
            if (detailedTempChart) {
                detailedTempChart.data.labels.push(timeLabel);
                detailedTempChart.data.datasets[0].data.push(t);
            }
            if (detailedHumChart) {
                detailedHumChart.data.labels.push(timeLabel);
                detailedHumChart.data.datasets[0].data.push(h);
            }
            if (detailedPresChart) {
                detailedPresChart.data.labels.push(timeLabel);
                detailedPresChart.data.datasets[0].data.push(p);
            }
            if (detailedRainChart) {
                detailedRainChart.data.labels.push(timeLabel);
                detailedRainChart.data.datasets[0].data.push(r);
            }
            if (detailedWaterChart) {
                detailedWaterChart.data.labels.push(timeLabel);
                detailedWaterChart.data.datasets[0].data.push(w);
            }
            if (detailedLightChart) {
                detailedLightChart.data.labels.push(timeLabel);
                detailedLightChart.data.datasets[0].data.push(l);
            }
        });
    } catch (error) {
        console.error("Error loading weather history:", error);
    }

    allCharts.forEach(c => {
        if (c) c.update("none");
    });
}

// Attach User Range Selector listeners
document.addEventListener('DOMContentLoaded', () => {
    setupRangeSelectorListeners();
});
setTimeout(setupRangeSelectorListeners, 500);

function setupRangeSelectorListeners() {
    const rangeBar = document.getElementById('user-time-range-bar');
    if (!rangeBar || rangeBar.dataset.initialized) return;
    rangeBar.dataset.initialized = 'true';

    const pills = rangeBar.querySelectorAll('.range-pill');
    const datePicker = document.getElementById('user-chart-date-picker');

    if (datePicker) {
        const todayStr = new Date().toISOString().split('T')[0];
        datePicker.max = todayStr;
        datePicker.value = todayStr;

        datePicker.addEventListener('change', () => {
            if (!datePicker.value) return;
            pills.forEach(p => p.classList.remove('active'));
            initializeChartHistory('custom', datePicker.value);
        });
    }

    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const range = pill.getAttribute('data-range');
            initializeChartHistory(range);
        });
    });
}

// Real-time listener for weather_history updates so new history records automatically update charts without page refresh
let historyListenerUnsubscribe = null;
let isFirstHistorySnapshotUser = true;
function setupRealtimeHistoryListener() {
    if (historyListenerUnsubscribe) return;

    try {
        historyListenerUnsubscribe = db.collection('weather_history')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .onSnapshot(snapshot => {
                if (isFirstHistorySnapshotUser) {
                    isFirstHistorySnapshotUser = false;
                    return; // Skip first snapshot to avoid redundant reload on page open
                }
                if (!snapshot.empty && !snapshot.metadata.hasPendingWrites) {
                    loadWeeklyData();
                    if (currentSelectedRange === 'today' || currentSelectedRange === '7d' || currentSelectedRange === '30d') {
                        initializeChartHistory(currentSelectedRange);
                    }
                }
            }, err => console.warn("Realtime history sync note:", err));
    } catch (e) {
        console.warn("Failed to attach weather_history onSnapshot:", e);
    }
}

let lastUserChartUpdateTimestamp = 0;
const USER_CHART_UPDATE_INTERVAL_MS = 60000; // 1 minute interval for adding new points

function updateCharts(rain, temp, hum, pres, water, light) {
    const now = new Date();
    const timeLabel = formatDateTimeLabel(now);
    const maxPoints = 30; // Clean fixed 30-point window

    const nowMs = now.getTime();
    const isNewPointDue = (lastUserChartUpdateTimestamp > 0) && (nowMs - lastUserChartUpdateTimestamp >= USER_CHART_UPDATE_INTERVAL_MS);

    const updateChartData = (chart, value, label) => {
        if (!chart || value === undefined || isNaN(value)) return;
        if (isNewPointDue) {
            chart.data.labels.push(label);
            chart.data.datasets[0].data.push(value);
            if (chart.data.labels.length > maxPoints) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
        } else {
            // Update last point in-place for real-time responsiveness without overcrowding
            if (chart.data.datasets[0].data.length > 0) {
                const lastIdx = chart.data.datasets[0].data.length - 1;
                chart.data.datasets[0].data[lastIdx] = value;
                chart.data.labels[lastIdx] = label;
            } else {
                chart.data.labels.push(label);
                chart.data.datasets[0].data.push(value);
            }
        }
        chart.update("none");
    };

    if (!isNaN(rain)) {
        updateChartData(chartRain, rain, timeLabel);
        updateChartData(detailedRainChart, rain, timeLabel);
    }
    if (!isNaN(temp)) updateChartData(detailedTempChart, temp, timeLabel);
    if (!isNaN(hum)) updateChartData(detailedHumChart, hum, timeLabel);
    if (!isNaN(pres)) updateChartData(detailedPresChart, pres, timeLabel);
    if (water >= 0) updateChartData(detailedWaterChart, water, timeLabel);
    if (light >= 0) updateChartData(detailedLightChart, light, timeLabel);

    // Update Atmospheric Chart (Double Dataset)
    if (chartAtmo && !isNaN(temp) && !isNaN(hum)) {
        if (isNewPointDue) {
            chartAtmo.data.labels.push(timeLabel);
            chartAtmo.data.datasets[0].data.push(temp);
            chartAtmo.data.datasets[1].data.push(hum);
            if (chartAtmo.data.labels.length > maxPoints) {
                chartAtmo.data.labels.shift();
                chartAtmo.data.datasets[0].data.shift();
                chartAtmo.data.datasets[1].data.shift();
            }
        } else {
            if (chartAtmo.data.datasets[0].data.length > 0) {
                const lastIdx = chartAtmo.data.datasets[0].data.length - 1;
                chartAtmo.data.datasets[0].data[lastIdx] = temp;
                chartAtmo.data.datasets[1].data[lastIdx] = hum;
                chartAtmo.data.labels[lastIdx] = timeLabel;
            } else {
                chartAtmo.data.labels.push(timeLabel);
                chartAtmo.data.datasets[0].data.push(temp);
                chartAtmo.data.datasets[1].data.push(hum);
            }
        }
        chartAtmo.update("none");
    }

    if (isNewPointDue) {
        lastUserChartUpdateTimestamp = nowMs;
    }
}

function updateStatusUI(text, color, isOnline) {
    const dotClass = isOnline ? 'pulse-dot online' : 'pulse-dot offline';
    // Toggle online/offline state class on the pill so its background,
    // border and text reflect the real status (not always green).
    const setContainerClass = (el) => {
        if (!el) return;
        el.classList.toggle('is-online', isOnline);
        el.classList.toggle('is-offline', !isOnline);
    };
    setContainerClass(systemStatusContainer);
    setContainerClass(systemStatusContainerDesktop);
    if (systemStatusText) systemStatusText.innerText = text;
    if (systemStatusDot) {
        systemStatusDot.className = dotClass;
        systemStatusDot.style.background = color;
    }
    if (systemStatusTextDesktop) systemStatusTextDesktop.innerText = text;
    if (systemStatusDotDesktop) {
        systemStatusDotDesktop.className = dotClass;
        systemStatusDotDesktop.style.background = color;
    }
}

function refreshSystemStatus() {
    if (!lastSeenTimestamp) return;
    const diffMinutes = (new Date() - lastSeenTimestamp) / 1000 / 60;
    if (diffMinutes >= 15) {
        updateStatusUI("Device Offline", "#ef4444", false);
    } else {
        updateStatusUI("System Active", "#10b981", true);
    }
}

// Heartbeat Monitor - Force status check every 30 seconds
setInterval(refreshSystemStatus, 30000);

// Dynamic baselines from Firebase moved to top for better scoping
function fetchAdminConfig() {
    const handleConfigData = (data) => {
        if (!data) return;
        // Store the admin-configured alert text; the Sensor System Notice shows
        // it only while an elevated state (Warning/Emergency) is active.
        __adminAlertMessage = data.alertMessageL2 || data.alertMessage || '';
        if (data.alertThreshold) {
            alertThresholdVal = parseFloat(data.alertThreshold);
        }

        // Apply Model Weights & Offsets
        modelWeights = {
            pres: data.weightPres || 40,
            hum: data.weightHum || 20,
            light: data.weightLight || 20,
            rain: data.weightRain || 20
        };
        sensorOffsets = {
            temp: data.tempOffset || 0,
            water: data.waterOffset || 0
        };
        physicalMountHeight = data.mountHeight || 200;
        maxClearSkyLux = data.maxClearLux || 65000;
        standardBasePressure = data.basePressure || 1013;

        // Apply Chart Settings
        if (data.graphTension !== undefined) {
            currentGraphTension = data.graphTension;
        }
        if (data.graphWindow !== undefined) {
            currentGraphWindow = data.graphWindow;
        }

        const allCharts = [
            chartRain, chartAtmo,
            detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart,
            detailedWaterChart, detailedLightChart,
            weeklyRainChart
        ];

        allCharts.forEach(c => {
            if (c) {
                c.options.elements.line.tension = currentGraphTension;
                c.update('none');
            }
        });

        if (currentSensorData.temp !== undefined) {
            updateStatusAndRisk(
                currentSensorData.rain || 0,
                currentSensorData.rainRate || 0,
                currentSensorData.water || 0,
                currentSensorData.cloudCover || 0,
                currentSensorData.light || 0
            );
        }
    };

    let configFirestoreUnsub = null;

    const listenFirestoreConfig = () => {
        if (configFirestoreUnsub) return;
        configFirestoreUnsub = db.collection('weather').doc('config').onSnapshot(doc => {
            handleConfigData(doc.exists ? doc.data() : null);
        });
    };

    listenFirestoreConfig();
}

function updateStatusAndRisk(dailyRain, rainRate, water, cloudCover, light) {
    let status = "Safe";
    let risk = "Conditions are stable. Sensors reporting normal levels.";
    let weatherType = "sunny";

    const dangerThreshold = alertThresholdVal;
    const warningThreshold = alertThresholdVal * 0.5;
    const maxChannelCapacity = Math.max(0, physicalMountHeight - 25); // highest measurable level (sensor height − 25 cm blind zone)

    // --- 1. Risk & Flood Alert Status (Based on dailyRain accum & water level) ---
    if (water >= maxChannelCapacity) {
        status = "FLOODING";
        risk = `CRITICAL: Drainage overflow detected! Water level is at ${water.toFixed(1)} cm. Evacuate to higher ground immediately.`;
    } else if (water >= (maxChannelCapacity * 0.75)) {
        status = "HIGH RISK";
        risk = `ALERT: Local water levels are extremely high (${water.toFixed(1)} cm). Overflow threat is imminent. Move to higher ground now.`;
    } else if (dailyRain >= dangerThreshold) {
        status = "CRITICAL";
        risk = `Extreme danger: Daily rainfall threshold of ${dangerThreshold.toFixed(2)}mm reached! Seek higher ground and go to the nearest evacuation center.`;
    } else if (dailyRain >= warningThreshold) {
        status = "WARNING";
        risk = `Heavy rain: Cumulative daily rainfall rising toward the threshold of ${dangerThreshold.toFixed(2)}mm. Prepare your go-bag and stay alert.`;
    } else if (dailyRain > 0) {
        status = "ALERT";
        risk = `Precipitation recorded today (${dailyRain.toFixed(1)} mm). Monitoring conditions closely.`;
    }

    // --- 2. Visual Weather Background (Based on ACTIVE rainRate mm/h) ---
    if (rainRate >= 50.0) {
        weatherType = "stormy";
    } else if (rainRate > 0.0) {
        weatherType = "rainy";
    } else {
        const hour = new Date().getHours();
        const isDaytime = hour >= 5 && hour < 18; // 5:00 AM to 6:00 PM

        if (hour >= 18 || hour < 5) {
            weatherType = 'night';
        } else if (isDaytime && light !== undefined && light >= 0 && light < 6000) {
            weatherType = 'cloudy';
        } else {
            weatherType = 'sunny';
        }
    }

    if (typeof setWeatherBackground === 'function') setWeatherBackground(weatherType);

    // Hero banner escalation tier (drives visual state of the whole page)
    let heroTier = 'safe';
    if (status === "FLOODING" || status === "HIGH RISK" || status === "CRITICAL") heroTier = 'danger';
    else if (status === "WARNING") heroTier = 'warning';
    else if (status === "ALERT") heroTier = 'watch';
    applyHeroTier(heroTier); // also sets currentRiskTier + logs transitions
    updateWaterThresholdBar(water);
    updateRainThresholdBar(dailyRain);
    updateSensorSystemNotice();

    // Trigger Web Push notification if danger level escalated
    if (status === "WARNING" || status === "HIGH RISK" || status === "CRITICAL" || status === "FLOODING") {
        triggerFloodPushNotification(status, risk);
    }
}

// ── PWA & Web Push Notification System ──────────────────────────────────
let deferredInstallPrompt = null;
let lastNotifiedStatus = "Safe";

// 1. Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('../service-worker.js')
            .then(reg => console.log('[PWA] Service Worker registered:', reg.scope))
            .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
    });
}

// 2. Handle PWA Install Prompt
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
});

const triggerPWAInstall = async () => {
    // Open the guide popup rather than firing the native prompt directly:
    // it explains what type of install this is, gives the manual steps for
    // this device, and shows how the app will appear on the phone. The
    // guide's own "Install Now" button fires the native prompt afterwards.
    // (Replaces the old alert(), which truncated on mobile and stripped
    // formatting.)
    openInstallGuide();
};

const settingsInstallBtn = document.getElementById('settings-install-btn');
if (settingsInstallBtn) settingsInstallBtn.addEventListener('click', triggerPWAInstall);

// ── App Installation Guide Modal ──────────────────────────────────────────
// Opened from the "Install App" button. Detects the device/browser so the
// steps and the install "type" shown match how installation actually works
// there. The old native alert() truncated on mobile and stripped formatting.

const installGuideModal = document.getElementById('install-guide-modal');
const installGuideClose = document.getElementById('install-guide-close');
const installGuideDismiss = document.getElementById('install-guide-dismiss');
const installGuideAction = document.getElementById('install-guide-action');
const installGuideSub = document.getElementById('install-guide-sub');
const installGuideTypeChip = document.getElementById('install-guide-type-chip');
const installGuideTypeText = document.getElementById('install-guide-type-text');
const installGuideSteps = document.getElementById('install-guide-steps');
const installGuideNoteText = document.getElementById('install-guide-note-text');

let lastFocusedBeforeInstall = null;

// Device/browser detection — drives the subtitle, the type chip and steps.
function detectInstallTarget() {
    const ua = navigator.userAgent || '';
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true; // iOS Safari
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
    const isAndroid = /Android/i.test(ua);
    const isSamsung = /SamsungBrowser/i.test(ua);
    const isFirefox = /Firefox\//i.test(ua) && !/FxiOS\//.test(ua);
    const isEdge = /Edg\//i.test(ua);
    const isChromeLike = /Chrome\//i.test(ua) && !/Edg\//i.test(ua);
    return { isStandalone, isIOS, isAndroid, isSamsung, isFirefox, isEdge, isChromeLike };
}

// Per-platform copy: what type of install it is, plus the exact steps.
function buildInstallGuide() {
    const d = detectInstallTarget();
    const steps = [];
    let label = 'Web App (PWA)';
    let icon = 'smartphone';
    let sub = 'Your device';
    let typeText = 'BRIANE installs as a Progressive Web App — a real app icon on your home screen, without going through an app store.';

    if (installGuideModal) installGuideModal.classList.remove('is-installed');

    if (d.isStandalone) {
        sub = 'Already installed';
        label = 'Installed';
        icon = 'check-circle-2';
        typeText = 'BRIANE is already installed on this device — you are running it in its own full-screen app window right now, without the browser address bar.';
        steps.push('BRIANE already appears on your home screen or app list with its own icon.');
        if (installGuideModal) installGuideModal.classList.add('is-installed');
    } else if (d.isIOS) {
        sub = 'Your device: iPhone / iPad';
        label = 'Add to Home Screen';
        icon = 'share';
        typeText = 'iPhone and iPad cannot install a web app the normal way. Safari uses "Add to Home Screen" instead — the result is the same: a real BRIANE icon that opens full-screen.';
        steps.push('Tap the <strong>Share</strong> button (square with an upward arrow) in the Safari toolbar.');
        steps.push('Scroll the share sheet down and tap <strong>Add to Home Screen</strong>.');
        steps.push('Confirm the name <strong>BRIANE</strong>, then tap <strong>Add</strong> in the top-right corner.');
        steps.push('The BRIANE icon is now on your home screen — tap it to open the app.');
    } else if (d.isAndroid && d.isSamsung) {
        sub = 'Your device: Android (Samsung Internet)';
        label = 'Install App (Samsung)';
        typeText = 'Samsung Internet can install BRIANE as a Progressive Web App — a home-screen icon that opens in its own full-screen window.';
        steps.push('Tap the <strong>≡ (Menu)</strong> button in the bottom toolbar.');
        steps.push('Tap <strong>Add page to</strong> → <strong>Home screen</strong>.');
        steps.push('Tap <strong>Add</strong> to confirm.');
    } else if (d.isAndroid && d.isFirefox) {
        sub = 'Your device: Android (Firefox)';
        label = 'Install App (Firefox)';
        typeText = 'Firefox for Android can install BRIANE as a Progressive Web App — a home-screen icon that opens without the browser interface.';
        steps.push('Tap the <strong>⋮ (three dots)</strong> menu at the top-right.');
        steps.push('Tap <strong>Install</strong> or <strong>Add to Home screen</strong>.');
        steps.push('Tap <strong>Install</strong> to confirm.');
    } else if (d.isAndroid) {
        sub = 'Your device: Android (Chrome)';
        label = 'Install App (Chrome)';
        typeText = 'BRIANE installs as a Progressive Web App — a real app icon in your app drawer and on your home screen, without going through the Play Store.';
        steps.push('Tap the <strong>⋮ (three dots)</strong> menu at the top-right of Chrome.');
        steps.push('Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.');
        steps.push('Tap <strong>Install</strong> — the BRIANE icon is added straight away.');
    } else if (d.isEdge) {
        sub = 'Your device: Desktop (Edge)';
        label = 'Install App (Edge)';
        typeText = 'Edge installs BRIANE as a Progressive Web App — a taskbar entry that opens in a tidy window without browser tabs.';
        steps.push('Click the <strong>install icon (⬇)</strong> at the right end of the address bar, or open the <strong>⋯</strong> menu.');
        steps.push('Choose <strong>Install this site as an app</strong>.');
        steps.push('Click <strong>Install</strong> to confirm.');
    } else if (d.isChromeLike) {
        sub = 'Your device: Desktop (Chrome)';
        label = 'Install App (Chrome)';
        typeText = 'Chrome installs BRIANE as a Progressive Web App — a shortcut in your app list that opens in its own window without browser tabs.';
        steps.push('Click the <strong>install icon (⬇)</strong> at the right end of the address bar.');
        steps.push('Or open the <strong>⋮ (three dots)</strong> menu → <strong>Cast, save and share</strong> → <strong>Install page as app…</strong>.');
        steps.push('Click <strong>Install</strong> to confirm.');
    } else if (d.isFirefox) {
        sub = 'Your device: Desktop (Firefox)';
        label = 'Pin to Taskbar (Firefox)';
        icon = 'pin';
        typeText = 'Firefox has no one-click web-app installer, so pinning BRIANE to your taskbar or dock gives the same instant launcher as an installed app.';
        steps.push('Open the <strong>⋮ (three dots)</strong> menu at the top-right.');
        steps.push('Choose <strong>More tools</strong> → <strong>Pin to taskbar</strong> (Windows) or <strong>Add to Dock</strong> (macOS).');
    } else {
        sub = 'Your device / browser';
        typeText = 'BRIANE installs as a Progressive Web App — a real icon that opens the dashboard full-screen, without going through an app store.';
        steps.push('Open your browser\'s <strong>main menu</strong> (⋮, ≡, or the Share icon).');
        steps.push('Look for <strong>Install app</strong>, <strong>Add to Home screen</strong>, or <strong>Add to Dock</strong>.');
        steps.push('Confirm the install — the BRIANE icon is then added to your device.');
    }

    steps.push('To remove it later, delete the BRIANE icon from your home screen or app list.');

    if (installGuideSub) installGuideSub.textContent = sub;
    if (installGuideTypeText) installGuideTypeText.textContent = typeText;
    if (installGuideTypeChip) {
        installGuideTypeChip.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
    }
    if (installGuideSteps) {
        installGuideSteps.innerHTML = steps.map(s => `<li>${s}</li>`).join('');
    }
    if (installGuideNoteText) {
        installGuideNoteText.textContent = d.isStandalone
            ? 'You are using the installed app right now — there is nothing else to install.'
            : 'Installing does not change your account, your phone number, or the alerts you receive. You can remove it at any time by deleting the icon from your home screen.';
    }
    if (window.lucide) lucide.createIcons();
}

// ── Shared Modal Scroll Lock ────────────────────────────────────────────────
// `overflow:hidden` on <body> is ignored by iOS Safari, so the page behind
// still rubber-bands. Pinning the body is the reliable fix. Reference-counted
// so a second modal could be added later without breaking the first.

let installLockCount = 0;
let lockedInstallScrollY = 0;

function lockPageScroll() {
    if (installLockCount === 0) {
        const scrollbar = window.innerWidth - document.documentElement.clientWidth;
        lockedInstallScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${lockedInstallScrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    }
    installLockCount++;
}

function unlockPageScroll() {
    if (installLockCount === 0) return;
    installLockCount--;
    if (installLockCount === 0) {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.paddingRight = '';
        window.scrollTo(0, lockedInstallScrollY);
    }
}

function openInstallGuide() {
    if (!installGuideModal) return;
    lastFocusedBeforeInstall = document.activeElement;
    buildInstallGuide();
    installGuideModal.hidden = false;
    lockPageScroll();
    if (installGuideClose) installGuideClose.focus();
}

function closeInstallGuide() {
    if (!installGuideModal || installGuideModal.hidden) return;
    installGuideModal.hidden = true;
    installGuideModal.classList.remove('is-installed');
    unlockPageScroll();
    if (lastFocusedBeforeInstall && typeof lastFocusedBeforeInstall.focus === 'function') {
        lastFocusedBeforeInstall.focus();
    }
}

if (installGuideClose) installGuideClose.addEventListener('click', closeInstallGuide);
if (installGuideDismiss) installGuideDismiss.addEventListener('click', closeInstallGuide);

if (installGuideAction) {
    installGuideAction.addEventListener('click', async () => {
        // If the browser exposed a native prompt, fire it; otherwise the
        // manual steps above are the instruction, so just close.
        if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            const { outcome } = await deferredInstallPrompt.userChoice;
            if (outcome === 'accepted') console.log('[PWA] User installed BRIANE from guide');
            deferredInstallPrompt = null;
        }
        closeInstallGuide();
    });
}

if (installGuideModal) {
    // Clicking the backdrop (but not the dialog) closes it.
    installGuideModal.addEventListener('click', (e) => {
        if (e.target === installGuideModal) closeInstallGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !installGuideModal.hidden) closeInstallGuide();
    });
}

// 3. Web Push Flood Notification Trigger
function triggerFloodPushNotification(status, message) {
    if (status === "Safe" || status === "ALERT" || status === lastNotifiedStatus) return;
    lastNotifiedStatus = status;

    // Respect the user's explicit opt-out. Turning the bell off stops in-app
    // flood popups even though browsers won't let a page revoke its own
    // Notification permission (that's a browser-level setting).
    if (localStorage.getItem('briane_notif_on') === 'false') return;

    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const notifTitle = `BRIANE FLOOD WARNING: ${status}`;
            const notifOptions = {
                body: message,
                icon: '../assets/icon-192.png',
                badge: '../assets/icon-192.png',
                vibrate: [300, 150, 300, 150, 300],
                tag: 'briane-flood-alert',
                renotify: true
            };
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification(notifTitle, notifOptions);
                });
            } else {
                new Notification(notifTitle, notifOptions);
            }
        } catch (e) {
            console.warn("Notification error:", e);
        }
    }
}

// 4. Notification Permission UI Setup
// The header bell is a real ON/OFF toggle. "On" = user enabled flood popups
// (and has granted browser permission). "Off" = user muted them. Because the
// browser owns the underlying Notification permission, "off" is enforced at
// the app level via a persisted preference that triggerFloodPushNotification
// honours.
const NOTIF_ON_KEY = 'briane_notif_on';

function initNotificationControls() {
    // Guard: this is invoked from both DOMContentLoaded and a setTimeout fallback —
    // without this flag the enable/dismiss buttons accumulated duplicate listeners.
    if (document.body.dataset.notifControlsInitialized) return;
    document.body.dataset.notifControlsInitialized = 'true';

    const notifBtn = document.getElementById('pwa-notif-btn');
    const notifBanner = document.getElementById('push-notif-banner');
    const enableBtn = document.getElementById('push-notif-enable-btn');
    const dismissBtn = document.getElementById('push-notif-dismiss-btn');

    if (!('Notification' in window)) {
        if (notifBtn) notifBtn.style.display = 'none';
        if (notifBanner) notifBanner.style.display = 'none';
        return;
    }

    const isOn = () => localStorage.getItem(NOTIF_ON_KEY) !== 'false';

    const renderBell = () => {
        if (!notifBtn) return;
        const on = isOn() && Notification.permission === 'granted';
        // Refresh the lucide icon so it reflects state (bell = on, bell-off = muted).
        notifBtn.classList.toggle('active', on);
        notifBtn.classList.toggle('off', !on);
        notifBtn.innerHTML = `<i data-lucide="${on ? 'bell' : 'bell-off'}"></i>`;
        notifBtn.title = on
            ? "Flood Notifications Enabled — click to mute"
            : (Notification.permission === 'default'
                ? "Enable Flood Alert Push Notifications"
                : "Flood Notifications muted — click to re-enable");
        if (window.lucide) lucide.createIcons();
    };

    const setBannerState = (muted) => {
        if (!notifBanner) return;
        const strong = notifBanner.querySelector('.push-notif-text strong');
        const para = notifBanner.querySelector('.push-notif-text p');
        const enableLabel = notifBanner.querySelector('#push-notif-enable-btn');
        if (muted) {
            if (strong) strong.textContent = 'Flood Warning Alerts are Muted';
            if (para) para.textContent = 'You won\u2019t receive popup flood warnings right now. Turn them back on whenever you\u2019re ready.';
            if (enableLabel) enableLabel.textContent = 'Turn On';
        } else {
            if (strong) strong.textContent = 'Enable Instant Flood Warning Alerts';
            if (para) para.textContent = 'Receive immediate popup alerts on your screen when river water levels or rainfall reach danger thresholds.';
            if (enableLabel) enableLabel.textContent = 'Enable';
        }
        if (window.lucide) lucide.createIcons();
    };

    const updateNotifUI = () => {
        if (Notification.permission === 'granted') {
            renderBell();
            if (notifBanner) notifBanner.style.display = 'none';
        } else if (Notification.permission === 'default') {
            setBannerState(isOn() === false);   // muted before ever enabling
            const dismissed = localStorage.getItem('briane_notif_banner_dismissed');
            if (notifBanner && !dismissed) notifBanner.style.display = 'flex';
            else if (notifBanner) notifBanner.style.display = 'none';
            renderBell();
        } else {
            // 'denied' — browser-level, can't ask again from this page.
            if (notifBanner) notifBanner.style.display = 'none';
            renderBell();
        }
    };

    // Turn notifications ON (request browser permission if still default).
    const enableNotifs = async () => {
        try {
            let permission = Notification.permission;
            if (permission === 'default') {
                permission = await Notification.requestPermission();
            }
            if (permission === 'granted') {
                localStorage.setItem(NOTIF_ON_KEY, 'true');
                localStorage.removeItem('briane_notif_banner_dismissed');
                updateNotifUI();
                new Notification("Flood Notifications Activated", {
                    body: "You will receive immediate warnings when river levels or rainfall reach danger levels.",
                    icon: "../assets/icon-192.png"
                });
            } else {
                // User closed the prompt (now 'default') or blocked it ('denied').
                updateNotifUI();
                if (permission === 'denied') {
                    showDashboardToast(
                        "Notifications are blocked by your browser. Click the \u{1F512} icon in the address bar, then allow Notifications, and refresh.",
                        'info'
                    );
                }
            }
        } catch (err) {
            console.warn("Permission request failed:", err);
            updateNotifUI();
        }
    };

    // Turn notifications OFF (mute) — persisted so triggers are suppressed.
    const muteNotifs = () => {
        localStorage.setItem(NOTIF_ON_KEY, 'false');
        updateNotifUI();
        // Re-show the banner (reflecting the muted state) so the user can easily
        // turn alerts back on, but only when the browser still allows us to ask.
        if (notifBanner && Notification.permission !== 'denied') {
            setBannerState(true);
            notifBanner.style.display = 'flex';
        }
    };

    // The bell is the toggle; the banner Enable button only ever turns ON.
    if (notifBtn) {
        notifBtn.addEventListener('click', () => {
            if (isOn() && Notification.permission === 'granted') muteNotifs();
            else enableNotifs();
        });
    }
    if (enableBtn) enableBtn.addEventListener('click', enableNotifs);
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            if (notifBanner) notifBanner.style.display = 'none';
            localStorage.setItem('briane_notif_banner_dismissed', 'true');
        });
    }

    updateNotifUI();
}
document.addEventListener('DOMContentLoaded', initNotificationControls);
setTimeout(initNotificationControls, 600);

// Logout Logic (Unified for Sidebar and Mobile Header)
document.querySelectorAll('.logout-trigger').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to sign out?")) {
            try {
                await auth.signOut();
                window.location.href = "../index.html";
            } catch (error) {
                console.error("Logout failed:", error);
            }
        }
    });
});

// ═══════════════════════════════════════════════
// SETTINGS SECTION
// ═══════════════════════════════════════════════

function showSettingsMsg(id, message, isSuccess = true) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.className = `settings-msg ${isSuccess ? 'success' : 'error'}`;
    el.style.display = 'flex';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// Lightweight toast for header/banner helpers (e.g. notification hints).
const DASH_TOAST_KEY = 'dash-toast';
function showDashboardToast(message, type = 'info', duration = 6000) {
    let toast = document.getElementById(DASH_TOAST_KEY);
    if (!toast) {
        toast = document.createElement('div');
        toast.id = DASH_TOAST_KEY;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add('show');
    clearTimeout(showDashboardToast._timer);
    showDashboardToast._timer = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

function checkPhoneStatus(phone) {
    const banner = document.getElementById('phone-warning-banner');
    const badge = document.getElementById('phone-status-badge');
    const isConfigured = phone && typeof phone === 'string' && phone.trim().startsWith('+') && phone.trim().length >= 10;

    if (banner) {
        banner.style.display = isConfigured ? 'none' : 'flex';
    }
    if (badge) {
        badge.className = `settings-badge ${isConfigured ? 'verified' : 'warning'}`;
        badge.innerHTML = isConfigured 
            ? '<i data-lucide="shield-check"></i> Configured' 
            : '<i data-lucide="alert-triangle"></i> Not Configured';
        lucide.createIcons();
    }
    return isConfigured;
}

// Action button on Home tab Emergency Phone Alert Banner
const phoneAlertActionBtn = document.getElementById('phone-alert-action-btn');
if (phoneAlertActionBtn) {
    phoneAlertActionBtn.addEventListener('click', () => {
        switchToSection('settings');
        const phoneInput = document.getElementById('settings-phone');
        if (phoneInput) {
            setTimeout(() => {
                phoneInput.focus();
                phoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 200);
        }
    });
}

// ── Load Settings on Auth ──────────────────────────────────────────────────
function loadUserSettings(user) {
    if (!user) return;
    const emailDisplay = document.getElementById('settings-email-display');

    // 1. Instantly set email synchronously from Auth object (no loading delay!)
    const initialEmail = user.email || '—';
    if (emailDisplay) {
        if (emailDisplay.tagName === 'INPUT') emailDisplay.value = initialEmail;
        else emailDisplay.textContent = initialEmail;
    }

    // 2. Fetch Firestore profile for emergency contact phone number
    db.collection('users').doc(user.uid).get().then(doc => {
        const data = doc.exists ? doc.data() : {};

        const finalEmail = user.email || data.email || '—';
        if (emailDisplay) {
            if (emailDisplay.tagName === 'INPUT') emailDisplay.value = finalEmail;
            else emailDisplay.textContent = finalEmail;
        }

        // Phone number is purely from Firestore contact data
        const phoneInput = document.getElementById('settings-phone');
        const currentPhone = data.phoneNumber || '';
        if (phoneInput) phoneInput.value = currentPhone;
        checkPhoneStatus(currentPhone);
    }).catch(e => {
        console.warn('Settings load error:', e);
        checkPhoneStatus('');
    });
}

// NOTE: settings loading is handled inside the single onAuthStateChanged handler
// above (which calls loadUserSettings after the disabled-account check). A second
// handler here used to trigger a duplicate Firestore fetch per login.

// ── Save Phone Number ──────────────────────────────────────────────────────
const savePhoneBtn = document.getElementById('save-phone-btn');
if (savePhoneBtn) {
    savePhoneBtn.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;

        const phone = document.getElementById('settings-phone')?.value.trim();
        if (!phone) {
            showSettingsMsg('profile-msg', 'Phone number is required. Please enter your mobile number.', false);
            return;
        }
        // Philippine mobile numbers only — the device sends SMS domestically, so
        // a wrong-country or wrong-length number (e.g. a dropped digit) fails on
        // EVERY dispatch attempt and wastes load. Accept the common local formats
        // and normalize to E.164 (+639XXXXXXXXX) before saving.
        const digits = phone.replace(/\D/g, '');
        let normalized = null;
        if (/^09\d{9}$/.test(digits)) normalized = '+63' + digits.substring(1);   // 09XXXXXXXXX
        else if (/^9\d{9}$/.test(digits)) normalized = '+63' + digits;            // 9XXXXXXXXX
        else if (/^639\d{9}$/.test(digits)) normalized = '+' + digits;            // 639XXXXXXXXX
        if (!normalized) {
            showSettingsMsg('profile-msg', 'Invalid Philippine mobile number. Use 09123456789 or +639123456789 (10 digits after 63).', false);
            return;
        }

        try {
            savePhoneBtn.disabled = true;
            await db.collection('users').doc(user.uid).update({ phoneNumber: normalized });

            // Signal ESP32 that user phone list changed
            const version = Date.now();
            db.collection('weather').doc('config').set({ usersVersion: version }, { merge: true }).catch(e => console.warn('Firestore usersVersion bump failed:', e));

            checkPhoneStatus(normalized);
            showSettingsMsg('profile-msg', '✓ Correct phone number saved! Emergency flood SMS alerts activated.', true);
        } catch (err) {
            console.error('Save phone error:', err);
            showSettingsMsg('profile-msg', 'Failed to save phone number. Please try again.', false);
        } finally {
            savePhoneBtn.disabled = false;
        }
    });
}

// ── Change Password ────────────────────────────────────────────────────────
const changePasswordBtn = document.getElementById('change-password-btn');
if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;

        const currentPw = document.getElementById('settings-current-pw')?.value;
        const newPw = document.getElementById('settings-new-pw')?.value;
        const confirmPw = document.getElementById('settings-confirm-pw')?.value;

        if (!currentPw || !newPw || !confirmPw) {
            showSettingsMsg('password-msg', 'Please fill in all password fields.', false);
            return;
        }
        if (newPw !== confirmPw) {
            showSettingsMsg('password-msg', 'New passwords do not match.', false);
            return;
        }
        if (newPw.length < 6) {
            showSettingsMsg('password-msg', 'Password must be at least 6 characters.', false);
            return;
        }

        try {
            changePasswordBtn.disabled = true;
            changePasswordBtn.textContent = 'Updating…';

            // Re-authenticate before sensitive change
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPw);
            await user.reauthenticateWithCredential(credential);
            await user.updatePassword(newPw);

            // Clear fields
            ['settings-current-pw', 'settings-new-pw', 'settings-confirm-pw'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });

            showSettingsMsg('password-msg', '✓ Password updated successfully!', true);
        } catch (err) {
            console.error('Password change error:', err);
            let msg = 'Failed to update password.';
            if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') msg = 'Current password is incorrect.';
            else if (err.code === 'auth/weak-password') msg = 'New password is too weak.';
            else if (err.code === 'auth/too-many-requests') msg = 'Too many attempts. Try again later.';
            showSettingsMsg('password-msg', msg, false);
        } finally {
            changePasswordBtn.disabled = false;
            changePasswordBtn.innerHTML = '<i data-lucide="lock"></i> Update Password';
            lucide.createIcons();
        }
    });
}

// ── Settings Password Visibility Toggles ──────────────────────────────────
document.querySelectorAll('.settings-toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}"></i>`;
        lucide.createIcons();
    });
});

// ── Danger Zone: Two-Step Account Deletion ────────────────────────────────
const deleteAccountBtn = document.getElementById('delete-account-btn');
if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;

        // Step 1: Ask user if they really want to delete the account
        const confirmDelete = confirm(
            'Are you sure you want to delete your account?\n\nThis permanently removes your profile and all associated data. This cannot be undone.'
        );
        if (!confirmDelete) return;

        // Step 2: Next ask for their password to proceed with deletion
        const userPassword = prompt(
            '🔐 Please enter your password to confirm and proceed with account deletion:'
        );
        if (!userPassword || userPassword.trim() === '') {
            showSettingsMsg('danger-msg', 'Deletion cancelled — password is required to delete your account.', false);
            return;
        }

        try {
            deleteAccountBtn.disabled = true;
            deleteAccountBtn.innerText = 'Deleting Account...';

            const emailEl = document.getElementById('settings-email-display');
            const userEmail = user.email || (emailEl?.tagName === 'INPUT' ? emailEl.value : emailEl?.textContent);
            if (!userEmail || userEmail === '—' || userEmail === 'Loading...') {
                showSettingsMsg('danger-msg', 'User email not found. Please sign in again.', false);
                deleteAccountBtn.disabled = false;
                deleteAccountBtn.innerHTML = '<i data-lucide="trash-2"></i> Delete Account';
                lucide.createIcons();
                return;
            }

            // Re-authenticate with password
            const credential = firebase.auth.EmailAuthProvider.credential(userEmail, userPassword);
            await user.reauthenticateWithCredential(credential);

            // Delete user document from Firestore
            try {
                await db.collection('users').doc(user.uid).delete();
            } catch (dbErr) {
                console.warn('Firestore user profile deletion note:', dbErr);
            }

            // Delete Firebase Authentication user
            await user.delete();

            // Redirect to Login Page
            window.location.href = '../index.html';

        } catch (err) {
            console.error('Delete account error:', err);
            let msg = 'Account deletion failed.';
            if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
                msg = 'Incorrect password! Account deletion cancelled.';
            } else if (err.code === 'auth/too-many-requests') {
                msg = 'Too many failed attempts. Please try again later.';
            } else if (err.message) {
                msg = err.message.replace('Firebase: ', '').split(' (')[0];
            }
            showSettingsMsg('danger-msg', msg, false);
        } finally {
            if (deleteAccountBtn) {
                deleteAccountBtn.disabled = false;
                deleteAccountBtn.innerHTML = '<i data-lucide="trash-2"></i> Delete Account';
                lucide.createIcons();
            }
        }
    });
}

// ══════════════════════════════════════════════════
// LIVE EMERGENCY DIRECTORY & EVACUATION SYNC
// ══════════════════════════════════════════════════

function initResidentEmergencyDirectory() {
    const hotlinesContainer = document.getElementById('resident-hotlines-container');
    const evacuationContainer = document.getElementById('resident-evacuation-container');

    if (!hotlinesContainer || !evacuationContainer || window._residentEmergencySyncInitialized) return;
    window._residentEmergencySyncInitialized = true;

    db.collection('systemConfig').doc('emergencyDirectory').onSnapshot((doc) => {
        if (!doc.exists) return;
        const data = doc.data();

        // Cache for the Emergency Quick Strip on Home
        if (typeof window.__brianeDirectoryCache !== 'undefined') {
            window.__brianeDirectoryCache.hotlines = Array.isArray(data.hotlines) ? data.hotlines : null;
            window.__brianeDirectoryCache.shelters = Array.isArray(data.shelters) ? data.shelters : null;
        }
        if (typeof renderEmergencyQuickStrip === 'function') renderEmergencyQuickStrip();

        // 1. Render Hotlines (Compact, Sleek, High-Tech Emergency Style)
        if (Array.isArray(data.hotlines) && data.hotlines.length > 0) {
            hotlinesContainer.innerHTML = '';
            data.hotlines.forEach(h => {
                const card = document.createElement('div');
                const isPriority = h.badgeClass === 'priority';
                card.className = `hotline-card ${isPriority ? 'priority' : ''}`;
                
                let badgeClass = 'blue';
                if (h.badgeClass && h.badgeClass !== 'priority') {
                    badgeClass = h.badgeClass;
                } else if (isPriority) {
                    badgeClass = 'red';
                }

                // Smart fallback icon
                let iconName = h.icon || 'phone-call';
                const orgLower = (h.org || '').toLowerCase() + ' ' + (h.sub || '').toLowerCase();
                if (!h.icon) {
                    if (isPriority || orgLower.includes('police') || orgLower.includes('pnp')) iconName = 'shield-alert';
                    else if (orgLower.includes('fire') || orgLower.includes('bfp')) iconName = 'flame';
                    else if (orgLower.includes('red cross') || orgLower.includes('hospital') || orgLower.includes('medic')) iconName = 'cross';
                    else if (orgLower.includes('rescue') || orgLower.includes('mdrrmo') || orgLower.includes('cdrrmo')) iconName = 'life-buoy';
                }

                const displayNum = h.number || h.callNumber || 'Dial Direct Line';

                card.innerHTML = `
                    <div class="hotline-main-info">
                        <div class="hotline-icon-badge ${badgeClass}">
                            <i data-lucide="${escapeHtmlAttr(iconName)}"></i>
                        </div>
                        <div class="hotline-text-wrap">
                            <div class="hotline-tag-row">
                                <span class="hotline-label">${escapeHtmlText(h.sub || 'Emergency Line')}</span>
                                ${isPriority ? '<span class="hotline-priority-tag"><i data-lucide="star"></i> Priority</span>' : ''}
                            </div>
                            <h4 class="hotline-org" title="${escapeHtmlAttr(h.org || 'Emergency Service')}">${escapeHtmlText(h.org || 'Emergency Service')}</h4>
                            <div class="hotline-num-row">
                                <strong class="hotline-number">${escapeHtmlText(displayNum)}</strong>
                            </div>
                        </div>
                    </div>
                    <div class="hotline-actions">
                        <a href="tel:${escapeHtmlAttr(h.callNumber || h.number || '')}" class="hotline-call-btn" title="Call ${escapeHtmlAttr(h.org || '')}">
                            <i data-lucide="phone"></i>
                            <span>Call</span>
                        </a>
                    </div>
                `;
                hotlinesContainer.appendChild(card);
            });
        }

        // 2. Render Evacuation Shelters (Refined Glass Disaster Facility Card Style)
        if (Array.isArray(data.shelters) && data.shelters.length > 0) {
            evacuationContainer.innerHTML = '';
            data.shelters.forEach(s => {
                const card = document.createElement('div');
                const statusKey = s.status || 'open';
                card.className = `evac-card evac-status-${statusKey}`;

                let statusBadgeClass = 'status-standby';
                let statusIcon = 'clock';
                let statusText = s.statusText || 'STANDBY';

                if (s.status === 'open') {
                    statusBadgeClass = 'status-open';
                    statusIcon = 'check-circle-2';
                    statusText = s.statusText || 'OPEN';
                } else if (s.status === 'full') {
                    statusBadgeClass = 'status-full';
                    statusIcon = 'users';
                    statusText = s.statusText || 'FULL';
                } else if (s.status === 'closed') {
                    statusBadgeClass = 'status-closed';
                    statusIcon = 'x-circle';
                    statusText = s.statusText || 'CLOSED';
                }

                // Helper for smart amenity icons
                const getAmenityIcon = (aText) => {
                    const t = (aText || '').toLowerCase();
                    if (t.includes('power') || t.includes('generator') || t.includes('electr')) return 'zap';
                    if (t.includes('water') || t.includes('drink')) return 'droplets';
                    if (t.includes('aid') || t.includes('med') || t.includes('clinic') || t.includes('health')) return 'heart-pulse';
                    if (t.includes('food') || t.includes('meal') || t.includes('kitchen') || t.includes('ration')) return 'utensils';
                    if (t.includes('bed') || t.includes('mat') || t.includes('sleep')) return 'bed-double';
                    if (t.includes('restroom') || t.includes('toilet') || t.includes('shower') || t.includes('bath')) return 'bath';
                    if (t.includes('wifi') || t.includes('net') || t.includes('comms') || t.includes('signal')) return 'wifi';
                    return 'check';
                };

                const amenitiesHtml = (s.amenities || []).map(a => `
                    <span class="amenity-tag">
                        <i data-lucide="${getAmenityIcon(a)}"></i>
                        <span>${escapeHtmlText(a)}</span>
                    </span>
                `).join('');

                const capacityDisplay = s.capacity
                    ? (String(s.capacity).toLowerCase().includes('person') ? s.capacity : `${s.capacity} Persons Capacity`)
                    : 'Flexible Capacity';

                card.innerHTML = `
                    <div class="evac-card-header">
                        <div class="evac-header-main">
                            <div class="evac-icon-squircle">
                                <i data-lucide="shield-check"></i>
                            </div>
                            <div class="evac-title-wrap">
                                <div class="evac-kicker-row">
                                    <span class="evac-kicker">Official Evacuation Shelter</span>
                                </div>
                                <h3 class="evac-name">${escapeHtmlText(s.name || 'Evacuation Center')}</h3>
                            </div>
                        </div>
                        <div class="evac-status-badge ${statusBadgeClass}">
                            <span class="status-pulse-dot"></span>
                            <span>${escapeHtmlText(statusText)}</span>
                        </div>
                    </div>
                    <div class="evac-card-body">
                        <div class="evac-info-deck">
                            <div class="evac-info-tile capacity-tile">
                                <div class="tile-icon-box">
                                    <i data-lucide="users"></i>
                                </div>
                                <div class="tile-content">
                                    <span class="tile-label">Capacity</span>
                                    <strong class="tile-value">${escapeHtmlText(capacityDisplay)}</strong>
                                </div>
                            </div>
                            <div class="evac-info-tile address-tile">
                                <div class="tile-icon-box">
                                    <i data-lucide="map-pin"></i>
                                </div>
                                <div class="tile-content">
                                    <span class="tile-label">Location / Address</span>
                                    <p class="tile-text" title="${escapeHtmlAttr(s.address || 'Designated Barangay Site')}">${escapeHtmlText(s.address || 'Designated Barangay Site')}</p>
                                </div>
                            </div>
                        </div>
                        ${amenitiesHtml ? `
                        <div class="evac-amenities-section">
                            <div class="amenities-title">
                                <span>On-Site Amenities &amp; Provisions</span>
                            </div>
                            <div class="evac-amenities-cluster">
                                ${amenitiesHtml}
                            </div>
                        </div>` : ''}
                    </div>
                    <div class="evac-card-footer">
                        <a href="${escapeHtmlAttr(s.mapUrl || 'https://maps.google.com')}" target="_blank" rel="noopener" class="evac-navigate-btn">
                            <div class="btn-content-wrap">
                                <div class="btn-icon-bubble">
                                    <i data-lucide="navigation"></i>
                                </div>
                                <span class="btn-text">Get Directions &amp; View Map</span>
                            </div>
                            <i data-lucide="arrow-up-right" class="btn-arrow-icon"></i>
                        </a>
                    </div>
                `;
                evacuationContainer.appendChild(card);
            });
        }

        if (window.lucide) lucide.createIcons();
    }, (err) => {
        console.warn("Real-time emergency directory sync warning:", err);
    });
}

function escapeHtmlText(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtmlAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', initResidentEmergencyDirectory);
setTimeout(initResidentEmergencyDirectory, 500);

// ══════════════════════════════════════════════════
// LIVE VALUE UPDATE FLASH — brief highlight when a
// sensor number changes so the page feels alive.
// ══════════════════════════════════════════════════
(function initDataFlash() {
    const watchedIds = [
        'water-level-value', 'rainfall-value', 'rain-rate-value', 'water-rise-rate-value',
        'temp-value', 'humidity-value', 'pressure-value', 'light-value',
        'cloud-cover-value', 'dew-point-value', 'heat-index-value', 'prediction-score-value'
    ];
    const targets = watchedIds
        .map(id => document.getElementById(id))
        .filter(el => el && el.parentElement);

    if (!targets.length || !('MutationObserver' in window)) return;

    const lastValues = new WeakMap();
    const targetSet = new Set(targets);

    const flash = (el) => {
        const prev = lastValues.get(el);
        const curr = el.textContent;
        lastValues.set(el, curr);
        if (prev === undefined || prev === curr) return;
        el.classList.remove('value-flash');
        void el.offsetWidth; // restart animation
        el.classList.add('value-flash');
        el.addEventListener('animationend', () => el.classList.remove('value-flash'), { once: true });
    };

    const observer = new MutationObserver((mutations) => {
        const seen = new Set();
        mutations.forEach(m => {
            let n = m.target;
            while (n && !targetSet.has(n)) n = n.parentElement;
            if (n && !seen.has(n)) { seen.add(n); flash(n); }
        });
    });

    targets.forEach(el => {
        lastValues.set(el, el.textContent);
        observer.observe(el, { characterData: true, childList: true, subtree: true });
    });
})();

checkDataFreshness();
