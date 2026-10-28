// Global Configuration & Baselines
let alertThresholdVal = 50.0;
let currentGraphTension = 0.3;
let currentGraphWindow = 12;
let modelWeights = { pres: 40, hum: 20, light: 20, rain: 20 };
let sensorOffsets = { temp: 0, water: 0 };
let physicalMountHeight = 200;
let maxClearSkyLux = 65000;
let standardBasePressure = 1013;
// Last resolved station label (e.g. "Barangay, City") — surfaced in the
// printable report header when present.
let adminStationLocation = '';
let lastSeenTimestamp = null;
let currentSensorData = {
    temp: NaN,
    rainRate: 0,
    water: -1,
    light: -1
};
let isFetchingForecast = false;
let cachedForecastData = null;
let lastForecastFetch = 0;

// Real-time splash dismissal: removes the loading overlay the instant the
// page is actually usable (admin auth confirmed + first live snapshot
// rendered). Idempotent, so the responsive cap, the data handlers and the
// crash-net can all fire safely without double-running.
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

// Firebase is initialized by firebase-config.js

// UI Elements
const userTableBody = document.getElementById('user-table-body');
const totalUsersCount = document.getElementById('total-users-count');
const adminLiveDateText = document.getElementById('admin-live-date-text');
const adminLiveDateTextHero = document.getElementById('admin-live-date-text-hero');


// Live Date & Time Clock
function updateAdminLiveDateTime() {
    if (!adminLiveDateText && !adminLiveDateTextHero) return;
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', options);
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (adminLiveDateText) adminLiveDateText.textContent = `${dateStr} • ${timeStr}`;
    if (adminLiveDateTextHero) adminLiveDateTextHero.textContent = `${dateStr} • ${timeStr}`;
}
updateAdminLiveDateTime();
setInterval(updateAdminLiveDateTime, 1000);

// Date/Time label helper for clean graph tooltips & x-axis ticks
function formatDateTimeLabel(date) {
    if (!date || isNaN(date.getTime())) date = new Date();
    const isToday = new Date().toDateString() === date.toDateString();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return timeStr;
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateStr}, ${timeStr}`;
}

// Escapes user-controlled strings before interpolating into innerHTML.
// Emails/phone numbers come from self-service registration, so treat them as hostile
// (a crafted email would otherwise execute script in the admin's session).
function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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

// Charts Initialization
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

let weeklyRainChart = null;
let hourlyPrecipChart = null;
let currentLatitude = 0.0;
let currentLongitude = 0.0;
let loadedForecastLatitude = null;
let loadedForecastLongitude = null;

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
    if (lat === 0 || lng === 0) return;

    // Don't re-fetch if we already have data for this approximate location
    if (loadedForecastLatitude === lat.toFixed(3) && loadedForecastLongitude === lng.toFixed(3)) return;

    loadedForecastLatitude = lat.toFixed(3);
    loadedForecastLongitude = lng.toFixed(3);

    const container = document.getElementById('forecast-days-container');
    const locLabel = document.getElementById('forecast-location-label');

    // Start both requests in parallel for maximum speed
    const weatherPromise = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weathercode&hourly=temperature_2m,precipitation,precipitation_probability,weathercode&timezone=auto`);

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

        let dailyCount = data.daily.time.length;

        for (let i = 0; i < dailyCount; i++) {
            const date = new Date(data.daily.time[i]);
            const dayName = days[date.getDay()];
            const maxTemp = data.daily.temperature_2m_max[i];
            const minTemp = data.daily.temperature_2m_min[i];
            const rainProb = data.daily.precipitation_probability_max[i];
            const code = data.daily.weathercode[i];
            const iconName = weatherIcons[code] || 'cloud';

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
                    <i data-lucide="droplet" style="width:12px;height:12px;color:#3b82f6;"></i>
                    <span>${rainProb}%</span>
                </div>
            `;
            if (container) {
                container.appendChild(card);
            }
        }

        // Render weekly precipitation chart
        renderWeeklyForecastChart(data.daily);

        // Populate 24-Hour Temperature Timeline
        populateHourlyTempTimeline();

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
        ).catch(err => {
            console.error("Timeline: Open-Meteo fetch error:", err);
            return null;
        });

        // On failure keep the previous forecast — never wipe the timeline and
        // never stamp the cache as fresh, so the next tick retries.
        if (!forecastRes || !forecastRes.ok) {
            console.error("Timeline: Open-Meteo returned no data — keeping cached forecast.");
            return;
        }

        const data = await forecastRes.json();
        if (!data || !data.hourly) {
            console.error("Timeline: Open-Meteo response missing hourly data — keeping cached forecast.");
            return;
        }

        cachedForecastData = data;
        lastForecastFetch = nowTime;
        renderTimeline(cachedForecastData);
    } catch (err) {
        console.error("Error loading hourly timeline:", err);
    } finally {
        isFetchingForecast = false;
    }
}

// Keep the timeline fresh even if the device stops pushing readings: re-applies
// the rolling "future hours" filter and refetches once the 30-min cache expires.
setInterval(populateHourlyTempTimeline, 5 * 60 * 1000);

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
                    isDay: forecastData.hourly.is_day ? forecastData.hourly.is_day[i] === 1 : true,
                    isPredicted: true
                });
                if (futureEntries.length >= 12) break;
            }
        }
    }

    container.innerHTML = '';

    // "Now" card using global sensor data
    const currentTemp = currentSensorData.temp || 0;
    const currentTempDisplay = (isNaN(currentSensorData.temp)) ? "--" : Math.round(currentSensorData.temp);

    let currentIcon = 'sun';
    const rainRate = currentSensorData.rainRate || 0;
    const water = currentSensorData.water || 0;
    const lightVal = currentSensorData.light || 0;
    const maxCapacity = physicalMountHeight * 0.8;

    if (water >= maxCapacity || rainRate >= 15.0) {
        currentIcon = 'cloud-lightning';
    } else if (rainRate > 0.0) {
        currentIcon = 'cloud-rain';
    } else {
        const hour = new Date().getHours();
        const isDaytime = hour >= 5 && hour < 18;
        if (hour >= 18 || hour < 5) {
            currentIcon = 'moon';
        } else if (isDaytime && lightVal >= 0 && lightVal < 6000) {
            currentIcon = 'cloudy';
        } else {
            currentIcon = 'sun';
        }
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
        const iconConfig = weatherCodeIcons[entry.weatherCode];
        let iconName = 'cloud';
        if (iconConfig) {
            iconName = entry.isDay ? iconConfig.day : iconConfig.night;
        }
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
    container.scrollLeft = 0;
}

async function loadWeeklyData() {
    const canvas = document.getElementById('weeklyRainChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

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
                // Lily board sends cumulative totalRainfall, so we take the max of each day
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
                        backgroundColor: 'rgba(44, 95, 151, 0.5)',
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

        // Update Summary Stats
        const totalRain = data.reduce((a, b) => a + b, 0);
        const peakRain = Math.max(...data, 0);
        const rainDays = data.filter(d => d > 0.1).length; // Count days with more than 0.1mm
        const avgTemp = tempCount > 0 ? (totalTempSum / tempCount) : 0;

        if (document.getElementById('weekly-total-rain')) document.getElementById('weekly-total-rain').innerText = totalRain.toFixed(1) + " mm";
        if (document.getElementById('weekly-peak-rain')) document.getElementById('weekly-peak-rain').innerText = peakRain.toFixed(1) + " mm";
        if (document.getElementById('weekly-rain-days')) document.getElementById('weekly-rain-days').innerText = rainDays;
        if (document.getElementById('weekly-avg-temp')) document.getElementById('weekly-avg-temp').innerText = avgTemp > 0 ? avgTemp.toFixed(1) + " °C" : "-- °C";

    } catch (error) {
        console.error("Error loading weekly data:", error);
    }
}

// Add Atmospheric Chart (Dual Dataset) for Admin Overview
const initAtmosphericChart = () => {
    const canvas = document.getElementById('atmosphericChart');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
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
                legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10, weight: '700' } } },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#ffffff',
                    padding: 10,
                    cornerRadius: 8
                }
            },
            scales: {
                y: { type: 'linear', display: true, position: 'left', grace: '5%', ticks: { font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.04)' } },
                y1: { type: 'linear', display: true, position: 'right', grace: '5%', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
                x: {
                    grid: { display: false },
                    ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { size: 10 } }
                }
            }
        }
    });
};

const initRainfallChart = () => {
    const canvas = document.getElementById('mainRainfallChart');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
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
                y: { beginAtZero: true, grace: '5%', grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { family: 'Outfit', size: 10, weight: '600' } } },
                x: {
                    grid: { display: false },
                    ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { family: 'Outfit', size: 10, weight: '600' } }
                }
            }
        }
    });
};

const atmosphericChart = initAtmosphericChart();
const chartRain = initRainfallChart();

const resizeObserver = new ResizeObserver(() => {
    [detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart, detailedWaterChart, detailedLightChart, atmosphericChart, chartRain, weeklyRainChart, hourlyPrecipChart].forEach(c => {
        if (c && c.canvas && c.canvas.offsetParent !== null) {
            c.resize();
        }
    });
});

const scrollArea = document.querySelector('.scroll-area');
if (scrollArea) resizeObserver.observe(scrollArea);

let historyInitialized = false;
let lastProcessedTime = null;
let firstSnapshotReceived = false;
let latestFirestoreCurrentData = null;

let currentAdminSelectedRange = 'today';
let customAdminSelectedDate = null;
let adminHistoryQuerySeq = 0;

async function initializeChartHistory(rangeMode = currentAdminSelectedRange, customDateStr = customAdminSelectedDate) {
    currentAdminSelectedRange = rangeMode;
    customAdminSelectedDate = customDateStr;
    const thisQueryId = ++adminHistoryQuerySeq;

    const allCharts = [detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart, detailedWaterChart, detailedLightChart, atmosphericChart, chartRain];

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

        // Combine weather_history + live Firestore reading only if the reading is genuinely from the active time window
        if (latestFirestoreCurrentData && (rangeMode === 'today' || rangeMode === '7d' || rangeMode === '30d')) {
            const liveTime = parseFirestoreTimestamp(latestFirestoreCurrentData.lastSeen || new Date());
            const lastHistTime = rawHistory.length > 0 ? parseFirestoreTimestamp(rawHistory[rawHistory.length - 1].timestamp) : null;

            // Only append if the live reading timestamp falls within the requested range and is newer than the last recorded history point
            if (liveTime >= startDate && (!lastHistTime || (liveTime.getTime() - lastHistTime.getTime() > 60000))) {
                rawHistory.push({
                    ...latestFirestoreCurrentData,
                    timestamp: latestFirestoreCurrentData.lastSeen || new Date().toISOString()
                });
            }
        }

        // If a newer query was fired while waiting for Firestore, discard this stale result
        if (thisQueryId !== adminHistoryQuerySeq) return;

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
            const w = !isNaN(parseFloat(data.waterLevel)) && parseFloat(data.waterLevel) >= 0 ? parseFloat(data.waterLevel) : null;
            const l = !isNaN(parseFloat(data.lightLevel)) && parseFloat(data.lightLevel) >= 0 ? parseFloat(data.lightLevel) : null;

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
            if (atmosphericChart) {
                atmosphericChart.data.labels.push(timeLabel);
                atmosphericChart.data.datasets[0].data.push(t);
                atmosphericChart.data.datasets[1].data.push(h);
            }
            if (chartRain) {
                chartRain.data.labels.push(timeLabel);
                chartRain.data.datasets[0].data.push(r);
            }
        });
    } catch (error) {
        console.error("Error loading weather history:", error);
    }

    allCharts.forEach(c => {
        if (c) c.update("none");
    });
}

// Attach Admin Range Selector listeners
document.addEventListener('DOMContentLoaded', () => {
    setupAdminRangeSelectorListeners();
});
setTimeout(setupAdminRangeSelectorListeners, 500);

function setupAdminRangeSelectorListeners() {
    const rangeBar = document.getElementById('admin-time-range-bar');
    if (!rangeBar || rangeBar.dataset.initialized) return;
    rangeBar.dataset.initialized = 'true';

    const pills = rangeBar.querySelectorAll('.range-pill');
    const datePicker = document.getElementById('admin-chart-date-picker');

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
let adminHistoryListenerUnsubscribe = null;
let isFirstHistorySnapshotAdmin = true;
function setupAdminRealtimeHistoryListener() {
    if (adminHistoryListenerUnsubscribe) return;

    try {
        adminHistoryListenerUnsubscribe = db.collection('weather_history')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .onSnapshot(snapshot => {
                if (isFirstHistorySnapshotAdmin) {
                    isFirstHistorySnapshotAdmin = false;
                    return; // Skip first snapshot to avoid redundant reload on page open
                }
                if (!snapshot.empty && !snapshot.metadata.hasPendingWrites) {
                    loadWeeklyData();
                    if (currentAdminSelectedRange === 'today' || currentAdminSelectedRange === '7d' || currentAdminSelectedRange === '30d') {
                        initializeChartHistory(currentAdminSelectedRange);
                    }
                }
            }, err => console.warn("Admin realtime history sync note:", err));
    } catch (e) {
        console.warn("Failed to attach admin weather_history onSnapshot:", e);
    }
}

// ── Historical CSV Data Export (for Reports) ────────────────────────────
// Shared loader for both export paths — resolves the active time-range filter and
// pulls the matching weather_history records.
async function fetchHistoryForExport() {
    let startDate, endDate;
    const now = new Date();
    const rangeMode = currentAdminSelectedRange;
    const customDateStr = customAdminSelectedDate;

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

    let snapshot;
    if (rangeMode === 'custom' && customDateStr) {
        snapshot = await db.collection('weather_history')
            .where('timestamp', '>=', startDate)
            .where('timestamp', '<=', endDate)
            .orderBy('timestamp', 'asc')
            .get();
    } else {
        snapshot = await db.collection('weather_history')
            .where('timestamp', '>=', startDate)
            .orderBy('timestamp', 'asc')
            .limit(1000)
            .get();
    }

    let records = [];
    if (!snapshot.empty) {
        records = snapshot.docs.map(doc => doc.data());
    } else {
        // Fallback to latest 50 history logs if empty for the selected range
        const fallback = await db.collection('weather_history')
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        if (!fallback.empty) records = fallback.docs.map(doc => doc.data()).reverse();
    }

    const rangeLabels = { today: 'Today', '7d': 'Last 7 Days', '30d': 'Last 30 Days', custom: 'Custom Date' };
    const rangeLabel = (rangeLabels[rangeMode] || 'Today') +
        ` — ${startDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}` +
        ` to ${endDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    return { records, startDate, endDate, rangeLabel };
}

async function exportHistoryToCSV() {
    const exportBtn = document.getElementById('admin-export-csv-btn');
    const origHtml = exportBtn ? exportBtn.innerHTML : '';

    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Exporting...</span>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const { records } = await fetchHistoryForExport();

        if (records.length === 0) {
            showToast("No historical weather records found for the selected time range.", 'error');
            return;
        }

        // Build CSV Content
        const headers = [
            "Timestamp (ISO)",
            "Date (PHT)",
            "Time (PHT)",
            "Temperature (C)",
            "Humidity (%)",
            "Pressure (hPa)",
            "Cumulative Rainfall (mm)",
            "Rain Rate (${currentRainRateUnit})",
            "Water Level (cm)",
            "Water Rise Rate (${currentRiseRateUnit})",
            "Light Intensity (Lux)",
            "Cloud Cover (%)",
            "Dew Point (C)",
            "Heat Index (C)"
        ];

        // Write a numeric cell: the real value when present (rounded), a blank
        // when the field is missing/invalid (never fake it as 0), and keep the
        // firmware's -1 sentinel convention for water/light read failures.
        const cell = (v, dp, sentinel = false) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return sentinel ? '-1' : '';
            return n.toFixed(dp);
        };

        const rows = records.map(r => {
            const time = r.timestamp ? (r.timestamp.toDate ? r.timestamp.toDate() : new Date(r.timestamp)) : new Date();
            const dateStr = time.toLocaleDateString('en-PH');
            const timeStr = time.toLocaleTimeString('en-PH');

            return [
                `"${time.toISOString()}"`,
                `"${dateStr}"`,
                `"${timeStr}"`,
                cell(r.temperature, 2),
                cell(r.humidity, 1),
                cell(r.pressure, 2),
                cell(r.rainfall ?? r.dailyRainfall, 2),
                cell(convRain(parseFloat(r.rainRate)), 2),
                cell(r.waterLevel, 1, true),
                cell(convRise(parseFloat(r.waterRiseRate)), 2),
                cell(r.lightLevel, 0, true),
                cell(r.cloudCover, 0),
                cell(r.dewPoint, 1),
                cell(r.heatIndex, 1)
            ].join(",");
        });

        const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const fileDate = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `BRIANE_Sensor_Logs_${fileDate}_${currentAdminSelectedRange}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error("CSV Export failed:", err);
        showToast("Failed to export CSV: " + err.message, 'error');
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = origHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}

// ── Printable PDF Report ─────────────────────────────────────────────────
// Opens a print-optimized report window (A4, branded, summary + chart + table).
// The browser's print dialog handles "Save as PDF" — zero external libraries.

const REPORT_TABLE_ROW_CAP = 400;

function computeReportStats(records) {
    const nums = (get) => records.map(get).filter(v => Number.isFinite(v));
    const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const min = a => a.length ? Math.min(...a) : null;
    const max = a => a.length ? Math.max(...a) : null;

    const temps = nums(r => parseFloat(r.temperature));
    const hums = nums(r => parseFloat(r.humidity));
    const pres = nums(r => parseFloat(r.pressure));
    const rain = nums(r => parseFloat(r.rainfall ?? r.dailyRainfall));
    const rates = nums(r => parseFloat(r.rainRate));
    const water = nums(r => parseFloat(r.waterLevel)).filter(v => v >= 0);

    // Range rainfall total = sum of each day's peak cumulative value
    const dailyPeak = {};
    records.forEach(r => {
        const t = r.timestamp ? (r.timestamp.toDate ? r.timestamp.toDate() : new Date(r.timestamp)) : null;
        if (!t || Number.isNaN(t.getTime())) return;
        const key = t.toISOString().split('T')[0];
        const v = parseFloat(r.rainfall ?? r.dailyRainfall) || 0;
        dailyPeak[key] = Math.max(dailyPeak[key] || 0, v);
    });
    const rainTotal = Object.values(dailyPeak).reduce((s, v) => s + v, 0);

    const riseRates = nums(r => parseFloat(r.waterRiseRate));
    const lights = nums(r => parseFloat(r.lightLevel)).filter(v => v >= 0);

    return {
        count: records.length,
        temp: { avg: avg(temps), min: min(temps), max: max(temps) },
        hum: { avg: avg(hums) },
        pres: { avg: avg(pres) },
        rain: { total: rainTotal, peakRate: max(rates) },
        water: { max: max(water), peakRise: max(riseRates) },
        light: { max: max(lights), avg: avg(lights) }
    };
}

// Shared builder for the report's combined daily rainfall + water level chart.
// The SVG is sized to the data: short ranges render a compact, centered chart
// instead of a few bars clumped in the left corner of a full-width box,and
// large ranges are capped so the chart never overflows the A4 printable area.
function niceChartStep(rawMax) {
    const target = Math.max(rawMax, 0.1) / 4;   // aim for ~4-5 gridlines
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const norm = target / pow;
    const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return nice * pow;
}

// One combined chart: daily rainfall as blue bars (left axis, mm)and daily
// water level as a green line+points (right axis, cm). Independent y-scales
// keep both series readable whatever their magnitudes are.
function buildDailyRainWaterChartSVG(records) {
    const rain = {}, water = {};
    records.forEach(r => {
        const t = r.timestamp ? (r.timestamp.toDate ? r.timestamp.toDate() : new Date(r.timestamp)) : null;
        if (!t || Number.isNaN(t.getTime())) return;
        const key = t.toISOString().split('T')[0];
        const rv = parseFloat(r.rainfall ?? r.dailyRainfall);
        if (Number.isFinite(rv) && rv>=0) rain[key] = Math.max(rain[key] || 0,rv);
        const wv = parseFloat(r.waterLevel);
        if (Number.isFinite(wv) && wv>=0) water[key] = Math.max(water[key] || 0,wv);
    });
    const rainKeys = Object.keys(rain);
    const waterKeys = Object.keys(water);
    const daySet = new Set([...rainKeys, ...waterKeys]);
    const days = [...daySet].sort();
    if (days.length === 0) return '';

    // Geometry: plot area scales with the data but is capped to the printable width
    const H = 210;
    const L = 46,R = 52;                  // left: rain-axis labels; right: water-axis labels
    const topPad = 30,bottomPad = 40;
    const plotW = Math.max(240,days.length * 64);
    const W = Math.min(plotW + L + R, 760);
    const chartH = H - topPad - bottomPad;

    const plotArea = W - L - R;
    const slot = plotArea / days.length;         // bars/points are centered in equal slots
    const bw = Math.min(28, Math.max(8, slot * 0.32));
    const baselineY = H - bottomPad;

    // Dual y-scales: each rounded to a human-friendly step
    const rawMaxRain = Math.max(...days.map(d => rain[d] || 0), 0.1);
    const stepRain = niceChartStep(rawMaxRain);

    const maxRain = Math.max(stepRain, Math.ceil(rawMaxRain / stepRain) * stepRain);
    const rawMaxWater = Math.max(...days.map(d => water[d] || 0), 0.1);
    const stepWater = niceChartStep(rawMaxWater);
    const maxWater = Math.max(stepWater, Math.ceil(rawMaxWater / stepWater) * stepWater);
    const yRain = v => baselineY - (v / maxRain) * chartH;
    const yWater = v => baselineY - (v / maxWater) * chartH;
    const fmtVal = v => v>=100 ? String(Math.round(v)) : v>=10 ? v.toFixed(0) : v<1 ? v.toFixed(2) : v.toFixed(1);
// Gridlines + y-axis labels: rain on the left, water on the right
    let grid = '';
    for (let v = stepRain; v <= maxRain + 1e-9; v += stepRain) {
        const y = yRain(v);
        grid += `
            <line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 3"/>
            <text x="${(L - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="chart-grid">${fmtVal(v)}</text>`;
    }
    for (let v = stepWater; v <= maxWater + 1e-9; v += stepWater) {
        const y = yWater(v);
        grid += `
            <text x="${(W - R + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="start" class="chart-grid">${fmtVal(v)}</text>`;
    }

    // Rainfall bars (left axis, blue
    let bars = '';
    days.forEach((d,i) => {
        const rv = rain[d];
        if (rv === undefined) return;
        const h = Math.max(2,(rv / maxRain) * chartH);
        const x = L + i * slot + (slot - bw)/2;
        const y = yRain(rv);
        bars += `
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="#2c5f97"></rect>`;
        if (bw>=14 && rv>0) {
            bars += `
            <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" class="chart-val">${fmtVal(rv)}</text>`;
        }
    });

    // Water level line + points (right axis, green
    const waterPts = days.map((d,i) => water[d] !== undefined ? { x: L + i * slot + slot / 2,y: Number(yWater(water[d]).toFixed(2)) } : null);
    function buildPolyline(curve) {
        return `<polyline points="${curve.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#2f8f6d" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    let line = '';
    let curve = [];
    waterPts.forEach(p => {
        if (p) {
            curve.push(p);
        } else {
            if (curve.length>1) line += buildPolyline(curve);
            curve = [];
        }
    });
    if (curve.length>1) line += buildPolyline(curve);
    waterPts.forEach(p => {
        if (p) line += `
            <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#ffffff" stroke="#2f8f6d" stroke-width="2"/>`;
    });

    // Day labels
    let dayLabels = '';
    days.forEach((d,i) => {
        const cx = L + i * slot + slot / 2;
        const label = new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
        dayLabels += `
            <text x="${cx.toFixed(1)}" y="${baselineY + 16}" text-anchor="middle" class="chart-day">${escapeHtml(label)}</text>`;
    });

    // Legend (bottom, centered — no title collision on compact charts
    const legendW = 217;
    const lx = Math.max(0,(W - legendW)/2);
    const ly = H - 17;
    const legend = `
        <g class="chart-legend">
            <rect x="${lx}" y="${ly}" width="9" height="9" rx="2" fill="#2c5f97"/>
            <text x="${(lx + 14).toFixed(1)}" y="${(ly + 10).toFixed(1)}" class="chart-legend-text">Rainfall (mm)</text>
            <line x1="${(lx + 106).toFixed(1)}" y1="${(ly + 4.5).toFixed(1)}" x2="${(lx + 122).toFixed(1)}" y2="${(ly + 4.5).toFixed(1)}" stroke="#2f8f6d" stroke-width="2"/>
            <circle cx="${(lx + 122).toFixed(1)}" cy="${(ly + 4.5).toFixed(1)}" r="2.5" fill="#2f8f6d"/>
            <text x="${(lx + 127).toFixed(1)}" y="${(ly + 10).toFixed(1)}" class="chart-legend-text">Water Level (cm)</text>
        </g>`;

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily rainfall and water level">
        <text x="${L}" y="16" class="chart-title">Daily Rainfall (mm) &amp; Water Level (cm)</text>
        <line x1="${L}" y1="${baselineY}" x2="${W - R}" y2="${baselineY}" stroke="#cbd5e1" stroke-width="1"/>${grid}${bars}${line}${dayLabels}${legend}</svg>`;
}

async function generatePrintableReport() {
    const reportBtn = document.getElementById('admin-export-report-btn');
    const origHtml = reportBtn ? reportBtn.innerHTML : '';
    if (reportBtn) {
        reportBtn.disabled = true;
        reportBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Preparing...</span>`;
        if (window.lucide) lucide.createIcons();
    }

    try {
        const { records, rangeLabel } = await fetchHistoryForExport();
        if (records.length === 0) {
            showToast("No historical weather records found for the selected time range.", 'error');
            return;
        }

        const stats = computeReportStats(records);
        const fmt = (v, dp = 1, suffix = '') => (v === null || v === undefined || Number.isNaN(v)) ? '—' : v.toFixed(dp) + suffix;
        const now = new Date();

        

        const tableRows = records.slice(0, REPORT_TABLE_ROW_CAP).map(r => {
            const t = r.timestamp ? (r.timestamp.toDate ? r.timestamp.toDate() : new Date(r.timestamp)) : new Date();
            return `<tr>
                <td>${escapeHtml(t.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }))}</td>
                <td>${escapeHtml(t.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }))}</td>
                <td>${fmt(parseFloat(r.temperature), 1, '°C')}</td>
                <td>${fmt(parseFloat(r.humidity), 0, '%')}</td>
                <td>${fmt(parseFloat(r.pressure), 1)}</td>
                <td>${fmt(parseFloat(r.rainfall ?? r.dailyRainfall), 2)}</td>
                <td>${r.rainRate !== undefined && !Number.isNaN(parseFloat(r.rainRate)) ? fmt(convRain(parseFloat(r.rainRate)), 1) : '—'}</td>
                <td>${r.waterLevel !== undefined && parseFloat(r.waterLevel) >= 0 ? fmt(parseFloat(r.waterLevel), 1) : '—'}</td>
                <td>${r.waterRiseRate !== undefined && !Number.isNaN(parseFloat(r.waterRiseRate)) ? fmt(convRise(parseFloat(r.waterRiseRate)), 2) : '—'}</td>
                <td>${r.lightLevel !== undefined && parseFloat(r.lightLevel) >= 0 ? fmt(parseFloat(r.lightLevel), 0) : '—'}</td>
            </tr>`;
        }).join('');

        const statCard = (label, value) => `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BRIANE Flood Monitoring Report — ${escapeHtml(rangeLabel)}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; color: #1e293b; font-size: 12px; background: #f1f5f9; }
    .page { max-width: 210mm; margin: 0 auto; background: white; padding: 12mm 12mm 20mm; }
    .toolbar { max-width: 210mm; margin: 12px auto; text-align: right; }
    .toolbar button { padding: 10px 22px; background: #275385; color: white; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }

    .report-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #275385; padding-bottom: 14px; margin-bottom: 16px; }
    .brand { font-size: 26px; font-weight: 900; color: #275385; letter-spacing: 1px; }
    .brand-sub { font-size: 10px; color: #64748b; margin-top: 2px; max-width: 110mm; }
    .report-meta { text-align: right; font-size: 10.5px; color: #475569; line-height: 1.7; }
    .report-meta strong { color: #0f172a; }
    h2.report-title { font-size: 17px; margin-bottom: 2px; color: #0f172a; }

    .section-title { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #275385; margin: 18px 0 8px; border-left: 4px solid #2c5f97; padding-left: 8px; }

    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
    .stat-value { font-size: 17px; font-weight: 800; color: #0f172a; }
    .stat-label { font-size: 9.5px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }

    .chart-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
    svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
    .chart-title { font-size: 12px; font-weight: 700; fill: #334155; }
    .chart-val { font-size: 9px; fill: #475569; font-weight: 600; }
    .chart-day { font-size: 9px; fill: #94a3b8; }
    .chart-grid { font-size: 8.5px; fill: #94a3b8; }
    .chart-legend-text { font-size: 9px; fill: #475569; font-weight: 600; }

    table.data { width: 100%; border-collapse: collapse; }

    .data th { background: #275385; color: white; padding: 7px 8px; text-align: left; font-size: 10.5px; }
    .data td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; font-size: 10.5px; }
    .data tr:nth-child(even) td { background: #f8fafc; }
    .data thead { display: table-header-group; }
    .data tr { page-break-inside: avoid; }

    .print-footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 9px; color: #94a3b8; text-align: center; padding: 6px; border-top: 1px solid #e2e8f0; background: white; }
    .footnote { font-size: 9.5px; color: #94a3b8; margin-top: 8px; }

    @page { size: A4; margin: 12mm 10mm 16mm; }
    @media print {
        body { background: white; }
        .toolbar { display: none; }
        .page { max-width: none; padding: 0; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
</style>
</head>
<body>
    <div class="toolbar"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
    <div class="page">
        <div class="report-header">
            <div>
                <div class="brand">BRIANE</div>
                <div class="brand-sub">Barangay Rainfall Intelligence and Alert Network for Emergencies — SMS-Based Flood Early Warning System</div>
            </div>
            <div class="report-meta">
                <h2 class="report-title">Flood Monitoring Report</h2>
                <strong>Station:</strong> ${adminStationLocation ? `(${escapeHtml(adminStationLocation)})` : '(Location unavailable)'}<br>
                <strong>Period:</strong> ${escapeHtml(rangeLabel)}<br>
                <strong>Generated:</strong> ${escapeHtml(now.toLocaleString('en-PH'))}<br>
                <strong>Records:</strong> ${stats.count}
            </div>
        </div>

        <div class="section-title">Executive Summary</div>
        <div class="stat-grid">
            ${statCard('Total Rainfall', fmt(stats.rain.total, 2, ' mm'))}
            ${statCard('Peak Rain Rate', fmt(convRain(stats.rain.peakRate), 1, ` ${currentRainRateUnit}`))}
            ${statCard('Max Water Level', fmt(stats.water.max, 1, ' cm'))}
            ${statCard('Peak Rise Rate', fmt(convRise(stats.water.peakRise), 2, ` ${currentRiseRateUnit}`))}
            ${statCard('Avg Light', fmt(stats.light.avg, 0, ' lux'))}
            ${statCard('Temp Range', `${fmt(stats.temp.min, 1)} – ${fmt(stats.temp.max, 1)}°C`)}
            ${statCard('Avg Humidity', fmt(stats.hum.avg, 0, '%'))}
            ${statCard('Avg Pressure', fmt(stats.pres.avg, 1, ' hPa'))}
        </div>

        <div class="section-title">Rainfall &amp; Water Level Trend</div>
        <div class="chart-box">${buildDailyRainWaterChartSVG(records)}</div>

        <div class="section-title">Sensor Readings Log</div>
        <table class="data">
            <thead><tr>
                <th>Date</th><th>Time</th><th>Temp</th><th>Humidity</th><th>Pressure (hPa)</th>
                <th>Rain (mm)</th><th>Rate (${currentRainRateUnit})</th><th>Water (cm)</th><th>Rise (${currentRiseRateUnit})</th><th>Lux</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
        </table>
        ${records.length > REPORT_TABLE_ROW_CAP ? `<div class="footnote">Showing first ${REPORT_TABLE_ROW_CAP} of ${stats.count} records. Use “Export Data (.CSV)” for the complete raw dataset.</div>` : ''}

        <div class="footnote">Report auto-generated by the BRIANE Admin Dashboard. Data source: device telemetry synced to Firebase Cloud Firestore.</div>
    </div>
    <div class="print-footer">BRIANE Flood Early Warning System — Confidential administrative document — ${escapeHtml(now.toLocaleDateString('en-PH'))}</div>
    <script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 350); });<\/script>
</body>
</html>`;

        const win = window.open('', '_blank');
        if (!win) {
            showToast('Pop-up blocked. Please allow pop-ups for this page.', 'error');
            return;
        }
        win.document.open();
        win.document.write(html);
        win.document.close();

    } catch (err) {
        console.error("Report generation failed:", err);
        showToast("Failed to generate report: " + err.message, 'error');
    } finally {
        if (reportBtn) {
            reportBtn.disabled = false;
            reportBtn.innerHTML = origHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}

// Attach Export Button Listeners
const adminExportCsvBtn = document.getElementById('admin-export-csv-btn');
if (adminExportCsvBtn) {
    adminExportCsvBtn.addEventListener('click', exportHistoryToCSV);
}
const adminExportReportBtn = document.getElementById('admin-export-report-btn');
if (adminExportReportBtn) {
    adminExportReportBtn.addEventListener('click', generatePrintableReport);
}

// ── PWA Service Worker Registration (Admin) ─────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('../service-worker.js')
            .then(reg => console.log('[PWA Admin] Service Worker active:', reg.scope))
            .catch(err => console.warn('[PWA Admin] Service Worker registration note:', err));
    });
}

// ── PWA Install Prompt & Trigger (Admin) ─────────────────────────
let deferredAdminInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredAdminInstallPrompt = e;
    const headerBtn = document.getElementById('header-install-btn');
    const sidebarBtn = document.getElementById('sidebar-install-btn');
    if (headerBtn) headerBtn.style.display = 'inline-flex';
    if (sidebarBtn) sidebarBtn.style.display = 'flex';
});

const triggerAdminPWAInstall = async () => {
    if (deferredAdminInstallPrompt) {
        deferredAdminInstallPrompt.prompt();
        const { outcome } = await deferredAdminInstallPrompt.userChoice;
        if (outcome === 'accepted') {
            console.log('[PWA Admin] User installed BRIANE Admin');
        }
        deferredAdminInstallPrompt = null;
        const headerBtn = document.getElementById('header-install-btn');
        const sidebarBtn = document.getElementById('sidebar-install-btn');
        if (headerBtn) headerBtn.style.display = 'none';
        if (sidebarBtn) sidebarBtn.style.display = 'none';
    } else {
        alert("📲 To install BRIANE Admin on your device:\n• Android Chrome: Tap the top-right menu (⋮) and tap 'Install App' or 'Add to Home screen'.\n• iPhone Safari: Tap the Share button (⎋) and select 'Add to Home Screen'.\n• Desktop Chrome: Click the install icon (⬇) in the browser address bar.");
    }
};

const headerAdminInstallBtn = document.getElementById('header-install-btn');
const sidebarAdminInstallBtn = document.getElementById('sidebar-install-btn');
if (headerAdminInstallBtn) headerAdminInstallBtn.addEventListener('click', triggerAdminPWAInstall);
if (sidebarAdminInstallBtn) sidebarAdminInstallBtn.addEventListener('click', triggerAdminPWAInstall);

let lastAdminChartUpdateTimestamp = 0;
const ADMIN_CHART_UPDATE_INTERVAL_MS = 60000; // 1 minute interval for adding new points

function updateCharts(rain, temp, hum, pres, water, light) {
    const now = new Date();
    const timeLabel = formatDateTimeLabel(now);
    const maxPoints = 30; // Clean fixed 30-point window

    const nowMs = now.getTime();
    const isNewPointDue = (lastAdminChartUpdateTimestamp > 0) && (nowMs - lastAdminChartUpdateTimestamp >= ADMIN_CHART_UPDATE_INTERVAL_MS);

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

    if (!isNaN(temp)) updateChartData(detailedTempChart, temp, timeLabel);
    if (!isNaN(hum)) updateChartData(detailedHumChart, hum, timeLabel);
    if (!isNaN(pres)) updateChartData(detailedPresChart, pres, timeLabel);
    if (!isNaN(rain)) {
        updateChartData(detailedRainChart, rain, timeLabel);
        updateChartData(chartRain, rain, timeLabel);
    }
    if (water >= 0) updateChartData(detailedWaterChart, water, timeLabel);
    if (light >= 0) updateChartData(detailedLightChart, light, timeLabel);

    // Update Overview Dual Chart
    if (atmosphericChart && !isNaN(temp) && !isNaN(hum)) {
        if (isNewPointDue) {
            atmosphericChart.data.labels.push(timeLabel);
            atmosphericChart.data.datasets[0].data.push(temp);
            atmosphericChart.data.datasets[1].data.push(hum);
            if (atmosphericChart.data.labels.length > maxPoints) {
                atmosphericChart.data.labels.shift();
                atmosphericChart.data.datasets[0].data.shift();
                atmosphericChart.data.datasets[1].data.shift();
            }
        } else {
            if (atmosphericChart.data.datasets[0].data.length > 0) {
                const lastIdx = atmosphericChart.data.datasets[0].data.length - 1;
                atmosphericChart.data.datasets[0].data[lastIdx] = temp;
                atmosphericChart.data.datasets[1].data[lastIdx] = hum;
                atmosphericChart.data.labels[lastIdx] = timeLabel;
            } else {
                atmosphericChart.data.labels.push(timeLabel);
                atmosphericChart.data.datasets[0].data.push(temp);
                atmosphericChart.data.datasets[1].data.push(hum);
            }
        }
        atmosphericChart.update("none");
    }

    if (isNewPointDue) {
        lastAdminChartUpdateTimestamp = nowMs;
    }
}

function updatePredictions(temp, hum, pres, rain, light, water, pressureTrend, cloudCover, waterRiseRate = 0) {
    let prediction = "Stable";
    let desc = "Atmospheric conditions are normal.";
    let icon = "sun";
    let rainProb = 5;
    let floodRisk = 0;

    // Apply Sensor Offsets
    temp += sensorOffsets.temp;
    water += sensorOffsets.water;

    // Advanced Local Mathematical Model: Multi-Factor Weighted Scoring (0-10)
    // Normalize weights to 10 points total
    const wPres = modelWeights.pres / 10;
    const wHum = modelWeights.hum / 10;
    const wLight = modelWeights.light / 10;
    const wRain = modelWeights.rain / 10;

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

    // Display Factor Breakdown
    const fPres = document.getElementById('factor-pressure');
    const fHum = document.getElementById('factor-humidity');
    const fLight = document.getElementById('factor-light');
    const fRain = document.getElementById('factor-rain');

    if (fPres) fPres.innerText = `${pressureScore.toFixed(1)} / ${wPres.toFixed(1)}`;
    if (fHum) fHum.innerText = `${humidityScore.toFixed(1)} / ${wHum.toFixed(1)}`;
    if (fLight) fLight.innerText = light >= 10 ? `${lightScore.toFixed(1)} / ${wLight.toFixed(1)}` : 'Night';
    if (fRain) fRain.innerText = `${rainScore.toFixed(1)} / ${wRain.toFixed(1)}`;

    if (pressureTrend < -1.5 && hum > 85) {
        prediction = "Storm Imminent";
        desc = "Rapid pressure drop and high humidity suggest storm.";
        icon = "cloud-lightning";
        rainProb = Math.max(rainProb, 95);
    } else if (pres < 1008 && hum > 78) {
        prediction = "Rain Expected";
        desc = "Unstable atmospheric system producing precipitation.";
        icon = "cloud-rain";
        rainProb = Math.max(rainProb, 80);
    } else if (light !== undefined && light >= 0 && light < 6000) {
        prediction = "Mostly Overcast";
        desc = "Heavy cloud cover or reduced light level detected.";
        icon = "cloud";
        rainProb = Math.max(rainProb, 45);
    } else if (temp > 33 && hum < 55) {
        prediction = "Hot & Clear";
        desc = "Clear dry conditions.";
        icon = "sun";
        rainProb = 5;
    }

    // Advanced Flood Risk Computation
    // Factor 1: Rainfall saturation relative to admin threshold
    const rainRisk = (rain / alertThresholdVal) * 100;

    // Factor 2: Local water level relative to mounting height
    const maxCapacity = physicalMountHeight * 0.8; // Assume 80% of height is critical capacity
    const waterLevelRisk = water >= 0 ? (water / maxCapacity) * 100 : 0;

    // Combine and add momentum if water is rising
    let combinedRisk = Math.max(rainRisk, waterLevelRisk);
    if (waterRiseRate > 0) {
        combinedRisk += (waterRiseRate * 150); // Add significant weight to rising water (x150 keeps the old cm/h risk scale)
    }

    floodRisk = Math.min(100, combinedRisk);

    // Water level specific risk (Visual Gauge)
    const maxCapacityGauge = physicalMountHeight * 0.8;
    const waterGaugeRisk = water >= 0 ? Math.min(100, (water / maxCapacityGauge) * 100) : 0;

    const pTitle = document.getElementById('prediction-title');
    const pDesc = document.getElementById('prediction-desc');
    const pIconBox = document.getElementById('prediction-icon-box');
    const pRain = document.getElementById('prob-rain');
    const pFlood = document.getElementById('prob-flood');
    const pWater = document.getElementById('prob-water');

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

    const pRainValue = document.getElementById('rain-prob-value');
    const pFloodValue = document.getElementById('flood-risk-value');
    if (pRainValue) pRainValue.innerText = rainProb + "%";
    if (pFloodValue) pFloodValue.innerText = Math.round(floodRisk) + "%";

    lucide.createIcons();
}

const deviceStatusValue = document.getElementById('device-status-value');
const deviceStatusValueDesktop = document.getElementById('device-status-value-desktop');
const deviceStatusSummary = document.getElementById('device-status-summary');
const headerStatusDot = document.getElementById('header-status-dot');
const headerStatusDotDesktop = document.getElementById('header-status-dot-desktop');

const thresholdInput = document.getElementById('threshold-input-settings');
const currentThresholdDisplay = document.getElementById('current-threshold-display');
const alertL1RainInput = document.getElementById('alert-l1-rain-input');
const alertL1WaterRiseInput = document.getElementById('alert-l1-water-rise-input');
const alertL1RainRateInput = document.getElementById('alert-l1-rain-rate-input');
const alertL2RainRateInput = document.getElementById('alert-l2-rain-rate-input');
const alertL3RainRateInput = document.getElementById('alert-l3-rain-rate-input');
const alertL1WaterLevelInput = document.getElementById('alert-l1-water-level-input');
const alertL2WaterLevelInput = document.getElementById('alert-l2-water-level-input');
const alertL3WaterLevelInput = document.getElementById('alert-l3-water-level-input');
const alertMsgL1Input = document.getElementById('alert-msg-l1-input');

const alertL2RainInput = document.getElementById('alert-l2-rain-input');
const alertL2WaterRiseInput = document.getElementById('alert-l2-water-rise-input');
const alertMsgL2Input = document.getElementById('alert-msg-l2-input');

const alertL3RainInput = document.getElementById('alert-l3-rain-input');
const alertL3WaterRiseInput = document.getElementById('alert-l3-water-rise-input');
const alertMsgL3Input = document.getElementById('alert-msg-l3-input');
const alertMsgInput = document.getElementById('alert-msg-input-settings');
const saveMsgBtn = document.getElementById('save-msg-btn-settings');
const rainRateUnitInput = document.getElementById('rain-rate-unit-input');
const rainRateWindowInput = document.getElementById('rain-rate-window-input');
const riseRateUnitInput = document.getElementById('rise-rate-unit-input');
const riseRateWindowInput = document.getElementById('rise-rate-window-input');
const riseSmoothInput = document.getElementById('rise-smooth-input');

// Water-rise thresholds are STORED canonically in cm/min. When the Rise Unit select
// shows cm/h, the threshold fields + labels convert so the admin always works in one
// consistent unit; values are converted back to canonical before saving.
let riseDisplayFactor = 1;   // 1 = cm/min (canonical), 60 = cm/h
// Rain-intensity thresholds are STORED canonically in mm/h. When Rain Unit shows
// mm/min, the threshold fields + labels convert; values are canonicalized on save.
let rainDisplayFactor = 1;   // 1 = mm/h (canonical), 1/60 = mm/min display
// Live unit for historical display (report, stat cards, CSV) — set from telemetry.
let currentRainRateUnit = 'mm/h';
let currentRiseRateUnit = 'cm/min';
const convRain = (v) => currentRainRateUnit === 'mm/min' ? v / 60 : v;
const convRise = (v) => currentRiseRateUnit === 'cm/h' ? v * 60 : v;

function setRiseDisplayFactor(factor) {
    const inputs = [alertL1WaterRiseInput, alertL2WaterRiseInput, alertL3WaterRiseInput];
    inputs.forEach(inp => {
        if (!inp) return;
        const v = parseFloat(inp.value);
        if (!isNaN(v)) inp.value = Math.round(v / riseDisplayFactor * factor * 1000) / 1000;
    });
    riseDisplayFactor = factor;
    const unit = factor === 60 ? 'cm/h' : 'cm/min';
    for (let i = 1; i <= 3; i++) {
        const lb = document.getElementById(`water-rise-label-l${i}`);
        if (lb) lb.textContent = `Water Rise (${unit})`;
    }
}

if (riseRateUnitInput) {
    riseRateUnitInput.addEventListener('change', () => {
        setRiseDisplayFactor(riseRateUnitInput.value === 'cm/h' ? 60 : 1);
    });
}

function setRainDisplayFactor(factor) {
    const inputs = [alertL1RainRateInput, alertL2RainRateInput, alertL3RainRateInput];
    inputs.forEach(inp => {
        if (!inp) return;
        const v = parseFloat(inp.value);
        if (!isNaN(v)) inp.value = Math.round(v / rainDisplayFactor * factor * 1000) / 1000;
    });
    rainDisplayFactor = factor;
    const unit = factor < 0.05 ? 'mm/min' : 'mm/h';
    for (let i = 1; i <= 3; i++) {
        const lb = document.getElementById(`rain-intensity-label-l${i}`);
        if (lb) lb.textContent = `Rain Intensity (${unit})`;
    }
}

if (rainRateUnitInput) {
    rainRateUnitInput.addEventListener('change', () => {
        setRainDisplayFactor(rainRateUnitInput.value === 'mm/min' ? 1 / 60 : 1);
    });
}

// Rate Computation "Defaults" — restores the recommended settings, converts the
// threshold display to the default units, and applies them right away.
const rateDefaultsBtn = document.getElementById('rate-defaults-btn');
if (rateDefaultsBtn) {
    rateDefaultsBtn.addEventListener('click', async () => {
        try {
            if (rainRateUnitInput) rainRateUnitInput.value = 'mm/h';
            if (rainRateWindowInput) rainRateWindowInput.value = '10';
            if (riseRateUnitInput) riseRateUnitInput.value = 'cm/min';
            if (riseRateWindowInput) riseRateWindowInput.value = '5';
            if (riseSmoothInput) riseSmoothInput.value = '2';
            setRiseDisplayFactor(1);   // back to canonical cm/min display
            setRainDisplayFactor(1);   // back to canonical mm/h display

            await saveConfigDual({
                rainRateUnit: 'mm/h',
                rainRateWindowMin: 10,
                riseRateUnit: 'cm/min',
                riseRateWindowMin: 5,
                riseSmoothMin: 2
            });
            showToast("Rate Computation restored to defaults");
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// Sim Elements
const pushSimBtn = document.getElementById('push-sim-data');
const simDateTime = document.getElementById('sim-datetime');
const setNowSimBtn = document.getElementById('set-now-sim');
const simRain = document.getElementById('sim-rain');
const simRainRate = document.getElementById('sim-rain-rate');
const simTemp = document.getElementById('sim-temp');
const simHum = document.getElementById('sim-hum');
const simPres = document.getElementById('sim-pres');
const simLight = document.getElementById('sim-light');
const simWater = document.getElementById('sim-water');
const simWaterRise = document.getElementById('sim-water-rise');

// Track consecutive sim pushes so water rise rate can be derived (~cm/min) instead
// of forcing 0.0 — historical records/CSV/reports then show a real trend.
let lastSimWaterLevel = null;
let lastSimPushMs = 0;

// Chart Config Elements
const graphWindowSelect = document.getElementById('graph-window-select');
const graphTensionSlider = document.getElementById('graph-tension-slider');
const saveChartSettingsBtn = document.getElementById('save-chart-settings-btn');

// New Config Elements
const paramAInput = document.getElementById('param-a-input');
const paramBInput = document.getElementById('param-b-input');
const weightPresInput = document.getElementById('weight-pres');
const weightHumInput = document.getElementById('weight-hum');
const weightLightInput = document.getElementById('weight-light');
const weightRainInput = document.getElementById('weight-rain');

const tempOffsetInput = document.getElementById('temp-offset-input');
const waterOffsetInput = document.getElementById('water-offset-input');
const mountHeightInput = document.getElementById('mount-height-input');
const liveStreamIntervalInput = document.getElementById('live-stream-interval-input');
const radiusInput = document.getElementById('radius-input');
const wifiSsidInput = document.getElementById('wifi-ssid-input');
const wifiPassInput = document.getElementById('wifi-pass-input');
const maxLuxInput = document.getElementById('max-lux-input');
const basePresInput = document.getElementById('base-pres-input');
const saveHwBtn = document.getElementById('save-hw-config-btn');

// Live stage-max hint: shows the highest gauge stage the (edited) mount height
// can still support (transducer blind zone = 25 cm).
if (mountHeightInput) {
    mountHeightInput.addEventListener('input', () => {
        const h = parseFloat(mountHeightInput.value);
        const stageMaxEl = document.getElementById('stage-max-hint');
        if (stageMaxEl && !isNaN(h)) stageMaxEl.textContent = Math.max(0, h - 25);
    });
}

const alertCooldownInput = document.getElementById('alert-cooldown-input');
const maintenanceToggle = document.getElementById('maintenance-toggle');
const saveAlertBtn = document.getElementById('save-alert-config-btn');
const historyIntervalInput = document.getElementById('history-interval-input');
const maintenanceStateTag = document.getElementById('maintenance-state-tag');
// Live status pill for the maintenance toggle — reflects the saved on/off state
// and flips immediately when the admin toggles it.
function refreshMaintenanceStateTag() {
    if (!maintenanceStateTag || !maintenanceToggle) return;
    const on = maintenanceToggle.checked === true;
    maintenanceStateTag.innerText = on ? 'Active' : 'Inactive';
    maintenanceStateTag.dataset.state = on ? 'on' : 'off';
}
if (maintenanceToggle) maintenanceToggle.addEventListener('change', refreshMaintenanceStateTag);
// Per-level manual SMS triggers (one button per alert level)
const manualSmsLevelBtns = {
    1: document.getElementById('send-sms-l1-btn'),
    2: document.getElementById('send-sms-l2-btn'),
    3: document.getElementById('send-sms-l3-btn')
};



const logsContainer = document.getElementById('logs-container');
const clearLogsBtn = document.getElementById('clear-logs-btn');

// SIM Elements
const simResponseText = document.getElementById('sim-response');
const simLastCheckText = document.getElementById('sim-last-check');
const simExpiryAlert = document.getElementById('sim-expiry-alert');

// Navigation Logic (Unified for Sidebar and Bottom Nav)
const navLinks = document.querySelectorAll('.nav-item, .nav-btn');
const sections = document.querySelectorAll('.view-section');

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        if (link.id === 'admin-logout-btn') return;
        e.preventDefault();

        const sectionId = link.getAttribute('data-section');
        if (!sectionId) return;

        // Update Active States
        navLinks.forEach(l => l.classList.remove('active'));
        // Find all links for the same section (sidebar and mobile nav)
        document.querySelectorAll(`[data-section="${sectionId}"]`).forEach(l => l.classList.add('active'));

        // Switch View
        sections.forEach(s => s.classList.remove('active'));
        const activeSection = document.getElementById(`section-${sectionId}`);
        if (activeSection) activeSection.classList.add('active');

        // Update Title
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) pageTitle.innerText = link.querySelector('span').innerText;

        // Force chart resize and reload weekly data
        if (sectionId === 'emergency') {
            renderAdminHotlines();
            renderAdminShelters();
        } else if (sectionId === 'analytics' || sectionId === 'reports') {
            if (sectionId === 'reports') {
                loadWeeklyData();
                if (currentLatitude !== 0 && currentLongitude !== 0) {
                    loadOpenMeteoForecast(currentLatitude, currentLongitude);
                } else {
                    // Fallback to the station site (7VMG+6CJ Trece Martires, Cavite)
                    loadOpenMeteoForecast(14.283049, 120.876088);
                }
            }
            setTimeout(() => {
                const charts = [detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart, detailedWaterChart, detailedLightChart, weeklyRainChart, chartRain, hourlyPrecipChart];
                charts.forEach(c => {
                    if (c) {
                        c.resize();
                        c.update('none');
                    }
                });
            }, 400);
        }
    });
});

// Check Auth
auth.onAuthStateChanged(async (user) => {
    if (user) {
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (userDoc.exists && userDoc.data().role === 'admin') {
                loadWeeklyData();
                loadDashboardData();

                // Immediate forecast load with fallback location for speed
                loadOpenMeteoForecast(14.283049, 120.876088);

                // Initialize background based on time immediately
                if (typeof updateBackgroundByTime === 'function') updateBackgroundByTime();
            } else {
                window.location.href = "index.html";
            }
        } catch (e) {
            console.error("Admin auth check failed:", e);
            // On error, still dismiss splash and redirect to login
            dismissSplash();
            window.location.href = "index.html";
        }
    } else {
        window.location.href = "index.html";
    }
});


let currentRainfallVal = 0.0;
let currentRainRateVal = 0.0;
let currentWaterVal = -1.0;
let currentCloudCoverVal = 0.0;
let currentLightVal = -1.0;

function updateWeatherBackground(rainRate, water, light) {
    let weatherType = "sunny";

    if (rainRate !== undefined && rainRate >= 50.0) {
        weatherType = "stormy";
    } else if (rainRate !== undefined && rainRate > 0.0) {
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

    if (typeof setWeatherBackground === 'function') {
        setWeatherBackground(weatherType);
    }
}

function loadDashboardData() {
    // 0. Initialize History once on load
    if (!historyInitialized) {
        historyInitialized = true;
        initializeChartHistory();
        setupAdminRealtimeHistoryListener();
    }

    // Responsive cap: if Firestore is slow to deliver the first snapshot,
    // reveal the (already placeholder-safe) dashboard anyway — the page
    // renders -- / OFFLINE states gracefully, so a stuck splash is worse
    // than showing the ready-to-use shell.
    setTimeout(dismissSplash, 2500);

    // 1. Device Heartbeat
    const handleDeviceCurrentData = (data) => {
        latestFirestoreCurrentData = data;
        if (window.SplashBar) window.SplashBar.set(75); // first live snapshot rendered
        if (data) {
            const lastSeen = data.lastSeen;
            currentRainfallVal = data.rainfall !== undefined ? parseFloat(data.rainfall) : (data.dailyRainfall !== undefined ? parseFloat(data.dailyRainfall) : 0.0);
            const tempVal = data.temperature !== undefined ? parseFloat(data.temperature) : NaN;
            const humidityVal = data.humidity !== undefined ? parseFloat(data.humidity) : NaN;
            const pressureVal = data.pressure !== undefined ? parseFloat(data.pressure) : NaN;

            let lastSeenStr = "";
            const lastSeenDate = parseFirestoreTimestamp(lastSeen);
            lastSeenTimestamp = lastSeenDate;

            if (lastSeenDate && !isNaN(lastSeenDate.getTime())) {
                lastSeenStr = lastSeenDate.toISOString();
                const diffMinutes = (new Date() - lastSeenDate) / 1000 / 60;

                if (diffMinutes < 15) {
                    updateStatusUI("ONLINE", "#10b981", true);
                } else {
                    updateStatusUI("OFFLINE", "#ef4444", false);
                }
            } else {
                updateStatusUI("UNKNOWN", "#94a3b8", false);
            }
            checkAdminDataFreshness();

            // Set Displays
            const tempEl = document.getElementById('temp-summary');
            const humidityEl = document.getElementById('humidity-summary');
            const pressureEl = document.getElementById('pressure-summary');
            if (tempEl) tempEl.innerText = !isNaN(tempVal) ? tempVal.toFixed(1) : "--.-";
            if (humidityEl) humidityEl.innerText = !isNaN(humidityVal) ? humidityVal.toFixed(0) : "--";
            if (pressureEl) pressureEl.innerText = !isNaN(pressureVal) ? pressureVal.toFixed(1) : "----";

            // Location update
            const lat = parseFloat(data.lat) || 0.0;
            const lng = parseFloat(data.lng) || 0.0;
            currentLatitude = lat;
            currentLongitude = lng;

            // Auto load/update forecast if board location changed and coordinates are valid
            if (lat !== 0 && lng !== 0 && (lat.toFixed(3) !== loadedForecastLatitude || lng.toFixed(3) !== loadedForecastLongitude)) {
                loadOpenMeteoForecast(lat, lng);
            }

            updateAdminLocationName(lat, lng);

            // The "View Map" button was removed — clicking the station
            // location name now opens Google Maps at the station coordinates.
            const locationNameAdminEl = document.getElementById('location-name-display-admin');
            if (locationNameAdminEl && lat !== 0 && lng !== 0) {
                locationNameAdminEl.onclick = () => window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
            }

            // Heartbeat & Sensor Data Update
            const lightVal = data.lightLevel !== undefined ? parseFloat(data.lightLevel) : -1.0;
            const waterVal = data.waterLevel !== undefined ? parseFloat(data.waterLevel) : -1.0;
            const pressureTrend = data.pressureTrend !== undefined ? parseFloat(data.pressureTrend) : 0.0;
            const cloudCover = data.cloudCover !== undefined ? parseFloat(data.cloudCover) : 0.0;
            const waterRiseRate = data.waterRiseRate !== undefined ? parseFloat(data.waterRiseRate) : 0.0;

            const lightEl = document.getElementById('light-summary');
            const waterEl = document.getElementById('water-summary');
            const rainEl = document.getElementById('rain-summary');
            const rainRateEl = document.getElementById('rain-rate-summary');
            const adminAlertBadge = document.getElementById('admin-alert-badge');
            const adminRainIntensityBadge = document.getElementById('admin-rain-intensity-badge');

            if (lightEl) lightEl.innerText = lightVal >= 0 ? lightVal.toFixed(0) : "--";
            if (waterEl) waterEl.innerText = waterVal >= 0 ? waterVal.toFixed(1) : "--";
            if (rainEl) rainEl.innerText = currentRainfallVal.toFixed(2);

            // Battery percentage from the live battery voltage (Li-ion:
            // 3.0 V = 0%, 4.2 V = 100%, clamped). "--" when no data. The chip's
            // tooltip shows the exact volts for accuracy verification.
            const batteryVolts = data.battery !== undefined ? parseFloat(data.battery) : NaN;
            const battPctEl = document.getElementById('battery-percentage-summary');
            if (battPctEl) {
                if (!isNaN(batteryVolts) && batteryVolts > 0) {
                    const battPct = Math.round(Math.max(0, Math.min(100, ((batteryVolts - 3.0) / 1.2) * 100)));
                    battPctEl.innerText = battPct;
                    battPctEl.title = `Battery: ${batteryVolts.toFixed(2)} V`;
                } else {
                    battPctEl.innerText = "--";
                    battPctEl.title = 'No battery data';
                }
            }

            const rainRateVal = data.rainRate !== undefined && !Number.isNaN(parseFloat(data.rainRate)) ? parseFloat(data.rainRate) : null;
            const rainRateUnitShown = data.rainRateUnit === 'mm/min' ? 'mm/min' : 'mm/h';
            currentRainRateUnit = rainRateUnitShown;
            const rainRateShownVal = rainRateVal !== null ? (rainRateUnitShown === 'mm/min' ? rainRateVal / 60 : rainRateVal) : null;
            if (rainRateEl) rainRateEl.innerText = rainRateShownVal !== null ? `${rainRateShownVal.toFixed(rainRateUnitShown === 'mm/min' ? 2 : 1)} ${rainRateUnitShown}` : `-- ${rainRateUnitShown}`;

            // Water Rise Rate — live from Firestore weather/current (canonical cm/min),
            // displayed in the admin's chosen unit. "--" when the field is absent.
            const riseRateEl = document.getElementById('water-rise-rate-hero');
            const hasRiseRate = data.waterRiseRate !== undefined && !Number.isNaN(parseFloat(data.waterRiseRate));
            const riseRateShown = hasRiseRate ? parseFloat(data.waterRiseRate) : null;
            const riseUnitShown = data.riseRateUnit === 'cm/h' ? 'cm/h' : 'cm/min';
            currentRiseRateUnit = riseUnitShown;
            const riseShownVal = riseRateShown !== null ? (riseUnitShown === 'cm/h' ? riseRateShown * 60 : riseRateShown) : null;
            if (riseRateEl) {
                riseRateEl.innerText = riseShownVal !== null ? `${riseRateShown > 0 ? '+' : ''}${riseShownVal.toFixed(2)} ${riseUnitShown}` : `-- ${riseUnitShown}`;
                riseRateEl.style.color = riseRateShown === null ? '' : (riseRateShown > 0.2 ? '#ef4444' : riseRateShown > 0 ? '#f59e0b' : '');
            }

            // Water Rise Rate status badge — mirrors the rain intensity badge design
            const riseRateBadge = document.getElementById('water-rise-rate-badge');
            if (riseRateBadge) {
                const rr = riseRateShown !== null ? riseRateShown : 0;
                let badgeText, badgeClass;
                if (rr > 0.2) {
                    badgeText = 'Rapid';
                    badgeClass = 'risk-badge danger badge-sm';
                } else if (rr > 0.01) {
                    badgeText = 'Rising';
                    badgeClass = 'risk-badge warning badge-sm';
                } else if (rr < -0.01) {
                    badgeText = 'Falling';
                    badgeClass = 'risk-badge safe badge-sm';
                } else {
                    badgeText = 'Steady';
                    badgeClass = 'risk-badge safe badge-sm';
                }
                riseRateBadge.innerText = riseRateShown === null ? '—' : badgeText;
                riseRateBadge.className = riseRateShown === null ? 'risk-badge badge-sm' : badgeClass;
            }

            // Update Admin Current Rain Risk Badge
            if (adminAlertBadge) {
                const dangerThreshold = alertThresholdVal;
                const warningThreshold = alertThresholdVal * 0.5;
                const maxChannelCapacity = physicalMountHeight * 0.8;

                if (waterVal >= maxChannelCapacity) {
                    adminAlertBadge.innerText = "FLOODING";
                    adminAlertBadge.className = "risk-badge danger";
                } else if (waterVal >= (maxChannelCapacity * 0.75)) {
                    adminAlertBadge.innerText = "HIGH RISK";
                    adminAlertBadge.className = "risk-badge danger";
                } else if (currentRainfallVal >= dangerThreshold) {
                    adminAlertBadge.innerText = "CRITICAL";
                    adminAlertBadge.className = "risk-badge danger";
                } else if (currentRainfallVal >= warningThreshold) {
                    adminAlertBadge.innerText = "WARNING";
                    adminAlertBadge.className = "risk-badge warning";
                } else if (currentRainfallVal > 0) {
                    adminAlertBadge.innerText = "ALERT";
                    adminAlertBadge.className = "risk-badge alert-level";
                } else {
                    adminAlertBadge.innerText = "Safe";
                    adminAlertBadge.className = "risk-badge safe";
                }
            }

            // Update Admin Rain Rate Intensity Badge
            if (adminRainIntensityBadge) {
                const intensityStr = data.rainIntensity || (rainRateVal >= 50.0 ? 'Violent' : rainRateVal >= 7.5 ? 'Heavy' : rainRateVal >= 2.5 ? 'Moderate' : rainRateVal > 0 ? 'Light' : 'None');
                adminRainIntensityBadge.innerText = intensityStr;
                adminRainIntensityBadge.className = intensityStr === 'None' ? 'risk-badge safe badge-sm' : (intensityStr === 'Heavy' || intensityStr === 'Violent') ? 'risk-badge danger badge-sm' : 'risk-badge warning badge-sm';
            }

            // Update charts when we have a valid and new reading
            if (lastSeenStr && lastSeenStr !== lastProcessedTime) {
                const isFirstSnapshot = !firstSnapshotReceived;
                firstSnapshotReceived = true;
                lastProcessedTime = lastSeenStr;
                // Skip chart update on the very first snapshot — that data is
                // already in the historical chart from initializeChartHistory().
                if (!isFirstSnapshot) {
                    updateCharts(currentRainfallVal, tempVal, humidityVal, pressureVal, waterVal, lightVal);
                }

                // Live-update today's bar in weeklyRainChart in real time!
                if (weeklyRainChart && weeklyRainChart.data && weeklyRainChart.data.datasets.length > 0) {
                    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const todayName = days[new Date().getDay()];
                    const todayIdx = weeklyRainChart.data.labels.indexOf(todayName);
                    if (todayIdx !== -1) {
                        const curBarVal = weeklyRainChart.data.datasets[0].data[todayIdx] || 0;
                        if (currentRainfallVal > curBarVal) {
                            weeklyRainChart.data.datasets[0].data[todayIdx] = currentRainfallVal;
                            weeklyRainChart.update('none');
                        }
                    }
                }
            }

            let cloudCoverVal = data.cloudCover !== undefined ? parseFloat(data.cloudCover) : 0.0;
            if ((data.cloudCover === undefined || cloudCoverVal === 0) && lightVal >= 0) {
                const ratio = Math.min(1.0, lightVal / maxClearSkyLux);
                cloudCoverVal = (1.0 - ratio) * 100.0;
            }
            // Store globally so config snapshot can re-use them
            currentRainRateVal = rainRateVal !== null ? rainRateVal : 0;
            currentWaterVal = waterVal;
            currentCloudCoverVal = cloudCoverVal;
            currentLightVal = lightVal;
            updateWeatherBackground(rainRateVal, waterVal, lightVal);

            // Call updatePredictions to refresh the Weather Outlook card
            updatePredictions(
                tempVal, humidityVal, pressureVal, currentRainfallVal,
                lightVal, waterVal, pressureTrend, cloudCoverVal, waterRiseRate
            );

            // Update reactive global state and refresh timeline
            currentSensorData = { temp: tempVal, rainRate: rainRateVal, water: waterVal, light: lightVal };
            populateHourlyTempTimeline();
        } else {
            updateStatusUI("OFFLINE", "#ef4444", false);
            // Default background based on time if no data
            if (typeof updateBackgroundByTime === 'function') updateBackgroundByTime();
        }

        // Hide splash screen AFTER background is determined
        dismissSplash();
    };

    // Subscribe to Firestore (single source of truth for live telemetry)
    db.collection('weather').doc('current').onSnapshot(doc => {
        handleDeviceCurrentData(doc.exists ? doc.data() : null);
    }, error => {
        console.warn("Firestore current doc error:", error);
        handleDeviceCurrentData(null);
    });

    let lastFetchedAdminLocationNameLat = null;
    let lastFetchedAdminLocationNameLng = null;
    const locationNameDisplayAdmin = document.getElementById('location-name-display-admin');

    // Last resolved station label (e.g. "Barangay, City") — surfaced in the
    // printable report header when present.
    adminStationLocation = '';

    async function updateAdminLocationName(lat, lng) {
        if (lat === 0 || lng === 0) return;
        if (lastFetchedAdminLocationNameLat === lat && lastFetchedAdminLocationNameLng === lng) return;

        try {
            // Persistent localStorage cache (7-day TTL) keyed by rounded
            // coordinates — avoids re-hitting the rate-limited Nominatim
            // service on every page load.
            const cacheKey = `stationPlace_${lat.toFixed(4)}_${lng.toFixed(4)}`;
            let cached = null;
            let cachedLabel = null;
            try {
                const raw = JSON.parse(localStorage.getItem(cacheKey) || 'null');
                if (raw && raw.name && Date.now() - raw.t < 7 * 24 * 3600 * 1000) {
                    cached = raw.name;
                    cachedLabel = raw.label || '';
                }
            } catch (_) { /* ignore corrupt cache entries */ }
            if (cached) {
                adminStationLocation = cachedLabel;
                if (locationNameDisplayAdmin) locationNameDisplayAdmin.innerText = cached;
                lastFetchedAdminLocationNameLat = lat;
                lastFetchedAdminLocationNameLng = lng;
                return;
            }

            if (locationNameDisplayAdmin) locationNameDisplayAdmin.innerText = 'Resolving location...';
            // zoom=18 + addressdetails=1 returns the barangay-level fields
            // (neighbourhood/suburb/quarter) that the coarser zoom=10 omits.
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
            let stationLabel = '';
            if (data && data.address) {
                const addr = data.address;
                // Nominatim maps the subdivision/site to `neighbourhood` and the
                // Philippine barangay to `suburb`/`quarter`/`village`; the city is
                // `city`/`town`. Show them as "Barangay, City" (the user-facing
                // dashboard uses the same mapping).
                const subdivision = addr.neighbourhood || '';
                const barangay = addr.suburb || addr.quarter || addr.village || addr.hamlet || addr.neighbourhood || '';
                const city = addr.city || addr.town || addr.municipality || addr.county || addr.state || '';

                if (subdivision && barangay && subdivision.toLowerCase() !== barangay.toLowerCase()) {
                    placeName = `${subdivision}, ${barangay}`;
                } else {
                    placeName = subdivision || barangay || city || 'Unknown Location';
                }
                if (barangay && city) {
                    stationLabel = `${barangay}, ${city}`;
                } else if (placeName !== 'Unknown Location') {
                    stationLabel = placeName;
                }
            } else if (data && data.display_name) {
                placeName = data.display_name.split(',')[0];
                stationLabel = placeName;
            }

            adminStationLocation = stationLabel;
            if (locationNameDisplayAdmin) locationNameDisplayAdmin.innerText = placeName;
            lastFetchedAdminLocationNameLat = lat;
            lastFetchedAdminLocationNameLng = lng;
            // Cache name + report-header label so future page loads skip the call.
            try {
                localStorage.setItem(cacheKey, JSON.stringify({ name: placeName, label: stationLabel, t: Date.now() }));
            } catch (_) { /* localStorage full/unavailable — lookup still works */ }
        } catch (e) {
            console.error("Error fetching admin location name:", e);
            // Fallback: show the raw coordinates instead of an error message.
            if (locationNameDisplayAdmin) {
                locationNameDisplayAdmin.innerText = `(${lat.toFixed(5)}, ${lng.toFixed(5)})`;
            }
        }
    }

    // 2. Load Config
    const handleConfigData = (data) => {
        if (!data) return;
        const threshold = data.alertThreshold || 50;
        alertThresholdVal = parseFloat(threshold);
        if (thresholdInput) thresholdInput.value = threshold;
        if (currentThresholdDisplay) currentThresholdDisplay.innerText = threshold;
        const defaultL1 = "FLOOD ADVISORY: Light to moderate rainfall detected. Please monitor local conditions.";
        const defaultL2 = "FLOOD ALERT: Heavy rainfall & rising water levels. Prepare for possible evacuation.";
        const defaultL3 = "FLOOD EMERGENCY: Critical water levels & rapid rising flood! Evacuate to higher ground immediately!";

        if (alertL1RainInput) alertL1RainInput.value = data.alertL1Rain !== undefined ? data.alertL1Rain : 20;
        if (alertL1WaterRiseInput) alertL1WaterRiseInput.value = data.alertL1WaterRise !== undefined ? data.alertL1WaterRise : 0.5;

        if (alertL2RainInput) alertL2RainInput.value = data.alertL2Rain !== undefined ? data.alertL2Rain : (data.alertThreshold || 50);
        if (alertL2WaterRiseInput) alertL2WaterRiseInput.value = data.alertL2WaterRise !== undefined ? data.alertL2WaterRise : 1;

        if (alertL3RainInput) alertL3RainInput.value = data.alertL3Rain !== undefined ? data.alertL3Rain : 100;
        if (alertL3WaterRiseInput) alertL3WaterRiseInput.value = data.alertL3WaterRise !== undefined ? data.alertL3WaterRise : 2;

        // Rate computation settings (units & windows). Thresholds above are ALWAYS
        // canonical cm/min — convert the threshold fields to the chosen display unit.
        if (rainRateUnitInput) rainRateUnitInput.value = data.rainRateUnit === 'mm/min' ? 'mm/min' : 'mm/h';
        if (riseRateUnitInput) riseRateUnitInput.value = data.riseRateUnit === 'cm/h' ? 'cm/h' : 'cm/min';
        if (rainRateWindowInput) rainRateWindowInput.value = String(data.rainRateWindowMin || 10);
        if (riseRateWindowInput) riseRateWindowInput.value = String(data.riseRateWindowMin || 5);
        if (riseSmoothInput) riseSmoothInput.value = String(data.riseSmoothMin || 2);
        setRiseDisplayFactor(riseRateUnitInput && riseRateUnitInput.value === 'cm/h' ? 60 : 1);
        setRainDisplayFactor(rainRateUnitInput && rainRateUnitInput.value === 'mm/min' ? 1 / 60 : 1);
        if (alertL1RainRateInput) alertL1RainRateInput.value = data.alertL1RainRate !== undefined ? data.alertL1RainRate : 7.5;
        if (alertL2RainRateInput) alertL2RainRateInput.value = data.alertL2RainRate !== undefined ? data.alertL2RainRate : 15;
        if (alertL3RainRateInput) alertL3RainRateInput.value = data.alertL3RainRate !== undefined ? data.alertL3RainRate : 30;
        if (alertL1WaterLevelInput) alertL1WaterLevelInput.value = data.alertL1WaterLevel !== undefined ? data.alertL1WaterLevel : 0;
        if (alertL2WaterLevelInput) alertL2WaterLevelInput.value = data.alertL2WaterLevel !== undefined ? data.alertL2WaterLevel : 0;
        if (alertL3WaterLevelInput) alertL3WaterLevelInput.value = data.alertL3WaterLevel !== undefined ? data.alertL3WaterLevel : 0;

        if (alertMsgL1Input) alertMsgL1Input.value = data.alertMessageL1 || defaultL1;
        if (alertMsgL2Input) alertMsgL2Input.value = data.alertMessageL2 || data.alertMessage || defaultL2;
        if (alertMsgL3Input) alertMsgL3Input.value = data.alertMessageL3 || defaultL3;
        if (alertMsgInput) alertMsgInput.value = data.alertMessageL2 || data.alertMessage || defaultL2;

        // Populate New Model Fields
        if (paramAInput) paramAInput.value = data.paramA || 200;
        if (paramBInput) paramBInput.value = data.paramB || 1.6;
        if (weightPresInput) weightPresInput.value = data.weightPres || 40;
        if (weightHumInput) weightHumInput.value = data.weightHum || 20;
        if (weightLightInput) weightLightInput.value = data.weightLight || 20;
        if (weightRainInput) weightRainInput.value = data.weightRain || 20;

        // Populate New HW Fields
        if (tempOffsetInput) tempOffsetInput.value = data.tempOffset || 0;
        if (waterOffsetInput) waterOffsetInput.value = data.waterOffset || 0;
        if (mountHeightInput) mountHeightInput.value = data.mountHeight || 200;
        // Keep the water-level stage hint in sync with the sensor height (25 cm blind zone).
        const stageMaxEl = document.getElementById('stage-max-hint');
        if (stageMaxEl) stageMaxEl.textContent = Math.max(0, (data.mountHeight || 200) - 25);
        if (liveStreamIntervalInput) liveStreamIntervalInput.value = data.liveStreamInterval || 10;
        if (radiusInput) radiusInput.value = data.coverageRadius || 5.0;
        if (wifiSsidInput) wifiSsidInput.value = data.wifiSSID || "";
        // Never echo the stored Wi-Fi password back into the DOM — anyone with a
        // moment of access to this screen (or devtools) could read it. Show only
        // whether one exists; saving a blank keeps the current cloud value.
        if (wifiPassInput) {
            const hasSavedPass = !!(data.wifiPass && data.wifiPass.length > 0);
            wifiPassInput.value = "";
            wifiPassInput.placeholder = hasSavedPass ? "Saved — leave blank to keep current" : "WiFi Password";
        }
        if (maxLuxInput) maxLuxInput.value = data.maxClearLux || 65000;
        if (basePresInput) basePresInput.value = data.basePressure || 1013;

        // Populate New Alert/Cooldown Fields
        if (alertCooldownInput) alertCooldownInput.value = data.alertCooldown || 5;
        if (maintenanceToggle) maintenanceToggle.checked = data.maintenanceMode === true;
        refreshMaintenanceStateTag();
        if (historyIntervalInput) historyIntervalInput.value = data.historyIntervalMin !== undefined ? data.historyIntervalMin : 60;

        // Update global settings for live calculations
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
            if (graphTensionSlider) graphTensionSlider.value = currentGraphTension * 100;
        }
        if (data.graphWindow !== undefined) {
            const oldWindow = currentGraphWindow;
            currentGraphWindow = data.graphWindow;
            if (graphWindowSelect) graphWindowSelect.value = currentGraphWindow;

            // If window increased, reload history to fill the gap
            if (currentGraphWindow > oldWindow && historyInitialized) {
                initializeChartHistory();
            }
        }

        // Update Report Param Labels
        const paramZr = document.getElementById('param-zr');
        if (paramZr) paramZr.innerText = `a=${data.paramA || 200}, b=${data.paramB || 1.6}`;

        const paramSaturation = document.getElementById('param-saturation');
        if (paramSaturation && currentRainfallVal !== undefined) {
            const saturation = Math.min(1.0, currentRainfallVal / alertThresholdVal);
            paramSaturation.innerText = saturation.toFixed(2);
        }

        const allCharts = [detailedTempChart, detailedHumChart, detailedPresChart, detailedRainChart, detailedWaterChart, detailedLightChart, atmosphericChart, chartRain];
        allCharts.forEach(c => {
            if (c) {
                c.data.datasets.forEach(ds => ds.tension = currentGraphTension);
                c.update('none');
            }
        });

        updateWeatherBackground(currentRainRateVal, currentWaterVal, currentLightVal);
    };

    let configFirestoreUnsub = null;

    const listenFirestoreConfig = () => {
        if (configFirestoreUnsub) return;
        configFirestoreUnsub = db.collection('weather').doc('config').onSnapshot(doc => {
            handleConfigData(doc.exists ? doc.data() : null);
        });
    };

    listenFirestoreConfig();

    // 3. SIM Status
    db.collection('weather').doc('sim').onSnapshot(doc => {
        if (doc.exists) {
            const data = doc.data();
            const statusStr = data.status || "No report";
            if (simResponseText) simResponseText.innerText = statusStr;
            if (simLastCheckText) simLastCheckText.innerText = data.lastCheck || "--";

            const lowerStatus = statusStr.toLowerCase();
            if (simExpiryAlert) {
                simExpiryAlert.style.display = (lowerStatus.includes("expired") || lowerStatus.includes("0.00")) ? 'flex' : 'none';
            }
        }
    });

    // 4. Load Users
    db.collection('users').onSnapshot(snapshot => {
        if (!userTableBody) return;
        userTableBody.innerHTML = '';
        let subscriberCount = 0;

        // Pass 1 — duplicate detection: normalize every phone number and count
        // how many accounts share it. The device dedupes numbers at dispatch
        // (one SMS per number per alert), so a shared number means one account
        // is silently shadowed — the admin needs to see that.
        const normPhone = (p) => {
            let d = (p || '').replace(/\D/g, '');
            if (d.length === 11 && d.startsWith('09')) d = d.substring(1);
            else if (d.length === 12 && d.startsWith('639')) d = d.substring(2);
            return (d.length === 10 && d.startsWith('9')) ? '+63' + d : '';
        };
        const phoneOwners = {};
        snapshot.forEach(doc => {
            const p = normPhone(doc.data().phoneNumber);
            if (p) (phoneOwners[p] = phoneOwners[p] || []).push(doc.id);
        });

        snapshot.forEach(doc => {
            const userData = doc.data();
            if (userData.role === 'admin') return;
            subscriberCount++;

            const isDisabled = userData.disabled === true;
            const phone = (userData.phoneNumber || '').trim();
            const isDuplicate = normPhone(phone) !== '' && phoneOwners[normPhone(phone)].length > 1;
            const statusColor = isDisabled ? '#f59e0b' : (phone ? '#10b981' : '#ef4444');
            const statusText = isDisabled ? 'Disabled' : (phone ? 'Verified' : 'Pending');

            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <div style="font-weight: 700;">${escapeHtml(userData.email)}</div>
                    <div style="font-size: 0.7rem; color: #94a3b8;">${escapeHtml(doc.id.substring(0, 10))}</div>
                </td>
                <td>${escapeHtml(phone || 'N/A')}${isDuplicate ? ' <span style="color:#f43f5e;font-weight:800;font-size:0.7rem;">⚠ DUPLICATE</span>' : ''}</td>
                <td>
                    <span style="color: ${statusColor}; font-weight: 700; font-size: 0.8rem;">
                        ${statusText}
                    </span>
                </td>
                <td>
                    <button class="text-btn ${isDisabled ? 'success' : 'warning'}" onclick="toggleUserStatus('${doc.id}', ${isDisabled})">
                        ${isDisabled ? 'Enable' : 'Disable'}
                    </button>
                </td>
            `;
            userTableBody.appendChild(row);
        });

        // Duplicate summary banner above the table (persistent element, updated in place)
        const dupNumbers = Object.values(phoneOwners).filter(a => a.length > 1);
        let dupWarn = document.getElementById('dup-phone-warning');
        if (!dupWarn && userTableBody.parentNode) {
            dupWarn = document.createElement('div');
            dupWarn.id = 'dup-phone-warning';
            dupWarn.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;font-size:0.8rem;font-weight:700;color:#f43f5e;background:rgba(244,63,94,0.10);border:1px solid rgba(244,63,94,0.35);display:none;';
            userTableBody.parentNode.insertBefore(dupWarn, userTableBody);
        }
        if (dupWarn) {
            dupWarn.style.display = dupNumbers.length ? 'block' : 'none';
            dupWarn.innerText = `⚠ ${dupNumbers.length} phone number(s) are shared by multiple accounts — those numbers receive only ONE SMS per alert. Contact the users to resolve.`;
        }

        if (totalUsersCount) totalUsersCount.innerText = subscriberCount;
    });

    // 5. System Logs
    db.collection('logs').orderBy('timestamp', 'desc').limit(15).onSnapshot(snapshot => {
        if (!logsContainer) return;
        if (snapshot.empty) {
            logsContainer.innerHTML = '<div class="terminal-placeholder">No recent events.</div>';
            return;
        }
        logsContainer.innerHTML = '';
        snapshot.forEach(doc => {
            const log = doc.data();
            const time = log.timestamp ? (log.timestamp.toDate ? log.timestamp.toDate() : new Date(log.timestamp)).toLocaleTimeString() : '---';

            const logEl = document.createElement('div');
            logEl.style.cssText = "padding: 8px 0; border-bottom: 1px solid #1e293b; color: #e2e8f0; font-size: 0.8rem; font-family: monospace;";
            logEl.innerHTML = `
                <span style="color: #64748b;">[${time}]</span>
                <span style="color: ${log.type === 'Error' ? '#f43f5e' : '#fbbf24'}; font-weight: 800;">${escapeHtml(log.type || 'SYS')}:</span>
                ${escapeHtml(log.message)}
            `;
            logsContainer.appendChild(logEl);
        });
    });
}

function updateStatusUI(text, color, isOnline) {
    // The chip's pill background reacts to state (green pill used to stick
    // around even while the device was offline).
    const badgeEls = [
        deviceStatusValue && deviceStatusValue.parentElement,
        deviceStatusValueDesktop && deviceStatusValueDesktop.parentElement
    ].filter(Boolean);
    badgeEls.forEach(badge => {
        badge.classList.toggle('badge-online', isOnline);
        badge.classList.toggle('badge-offline', !isOnline);
    });
    if (deviceStatusValue) {
        deviceStatusValue.innerText = text;
        deviceStatusValue.parentElement.style.color = color;
    }
    if (deviceStatusValueDesktop) {
        deviceStatusValueDesktop.innerText = text;
        if (deviceStatusValueDesktop.parentElement) {
            deviceStatusValueDesktop.parentElement.style.color = color;
        }
    }
    if (deviceStatusSummary) {
        deviceStatusSummary.innerText = isOnline ? "Active" : "Offline";
        deviceStatusSummary.style.color = color;
    }
    if (headerStatusDot) {
        headerStatusDot.className = isOnline ? 'pulse-dot dot-online' : 'pulse-dot';
        headerStatusDot.style.background = color;
    }
    if (headerStatusDotDesktop) {
        headerStatusDotDesktop.className = isOnline ? 'pulse-dot dot-online' : 'pulse-dot';
        headerStatusDotDesktop.style.background = color;
    }
}

// ── Stale Sensor Data Warning (Alert Command Center) ───────────
// Owner view: unlike the resident dashboard (which says "do not rely on
// these readings"), this banner frames the silence as a device-health
// issue the owner can act on — power, GSM signal, or connectivity.
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes without reports

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

function checkAdminDataFreshness() {
    const banner = document.getElementById('admin-stale-data-banner');
    if (!banner) return;
    const isStale = !!(lastSeenTimestamp && (Date.now() - lastSeenTimestamp.getTime()) > STALE_THRESHOLD_MS);
    banner.style.display = isStale ? 'flex' : 'none';
    if (isStale) {
        const mins = Math.max(0, Math.round((Date.now() - lastSeenTimestamp.getTime()) / 60000));
        const elapsedText = formatReportElapsed(mins);
        const textEl = document.getElementById('admin-stale-data-text');
        if (textEl) {
            const lastReportPart = elapsedText
                ? `No sensor reports received for ${elapsedText}`
                : `No sensor reports since ${formatReportDate(lastSeenTimestamp)}`;
            textEl.innerText = `${lastReportPart}. The device may be offline — check its power, GSM signal, or network connection. Automatic flood alerts may be delayed until reports resume.`;
            if (window.lucide) lucide.createIcons();
        }
    }
}

// Heartbeat Monitor - Force status check every 30 seconds
setInterval(() => {
    if (!lastSeenTimestamp) return;
    const diffMinutes = (new Date() - lastSeenTimestamp) / 1000 / 60;
    if (diffMinutes >= 15) {
        updateStatusUI("OFFLINE", "#ef4444", false);
    } else {
        updateStatusUI("ONLINE", "#10b981", true);
    }
    checkAdminDataFreshness();
}, 30000);

// Helper: Save config to Firestore (single live source for the device)
async function saveConfigDual(configData) {
    const promises = [
        db.collection('weather').doc('config').set(configData, { merge: true })
    ];
    await Promise.all(promises);
}

// Actions
const updateThresholdBtn = document.getElementById('update-threshold-btn');
if (updateThresholdBtn) {
    updateThresholdBtn.addEventListener('click', async () => {
        const val = parseFloat(thresholdInput.value);
        if (isNaN(val)) return;
        try {
            await saveConfigDual({ alertThreshold: val });
            showToast("Threshold Updated");
        } catch (e) { showToast(e.message, 'error'); }
    });
}

if (saveMsgBtn) {
    saveMsgBtn.addEventListener('click', async () => {
        try {
            const l1Rain = alertL1RainInput ? parseFloat(alertL1RainInput.value) : 20;
            const toCanonicalRise = (v) => Math.round((v / riseDisplayFactor) * 1000) / 1000;
            const l1Rise = alertL1WaterRiseInput ? toCanonicalRise(parseFloat(alertL1WaterRiseInput.value)) : 0.5;
            const msgL1 = alertMsgL1Input ? alertMsgL1Input.value : "";

            const l2Rain = alertL2RainInput ? parseFloat(alertL2RainInput.value) : 50;
            const l2Rise = alertL2WaterRiseInput ? toCanonicalRise(parseFloat(alertL2WaterRiseInput.value)) : 1;
            const msgL2 = alertMsgL2Input ? alertMsgL2Input.value : (alertMsgInput ? alertMsgInput.value : "");

            const l3Rain = alertL3RainInput ? parseFloat(alertL3RainInput.value) : 100;
            const l3Rise = alertL3WaterRiseInput ? toCanonicalRise(parseFloat(alertL3WaterRiseInput.value)) : 2;
            const toCanonicalRain = (v) => Math.round((v / rainDisplayFactor) * 1000) / 1000;
            const l1Rate = alertL1RainRateInput ? toCanonicalRain(parseFloat(alertL1RainRateInput.value)) : 7.5;
            const l2Rate = alertL2RainRateInput ? toCanonicalRain(parseFloat(alertL2RainRateInput.value)) : 15;
            const l3Rate = alertL3RainRateInput ? toCanonicalRain(parseFloat(alertL3RainRateInput.value)) : 30;
            const l1Stage = alertL1WaterLevelInput ? parseFloat(alertL1WaterLevelInput.value) : 0;
            const l2Stage = alertL2WaterLevelInput ? parseFloat(alertL2WaterLevelInput.value) : 0;
            const l3Stage = alertL3WaterLevelInput ? parseFloat(alertL3WaterLevelInput.value) : 0;
            const msgL3 = alertMsgL3Input ? alertMsgL3Input.value : "";

            // SMS text limits: one SMS carries 160 GSM-7 characters. The device appends
            // "Issued: MM/DD/YYYY hh:MMAM/PM" (27 chars incl. newline) to every
            // alert, so admin text is capped at 133. Longer texts get split or
            // rejected by the modem; non-GSM characters (emoji, smart quotes)
            // corrupt in the modem's GSM 7-bit alphabet.
            const smsMsgOk = (t) => typeof t === 'string'
                && t.trim().length > 0 && t.length <= 133
                && /^[\x20-\x7E\n\r\t]*$/.test(t);
            for (const [label, t] of [["Level 1", msgL1], ["Level 2", msgL2], ["Level 3", msgL3]]) {
                if (!smsMsgOk(t)) {
                    showToast(`${label} alert message must be 1–133 plain characters (no emoji or smart quotes). The device appends "Issued: <date time>" to every SMS.`, 'error');
                    return;
                }
            }

            // Rain-intensity and gauge-stage triggers: 0 disables a trigger.
            const rateOk = (v) => !isNaN(v) && v >= 0 && v <= 500;
            // Water level can never be measured in the sensor's top 25 cm blind
            // zone — a stage trigger above (mountHeight − 25) would never fire.
            const maxMeasurableStage = Math.max(0, physicalMountHeight - 25);
            const stageOk = (v) => !isNaN(v) && v >= 0 && v <= maxMeasurableStage;
            if (!rateOk(l1Rate) || !rateOk(l2Rate) || !rateOk(l3Rate)) {
                showToast("Rain intensity triggers must be 0-500 mm/h (0 disables the trigger).", "error");
                return;
            }
            if (!stageOk(l1Stage) || !stageOk(l2Stage) || !stageOk(l3Stage)) {
                showToast(`Water level stages must be 0–${maxMeasurableStage} cm (0 disables the trigger). The ultrasonic sensor has a 25 cm blind zone, so the highest measurable level is sensor height (${physicalMountHeight} cm) − 25 cm.`, "error");
                return;
            }

            await saveConfigDual({
                alertL1Rain: isNaN(l1Rain) ? 20 : l1Rain,
                alertL1WaterRise: isNaN(l1Rise) ? 0.5 : l1Rise,
                alertL1RainRate: isNaN(l1Rate) ? 7.5 : l1Rate,
                alertL1WaterLevel: isNaN(l1Stage) ? 0 : l1Stage,
                alertMessageL1: msgL1,

                alertL2Rain: isNaN(l2Rain) ? 50 : l2Rain,
                alertL2WaterRise: isNaN(l2Rise) ? 1 : l2Rise,
                alertL2RainRate: isNaN(l2Rate) ? 15 : l2Rate,
                alertL2WaterLevel: isNaN(l2Stage) ? 0 : l2Stage,
                alertMessageL2: msgL2,

                alertL3Rain: isNaN(l3Rain) ? 100 : l3Rain,
                alertL3WaterRise: isNaN(l3Rise) ? 2 : l3Rise,
                alertL3RainRate: isNaN(l3Rate) ? 30 : l3Rate,
                alertL3WaterLevel: isNaN(l3Stage) ? 0 : l3Stage,
                alertMessageL3: msgL3,

                alertThreshold: isNaN(l2Rain) ? 50 : l2Rain,
                alertMessage: msgL2
            });
            showToast("Alert Levels & Messages Saved");
        } catch (e) { showToast(e.message, 'error'); }
    });
}

if (saveHwBtn) {
    saveHwBtn.addEventListener('click', async () => {
        try {
            // JSN-SR04T physical limits: 25 cm blind zone (cannot measure
            // anything closer); the device itself clamps mountHeight to 50-1000 cm.
            const mh = parseFloat(mountHeightInput ? mountHeightInput.value : NaN);
            if (isNaN(mh) || mh < 25) {
                showToast("Sensor-to-Ground Distance must be at least 25 cm - the JSN-SR04T blind zone makes closer mounting physically impossible.", "error");
                return;
            }
            if (mh > 1000) {
                showToast("Sensor-to-Ground Distance cannot exceed 1000 cm.", "error");
                return;
            }
            const wo = parseFloat(waterOffsetInput ? waterOffsetInput.value : NaN);
            if (!isNaN(wo) && (wo < -100 || wo > 100)) {
                showToast("JSN-SR04T adjustment must stay within +/-100 cm.", "error");
                return;
            }
            if (mh < 50) {
                showToast("Note: the device enforces a 50 cm minimum - values below 50 will be clamped to 50.");
            }
            const hwConfig = {
                tempOffset: parseFloat(tempOffsetInput.value),
                waterOffset: parseFloat(waterOffsetInput.value),
                mountHeight: parseFloat(mountHeightInput.value),
                maxClearLux: parseFloat(maxLuxInput.value),
                basePressure: parseFloat(basePresInput.value),
                wifiSSID: wifiSsidInput.value,
                // Model Calibration fields are saved together with the
                // hardware config from this single button.
                paramA: parseFloat(paramAInput.value),
                paramB: parseFloat(paramBInput.value),
                weightPres: parseInt(weightPresInput.value),
                weightHum: parseInt(weightHumInput.value),
                weightLight: parseInt(weightLightInput.value),
                weightRain: parseInt(weightRainInput.value)
            };
            // RTDB live-stream cadence and deployment radius were removed from this
            // panel; only send them when the (optionally re-added) inputs exist so
            // the previously stored values are left untouched.
            if (liveStreamIntervalInput) {
                hwConfig.liveStreamInterval = parseInt(liveStreamIntervalInput.value, 10) || 10;
            }
            if (radiusInput) {
                hwConfig.coverageRadius = parseFloat(radiusInput.value);
            }
            // Only overwrite the stored password when a new one was typed — a blank
            // field means "keep current", matching the placeholder hint.
            const newPass = wifiPassInput ? wifiPassInput.value.trim() : '';
            if (newPass.length > 0) {
                hwConfig.wifiPass = newPass;
            }
            await saveConfigDual(hwConfig);
            if (wifiPassInput) {
                wifiPassInput.value = "";
                wifiPassInput.placeholder = "Saved — leave blank to keep current";
            }
            showToast("Hardware, WiFi & Model Parameters Saved");
        } catch (e) { showToast(e.message, 'error'); }
    });
}

if (saveAlertBtn) {
    saveAlertBtn.addEventListener('click', async () => {
        try {
            const historyMin = parseInt(historyIntervalInput ? historyIntervalInput.value : '60', 10);
            await saveConfigDual({
                alertCooldown: parseFloat(alertCooldownInput.value),
                maintenanceMode: maintenanceToggle.checked,
                historyIntervalMin: isNaN(historyMin) ? 60 : Math.max(1, Math.min(1440, historyMin)),
                // Rate computation (units & windows) — a change here also clears the
                // device's rate histories on the next config poll (no data mixing).
                rainRateUnit: rainRateUnitInput ? rainRateUnitInput.value : 'mm/h',
                rainRateWindowMin: rainRateWindowInput ? parseInt(rainRateWindowInput.value, 10) : 10,
                riseRateUnit: riseRateUnitInput ? riseRateUnitInput.value : 'cm/min',
                riseRateWindowMin: riseRateWindowInput ? parseInt(riseRateWindowInput.value, 10) : 5,
                riseSmoothMin: riseSmoothInput ? parseInt(riseSmoothInput.value, 10) : 2
            });
            showToast("System State & Rate Computation Applied");
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// ── Remote sensor data reset (tipping bucket + ultrasonic, GPS untouched) ──
// Writes sensorResetTrigger=true to the config doc; the device zeroes its
// rain totals (daily rain, bucket tips, 10-min rain rate) and the ultrasonic
// water-level/rise-rate history on its next config poll, then clears the
// flag. Idempotent on the device side: a failed ack just re-runs an
// already-zero reset.
const resetSensorBtn = document.getElementById('reset-sensor-btn');
if (resetSensorBtn) {
    resetSensorBtn.addEventListener('click', async () => {
        if (!confirm("Reset sensor data on the device?\n\nThis zeroes daily rain, bucket tips, rain rate, and the ultrasonic water-level/rise history.")) return;

        resetSensorBtn.disabled = true;
        try {
            await saveConfigDual({
                sensorResetTrigger: true,
                sensorResetTimestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast("Sensor Reset Requested — device will apply it shortly");
        } catch (e) {
            showToast(e.message, 'error');
        } finally {
            resetSensorBtn.disabled = false;
        }
    });
}

// ── Manual SMS dispatch (per alert level) ────────────────────────────────
// Writes manualSmsTrigger=true plus manualSmsLevel ("1"|"2"|"3") so the
// device firmware knows which level's message to broadcast. The device resets
// the flag after dispatch.
const LEVEL_LABELS = {
    1: "Level 1 Advisory",
    2: "Level 2 Warning",
    3: "Level 3 Emergency"
};

async function triggerManualSms(level) {
    const label = LEVEL_LABELS[level];

    if (!confirm(`This will instantly send a ${label} SMS to ALL registered users. Proceed?`)) return;

    const btn = manualSmsLevelBtns[level];
    if (btn) btn.disabled = true;

    try {
        // Write to Firestore config (single live source for the device)
        const promises = [
            db.collection('weather').doc('config').set({
                manualSmsTrigger: true,
                manualSmsLevel: String(level),
                manualSmsTimestamp: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true })
        ];
        await Promise.all(promises);
        showToast(`${label} — Manual SMS Signal Sent`);
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        setTimeout(() => {
            if (btn) btn.disabled = false;
        }, 5000);
    }
}

Object.entries(manualSmsLevelBtns).forEach(([level, btn]) => {
    if (btn) btn.addEventListener('click', () => triggerManualSms(level));
});

// Combined Help Modal — Hardware & Transmission Configuration Guide.
// Uses a styled, scrollable modal instead of alert() because native alert()
// truncates long text on mobile browsers and reformats line breaks.
const infoHwBtn = document.getElementById('info-hw-btn');
const hwGuideModal = document.getElementById('hw-guide-modal');
const hwGuideClose = document.getElementById('hw-guide-close');

function openHwGuide() {
    if (!hwGuideModal) return;
    hwGuideModal.hidden = false;
    document.body.style.overflow = 'hidden'; // lock page scroll behind the modal
    if (window.lucide) lucide.createIcons();
}
function closeHwGuide() {
    if (!hwGuideModal) return;
    hwGuideModal.hidden = true;
    document.body.style.overflow = '';
}
if (infoHwBtn) infoHwBtn.addEventListener('click', openHwGuide);
if (hwGuideClose) hwGuideClose.addEventListener('click', closeHwGuide);
if (hwGuideModal) {
    hwGuideModal.addEventListener('click', (e) => {
        if (e.target === hwGuideModal) closeHwGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !hwGuideModal.hidden) closeHwGuide();
    });
}

// Alert Command Center Guide — same styled modal pattern as the hardware guide.
const infoAlertBtn = document.getElementById('info-alert-btn');
const alertGuideModal = document.getElementById('alert-guide-modal');
const alertGuideClose = document.getElementById('alert-guide-close');

function openAlertGuide() {
    if (!alertGuideModal) return;
    alertGuideModal.hidden = false;
    document.body.style.overflow = 'hidden'; // lock page scroll behind the modal
    if (window.lucide) lucide.createIcons();
}
function closeAlertGuide() {
    if (!alertGuideModal) return;
    alertGuideModal.hidden = true;
    document.body.style.overflow = '';
}
if (infoAlertBtn) infoAlertBtn.addEventListener('click', openAlertGuide);
if (alertGuideClose) alertGuideClose.addEventListener('click', closeAlertGuide);
if (alertGuideModal) {
    alertGuideModal.addEventListener('click', (e) => {
        if (e.target === alertGuideModal) closeAlertGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !alertGuideModal.hidden) closeAlertGuide();
    });
}

// System Behavior Guide — same styled modal pattern as the other guides.
const infoSysbBtn = document.getElementById('info-sysb-btn');
const sysbGuideModal = document.getElementById('sysb-guide-modal');
const sysbGuideClose = document.getElementById('sysb-guide-close');

function openSysbGuide() {
    if (!sysbGuideModal) return;
    sysbGuideModal.hidden = false;
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
}
function closeSysbGuide() {
    if (!sysbGuideModal) return;
    sysbGuideModal.hidden = true;
    document.body.style.overflow = '';
}
if (infoSysbBtn) infoSysbBtn.addEventListener('click', openSysbGuide);
if (sysbGuideClose) sysbGuideClose.addEventListener('click', closeSysbGuide);
if (sysbGuideModal) {
    sysbGuideModal.addEventListener('click', (e) => {
        if (e.target === sysbGuideModal) closeSysbGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sysbGuideModal.hidden) closeSysbGuide();
    });
}


if (setNowSimBtn) {
    setNowSimBtn.addEventListener('click', () => {
        const now = new Date();
        // Adjust for local time to match datetime-local input format
        const offset = now.getTimezoneOffset() * 60000;
        const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
        simDateTime.value = localISOTime;
    });
}

if (pushSimBtn) {
    pushSimBtn.addEventListener('click', async () => {
        const temp = parseFloat(simTemp.value) || 0;
        const hum = parseFloat(simHum.value) || 0;
        const pres = parseFloat(simPres.value) || 0;
        const rain = parseFloat(simRain.value) || 0;
        const rainRate = parseFloat(simRainRate.value) || 0;
        const light = parseFloat(simLight.value) || 0;
        const water = parseFloat(simWater.value) || 0;
        const selectedDateTime = simDateTime.value ? new Date(simDateTime.value) : null;

        // Optional manual water rise (cm/h). When entered, use it directly
        // (converted to the cm/min canonical field); otherwise fall back to the
        // auto-derived rate from consecutive water-level pushes below.
        const manualRiseCmPerH = simWaterRise ? parseFloat(simWaterRise.value) : NaN;
        const manualRiseCmPerMin = Number.isNaN(manualRiseCmPerH) ? null : manualRiseCmPerH / 60;

        // Derive water rise rate (cm/min) from consecutive simulated pushes so the
        // report/CSV rise-rate column reflects an actual trend, not a hard 0.
        let simRiseRate = 0.0;
        const pushMs = Date.now();
        if (lastSimWaterLevel !== null && (pushMs - lastSimPushMs) >= 1000) {
            simRiseRate = ((water - lastSimWaterLevel) / (pushMs - lastSimPushMs)) * 3600000;
        }
        lastSimWaterLevel = water;
        lastSimPushMs = pushMs;

        // Compute derived metrics (same formulas as Arduino code.ino)
        // Dew Point — Magnus formula
        let dewPoint = 0;
        if (hum > 0 && temp !== 0) {
            const a = 17.27, b = 237.7;
            const gamma = (a * temp) / (b + temp) + Math.log(hum / 100.0);
            dewPoint = (b * gamma) / (a - gamma);
        }

        // Heat Index — Rothfusz regression (only meaningful above 27°C)
        let heatIndex = temp;
        if (temp >= 27.0) {
            const T = temp * 9.0 / 5.0 + 32.0;
            const R = hum;
            const HI = -42.379 + 2.04901523 * T + 10.14333127 * R
                - 0.22475541 * T * R - 6.83783e-3 * T * T
                - 5.481717e-2 * R * R + 1.22874e-3 * T * T * R
                + 8.5282e-4 * T * R * R - 1.99e-6 * T * T * R * R;
            heatIndex = (HI - 32.0) * 5.0 / 9.0;
        }

        // Cloud cover from light
        const MAX_CLEAR_SKY_LUX = 65000.0;
        let cloudCover = 0;
        if (light >= 10) {
            const ratio = Math.min(1.0, light / MAX_CLEAR_SKY_LUX);
            cloudCover = (1.0 - ratio) * 100.0;
        }

        // Rain intensity (WMO classification based on rate)
        let rainIntensity = 'None';
        if (rainRate > 0 && rainRate < 2.5) rainIntensity = 'Light';
        else if (rainRate >= 2.5 && rainRate < 7.5) rainIntensity = 'Moderate';
        else if (rainRate >= 7.5 && rainRate < 50.0) rainIntensity = 'Heavy';
        else if (rainRate >= 50.0) rainIntensity = 'Violent';

        const data = {
            rainfall: rain,
            temperature: temp,
            humidity: hum,
            pressure: pres,
            lightLevel: light,
            waterLevel: water,
            dewPoint: parseFloat(dewPoint.toFixed(1)),
            heatIndex: parseFloat(heatIndex.toFixed(1)),
            rainRate: parseFloat(rainRate.toFixed(1)),
            rainIntensity: rainIntensity,
            cloudCover: parseFloat(cloudCover.toFixed(0)),
            pressureTrend: 0.0,
            waterRiseRate: manualRiseCmPerMin !== null
                ? parseFloat(manualRiseCmPerMin.toFixed(2))
                : parseFloat(simRiseRate.toFixed(2)),
            lastSeen: selectedDateTime || firebase.firestore.FieldValue.serverTimestamp(),
            isSimulated: true
        };

        try {
            pushSimBtn.disabled = true;
            // Update Firestore current doc (live stream for the dashboards)
            const liveData = {
                ...data,
                lastSeen: (selectedDateTime ? selectedDateTime.toISOString() : new Date().toISOString())
            };
            await db.collection('weather').doc('current').set(liveData, { merge: true }).catch(err => {
                console.warn("Firestore simulation update note:", err);
            });

            // ALSO push to history to populate the graphs
            const historyData = {
                ...data,
                timestamp: selectedDateTime || firebase.firestore.FieldValue.serverTimestamp()
            };
            delete historyData.lastSeen; // use timestamp for history
            await db.collection('weather_history').add(historyData);

            showToast("Test Data Pushed");

            // Immediately reload weekly data if on the reports section
            const activeSection = document.querySelector('.view-section.active');
            if (activeSection && (activeSection.id === 'section-reports' || activeSection.id === 'section-overview')) {
                loadWeeklyData();
            }

            // Log the simulation
            await db.collection('logs').add({
                type: "SIM",
                message: `Admin triggered simulation: R:${rain} T:${temp} H:${hum} DP:${dewPoint.toFixed(1)} HI:${heatIndex.toFixed(1)} RR:${rainRate.toFixed(1)}`,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            setTimeout(() => { pushSimBtn.disabled = false; }, 2000);
        } catch (e) {
            showToast(e.message, 'error');
            pushSimBtn.disabled = false;
        }
    });
}

if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
        if (!confirm("Clear all logs?")) return;
        const snip = await db.collection('logs').get();
        const batch = db.batch();
        snip.forEach(d => batch.delete(d.ref));
        await batch.commit();
    });
}

window.deleteUser = async function (uid) {
    if (confirm("Permanently remove this user?")) {
        await db.collection('users').doc(uid).delete();
        await saveConfigDual({ usersVersion: Date.now() });
        showToast("User removed & device sync signal sent");
    }
}

window.toggleUserStatus = async function (uid, isCurrentlyDisabled) {
    const action = isCurrentlyDisabled ? "enable" : "disable";
    if (confirm(`Are you sure you want to ${action} this account?`)) {
        try {
            await db.collection('users').doc(uid).update({
                disabled: !isCurrentlyDisabled
            });
            await saveConfigDual({ usersVersion: Date.now() });
            showToast(`Account ${action}d & device sync signal sent`);
        } catch (e) {
            showToast("Error updating status");
        }
    }
}

function showToast(msg, type) {
    let toast = document.querySelector('.toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }
    toast.innerText = msg;
    toast.classList.add('show');
    toast.style.background = type === 'error'
        ? 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)'
        : '';

    if (toast.timeoutId) {
        clearTimeout(toast.timeoutId);
    }

    toast.timeoutId = setTimeout(() => {
        toast.classList.remove('show');
    }, type === 'error' ? 6000 : 3000);
}

// Mobile hamburger menu (phone view): the 3-line button in the header opens
// a dropdown with all sections + sign out. Replaces the old bottom nav bar.
(function initMobileMenu() {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const menuDropdown = document.getElementById('mobile-menu-dropdown');
    if (!menuBtn || !menuDropdown) return;

    function closeMobileMenu() {
        menuDropdown.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.setAttribute('aria-label', 'Open menu');
    }

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menuDropdown.hidden;
        menuDropdown.hidden = !willOpen;
        menuBtn.setAttribute('aria-expanded', String(willOpen));
        menuBtn.setAttribute('aria-label', willOpen ? 'Close menu' : 'Open menu');
    });

    // Close when a dropdown item is chosen (sections, install, sign-out)
    menuDropdown.addEventListener('click', (e) => {
        if (e.target.closest('.nav-btn, .header-install-btn')) closeMobileMenu();
    });

    // Close when tapping anywhere outside the menu
    document.addEventListener('click', (e) => {
        if (!menuDropdown.hidden && !e.target.closest('.mobile-menu-wrap')) {
            closeMobileMenu();
        }
    });
})();

// Logout Logic (Support both Desktop Sidebar and Mobile Header)
document.querySelectorAll('.logout-action-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
        if (confirm("Are you sure you want to sign out?")) {
            auth.signOut();
        }
    });
});

// ══════════════════════════════════════════════════
// EMERGENCY DIRECTORY & EVACUATION SHELTER MANAGER
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// LIVE EMERGENCY DIRECTORY MANAGER
// Starts EMPTY by design — administrators publish the
// real barangay contacts; no placeholder numbers ship
// to resident devices. (Safety: fake hotlines on a
// flood EWS are worse than an explicit "not yet set".)
// ══════════════════════════════════════════════════

let activeHotlines = [];
let activeShelters = [];

async function loadAdminEmergencyDirectory() {
    try {
        const doc = await db.collection('systemConfig').doc('emergencyDirectory').get();
        if (doc.exists) {
            const data = doc.data();
            if (Array.isArray(data.hotlines) && data.hotlines.length > 0) {
                activeHotlines = data.hotlines;
            }
            if (Array.isArray(data.shelters) && data.shelters.length > 0) {
                activeShelters = data.shelters;
            }
        }
    } catch (e) {
        console.warn("Using default emergency directory:", e);
    }
    renderAdminHotlines();
    renderAdminShelters();
}

function renderAdminHotlines() {
    const tbody = document.getElementById('admin-hotlines-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (activeHotlines.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td colspan="5">
                <div class="admin-empty-state">
                    <i data-lucide="phone-off"></i>
                    <strong>No hotlines published yet</strong>
                    <p>Click "Add Hotline" above to enter your barangay's official emergency numbers, then press Save &amp; Publish.</p>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
        if (window.lucide) lucide.createIcons();
        return;
    }

    activeHotlines.forEach((h, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <input type="text" class="settings-input hotline-input-org" data-idx="${idx}" value="${escapeHtml(h.org || '')}" style="font-weight: 700; width: 100%;" placeholder="Organization name">
            </td>
            <td>
                <input type="text" class="settings-input hotline-input-num" data-idx="${idx}" value="${escapeHtml(h.number || '')}" style="width: 100%;" placeholder="Display numbers">
            </td>
            <td>
                <input type="tel" class="settings-input hotline-input-call" data-idx="${idx}" value="${escapeHtml(h.callNumber || '')}" style="width: 100%;" placeholder="Dial numbers">
            </td>
            <td>
                <input type="text" class="settings-input hotline-input-sub" data-idx="${idx}" value="${escapeHtml(h.sub || '')}" style="width: 100%;" placeholder="Department/Role">
            </td>
            <td>
                <button type="button" class="text-btn danger delete-hotline-btn" data-idx="${idx}" title="Remove this hotline" style="background: rgba(239, 68, 68, 0.08); border-radius: 8px; padding: 8px;">
                    <i data-lucide="trash-2" style="width: 15px; height: 15px; display: block;"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (window.lucide) lucide.createIcons();

    if (!tbody.dataset.listenersAttached) {
        tbody.dataset.listenersAttached = 'true';
        tbody.addEventListener('input', syncHotlinesFromDOM);
        tbody.addEventListener('change', syncHotlinesFromDOM);
        tbody.addEventListener('click', (e) => {
            const btn = e.target.closest('.delete-hotline-btn');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const org = activeHotlines[idx]?.org || 'this hotline';
            if (confirm(`Remove ${org} from the emergency directory?`)) {
                syncHotlinesFromDOM();
                activeHotlines.splice(idx, 1);
                renderAdminHotlines();
                showToast("Hotline removed — press Save & Publish to push the change live.");
            }
        });
    }
}

function addAdminHotline() {
    syncHotlinesFromDOM();
    activeHotlines.push({
        id: `hotline-${Date.now()}`,
        org: "New Emergency Service",
        number: "",
        callNumber: "",
        sub: "",
        icon: "phone",
        badgeClass: ""
    });
    renderAdminHotlines();
    // Focus the new row's org input for immediate editing
    const rows = document.querySelectorAll('#admin-hotlines-tbody .hotline-input-org');
    if (rows.length) rows[rows.length - 1].focus();
}

function renderAdminShelters() {
    const container = document.getElementById('admin-shelters-container');
    if (!container) return;
    container.innerHTML = '';

    if (activeShelters.length === 0) {
        container.innerHTML = `
            <div class="admin-empty-state">
                <i data-lucide="home"></i>
                <strong>No evacuation shelters listed yet</strong>
                <p>Click "Add Evacuation Shelter" above to register your barangay's designated shelters, then press Save &amp; Publish.</p>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    activeShelters.forEach((s, idx) => {
        const card = document.createElement('div');
        card.className = 'glass-card';
        card.style.cssText = 'padding: 1.25rem; border-radius: 18px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.05);';
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong class="shelter-card-title" style="font-size: 0.95rem;">Shelter #${idx + 1}</strong>
                <button type="button" class="text-btn danger delete-shelter-btn" data-idx="${idx}" style="font-size: 0.75rem; padding: 4px 10px; background: rgba(239, 68, 68, 0.1); border-radius: 8px; font-weight: 700;">
                    <i data-lucide="trash-2" style="width: 14px; height: 14px; vertical-align: -2px; margin-right: 2px;"></i> Remove
                </button>
            </div>
            <div class="form-group" style="margin: 0;">
                <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Shelter Facility Name</label>
                <input type="text" class="settings-input shelter-input-name" data-idx="${idx}" value="${escapeHtml(s.name || '')}" placeholder="e.g. Barangay Covered Court" style="width: 100%;">
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div class="form-group" style="margin: 0;">
                    <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Operational Status</label>
                    <div class="shelter-select-wrap">
                        <select class="settings-input shelter-select-status" data-idx="${idx}" style="cursor: pointer; width: 100%;">
                            <option value="open" ${s.status === 'open' || s.status === 'standby' || s.status === 'open_primary' ? 'selected' : ''}>Open</option>
                            <option value="closed" ${s.status === 'closed' ? 'selected' : ''}>Closed</option>
                            <option value="full" ${s.status === 'full' ? 'selected' : ''}>Full</option>
                        </select>
                        <span class="shelter-select-arrow" aria-hidden="true"></span>
                    </div>
                </div>
                <div class="form-group" style="margin: 0;">
                    <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Max Capacity (Persons)</label>
                    <input type="number" class="settings-input shelter-input-capacity" data-idx="${idx}" value="${escapeHtml(s.capacity || '500')}" placeholder="500" style="width: 100%;">
                </div>
            </div>
            <div class="form-group" style="margin: 0;">
                <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Location / Address &amp; Elevation</label>
                <input type="text" class="settings-input shelter-input-address" data-idx="${idx}" value="${escapeHtml(s.address || '')}" placeholder="Street, Barangay (Elevation: XXm)" style="width: 100%;">
            </div>
            <div class="form-group" style="margin: 0;">
                <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Google Maps Navigation URL</label>
                <input type="url" class="settings-input shelter-input-map" data-idx="${idx}" value="${escapeHtml(s.mapUrl || 'https://maps.google.com')}" placeholder="https://maps.google.com/..." style="width: 100%;">
            </div>
            <div class="form-group" style="margin: 0;">
                <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 4px;">Available Amenities</label>
                <div class="amenity-tag-editor" data-idx="${idx}">
                    <div class="amenity-tags-list">
                        ${(s.amenities || []).map(a => `
                            <span class="amenity-tag-chip" data-value="${escapeHtml(a)}">${escapeHtml(a)}
                                <button type="button" class="chip-remove" aria-label="Remove ${escapeHtml(a)}">&times;</button>
                            </span>
                        `).join('')}
                    </div>
                    <input type="text" class="amenity-tag-input" data-idx="${idx}" placeholder="Type an amenity, press Enter…" autocomplete="off">
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();

    // Attach delete listeners
    container.querySelectorAll('.delete-shelter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.idx, 10);
            if (confirm("Remove this evacuation shelter from the directory?")) {
                syncSheltersFromDOM();
                activeShelters.splice(idx, 1);
                renderAdminShelters();
            }
        });
    });

    if (!container.dataset.listenersAttached) {
        container.dataset.listenersAttached = 'true';
        container.addEventListener('input', syncSheltersFromDOM);
        container.addEventListener('change', syncSheltersFromDOM);

        // ── Amenity tag editor interactions (delegated) ──
        container.addEventListener('keydown', (e) => {
            const input = e.target.closest('.amenity-tag-input');
            if (!input) return;
            const editor = input.closest('.amenity-tag-editor');

            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addAmenityChip(editor, input.value);
            } else if (e.key === 'Backspace' && input.value === '') {
                const chips = editor.querySelectorAll('.amenity-tag-chip');
                if (chips.length > 0) {
                    chips[chips.length - 1].remove();
                    syncSheltersFromDOM();
                }
            }
        });

        container.addEventListener('blur', (e) => {
            const input = e.target.closest('.amenity-tag-input');
            if (!input || !input.value.trim()) return;
            addAmenityChip(input.closest('.amenity-tag-editor'), input.value);
        }, true);

        container.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.chip-remove');
            if (removeBtn) {
                removeBtn.closest('.amenity-tag-chip').remove();
                syncSheltersFromDOM();
            }
        });
    }
}

function addAmenityChip(editor, rawValue) {
    if (!editor) return;
    const value = (rawValue || '').trim().replace(/,+$/, '');
    const input = editor.querySelector('.amenity-tag-input');
    if (!value || !input) { if (input) input.value = ''; return; }

    // De-duplicate (case-insensitive)
    const existing = Array.from(editor.querySelectorAll('.amenity-tag-chip'))
        .some(ch => ch.dataset.value.toLowerCase() === value.toLowerCase());
    if (existing) { input.value = ''; return; }

    const chip = document.createElement('span');
    chip.className = 'amenity-tag-chip';
    chip.dataset.value = value;
    chip.innerHTML = `${escapeHtml(value)}<button type="button" class="chip-remove" aria-label="Remove ${escapeHtml(value)}">&times;</button>`;
    editor.querySelector('.amenity-tags-list').appendChild(chip);
    input.value = '';
    syncSheltersFromDOM();
}

function syncHotlinesFromDOM() {
    const orgInputs = document.querySelectorAll('.hotline-input-org');
    const numInputs = document.querySelectorAll('.hotline-input-num');
    const callInputs = document.querySelectorAll('.hotline-input-call');
    const subInputs = document.querySelectorAll('.hotline-input-sub');

    orgInputs.forEach((inp, idx) => {
        if (!activeHotlines[idx]) {
            activeHotlines[idx] = { id: `hotline-${idx + 1}` };
        }
        activeHotlines[idx].org = inp.value.trim();
        // Direct assignment (not ||-fallback) so admins can also CLEAR a field
        if (numInputs[idx]) activeHotlines[idx].number = numInputs[idx].value.trim();
        if (callInputs[idx]) activeHotlines[idx].callNumber = callInputs[idx].value.trim();
        if (subInputs[idx]) activeHotlines[idx].sub = subInputs[idx].value.trim();
    });
}

function syncSheltersFromDOM() {
    const nameInputs = document.querySelectorAll('.shelter-input-name');
    const statusSelects = document.querySelectorAll('.shelter-select-status');
    const capacityInputs = document.querySelectorAll('.shelter-input-capacity');
    const addressInputs = document.querySelectorAll('.shelter-input-address');
    const mapInputs = document.querySelectorAll('.shelter-input-map');
    const amenityEditors = document.querySelectorAll('.amenity-tag-editor');

    if (nameInputs.length === 0) return; // don't wipe if not rendered yet

    activeShelters = [];
    nameInputs.forEach((inp, idx) => {
        const rawStatus = statusSelects[idx]?.value || 'open';
        let status = 'open';
        let statusText = 'OPEN';
        if (rawStatus === 'full') {
            status = 'full';
            statusText = 'FULL';
        } else if (rawStatus === 'closed') {
            status = 'closed';
            statusText = 'CLOSED';
        }
        // 'open', plus legacy 'standby' / 'open_primary' values, all resolve to OPEN

        const amenities = amenityEditors[idx]
            ? Array.from(amenityEditors[idx].querySelectorAll('.amenity-tag-chip')).map(ch => ch.dataset.value).filter(Boolean)
            : [];

        activeShelters.push({
            id: `shelter-${idx + 1}`,
            name: inp.value.trim() || `Evacuation Center #${idx + 1}`,
            status: status,
            statusText: statusText,
            capacity: capacityInputs[idx]?.value.trim() || '500',
            address: addressInputs[idx]?.value.trim() || '',
            mapUrl: mapInputs[idx]?.value.trim() || 'https://maps.google.com',
            amenities: amenities
        });
    });
}

// NOTE: escapeHtml() is defined once at the top of this file (strong version that
// also escapes single quotes). Do NOT re-declare it here — function hoisting made
// a weaker duplicate silently override it for every call site.

// Add New Shelter button
const addShelterBtn = document.getElementById('add-shelter-btn');
if (addShelterBtn) {
    addShelterBtn.addEventListener('click', () => {
        syncSheltersFromDOM();
        activeShelters.push({
            id: `shelter-${activeShelters.length + 1}`,
            name: "New Evacuation Facility",
            status: "open",
            statusText: "OPEN",
            capacity: "300",
            address: "Barangay Main Road",
            mapUrl: "https://maps.google.com",
            amenities: ["Emergency Power", "First Aid"]
        });
        renderAdminShelters();
    });
}

// Add New Hotline button
const addHotlineBtn = document.getElementById('add-hotline-btn');
if (addHotlineBtn) {
    addHotlineBtn.addEventListener('click', addAdminHotline);
}

// Save Directory button
const saveDirectoryBtn = document.getElementById('save-emergency-directory-btn');
if (saveDirectoryBtn) {
    saveDirectoryBtn.addEventListener('click', async () => {
        syncHotlinesFromDOM();
        syncSheltersFromDOM();

        try {
            saveDirectoryBtn.disabled = true;
            saveDirectoryBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Publishing...';
            if (window.lucide) lucide.createIcons();

            await db.collection('systemConfig').doc('emergencyDirectory').set({
                hotlines: activeHotlines,
                shelters: activeShelters,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            showToast("Emergency Directory Published Live to Residents!");
        } catch (e) {
            showToast("Error saving emergency directory: " + e.message, 'error');
        } finally {
            saveDirectoryBtn.disabled = false;
            saveDirectoryBtn.innerHTML = '<i data-lucide="save"></i> Save &amp; Publish Directory';
            if (window.lucide) lucide.createIcons();
        }
    });
}

// Initialize on load — this script is included synchronously at the end of <body>,
// so the DOM is already parsed here. (Previously this ran three times: immediately,
// on DOMContentLoaded, and via setTimeout — triple Firestore fetches and renders.)
loadAdminEmergencyDirectory();

