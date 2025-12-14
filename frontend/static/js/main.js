let allVehicles = [];
let currentFilter = 'all';
let currentSearch = '';
let currentCompany = 'all';
let lastFiltered = [];
let staleOnly = false;
let currentViewingDoor = null; // Haritası açık olan araç
const localVehicleHistory = {}; // Frontend-side history cache

// Harita değişkenleri
let map = null;
let polyline = null;

let markers = [];
let cachedBackendHistory = []; // Cache for backend history to avoid re-fetching on live update

// FAVORITES
let favoriteVehicles = [];
try {
    favoriteVehicles = JSON.parse(localStorage.getItem('favVehicles') || '[]');
} catch (e) { favoriteVehicles = []; }



// Özel Marker İkonu
const busIcon = L.divIcon({
    html: '<div style="background:#facc15; border:2px solid #fff; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 5px rgba(0,0,0,0.3);"><i class="fas fa-bus" style="color:#000; font-size:12px;"></i></div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
});

const LABELS = {
    HALK: 'İSTANBUL HALK ULAŞIM TİC.A.Ş'
};

const COMPANY_PRESETS = [
    { match: 'iett', label: 'IETT' },
    { match: 'ozulas', label: 'OZULAS A.S' },
    { match: 'halk ulasim', label: LABELS.HALK }, // Shortened match
    { match: 'mavi marmara', label: 'MAVI MARMARA' },
    { match: 'ist halk otobus', label: 'IST HALK OTOBUS' },
    { match: 'elit karayolu', label: 'ELIT KARAYOLU' },
    { match: 'yeni istanbul ozel halk otobusleri', label: 'YENI ISTANBUL OHO' },
    { match: 'oztas', label: 'OZTAS ULASIM' },
    { match: 'ist ozel tasimacilik', label: 'IST OZEL TASIMACILIK' },
    { match: 'sile', label: 'SILE OTOBÜSLERII' },
    { match: 'cift kat', label: 'CIFT KATLILAR' },
    { match: 'kentic', label: 'KENTICI CIFT KATLI' },
    { match: 'gunaydin', label: 'GUNAYDIN-CIMEN TUR' },
    { match: 'bağımsız', label: LABELS.HALK }, // Exact match
    { match: 'bagimsiz', label: LABELS.HALK }, // ASCII fallback
];

function normalizeText(value) {
    return (value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").trim();
}

function mapCompanyName(name) {
    const raw = (name || '').trim();

    // AGGRESSIVE CATCH-ALL
    const upperRaw = raw.toUpperCase();
    if (upperRaw.includes('HALK ULAŞIM') || upperRaw.includes('HALK ULASIM')) {
        return LABELS.HALK;
    }

    const key = normalizeText(raw);
    for (const item of COMPANY_PRESETS) {
        if (key.includes(normalizeText(item.match))) return item.label;
    }
    return upperRaw || 'BILINMIYOR';
}

function updateClock() { const now = new Date(); document.getElementById('clock').textContent = now.toLocaleTimeString('tr-TR'); }
updateClock(); setInterval(updateClock, 1000);

async function fetchData() {
    document.getElementById('spinner').classList.add('active');
    try {
        const response = await fetch('/api/veriler?t=' + Date.now());
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const raw = await response.text();
        // Check if response is empty or just whitespace
        if (!raw || raw.trim().length === 0) {
            allVehicles = [];
        } else {
            allVehicles = JSON.parse(raw);
        }

        if (!Array.isArray(allVehicles)) allVehicles = [];

        // PULSE SUCCESS
        const pulseDot = document.getElementById('pulseDot');
        const pulseText = document.getElementById('pulseText');
        if (pulseDot) { pulseDot.classList.remove('error'); }
        if (pulseText) { pulseText.innerText = 'SİSTEM AKTİF'; pulseText.style.color = 'white'; }

        // --- FRONTEND CACHING LOGIC ---
        const nowSec = Math.floor(Date.now() / 1000);
        allVehicles.forEach(v => {
            const door = v.vehicleDoorCode || v.busDoorNumber;
            if (door && v.latitude && v.longitude) {
                if (!localVehicleHistory[door]) localVehicleHistory[door] = [];

                const newItem = {
                    lat: Number(v.latitude),
                    lng: Number(v.longitude),
                    timestamp: nowSec,
                    time: v.lastLocationTime || '--:--:--'
                };

                const hist = localVehicleHistory[door];
                const last = hist[hist.length - 1];

                // Sadece konum değiştiyse ekle
                if (!last || Math.abs(last.lat - newItem.lat) > 0.00001 || Math.abs(last.lng - newItem.lng) > 0.00001) {
                    hist.push(newItem);
                }

                // Son 5 dakikadan (300 saniye) eski verileri temizle
                localVehicleHistory[door] = hist.filter(p => nowSec - p.timestamp < 300);
            }
        });
        // -----------------------------

        populateCompanyOptions(allVehicles);
        filterVehicles();

        // Live Map Update (Auto-refresh without backend spam)
        if (currentViewingDoor && document.getElementById('mapModal').classList.contains('active')) {
            const v = allVehicles.find(item => (item.vehicleDoorCode || item.busDoorNumber) === currentViewingDoor);
            if (v && v.latitude && v.longitude) {
                // Don't fit bounds on auto-update to allow user panning
                updateMapDisplay(currentViewingDoor, Number(v.latitude), Number(v.longitude), v.lastLocationDate, v.lastLocationTime, false, true);
            }
        }

    } catch (error) {
        console.warn('Veri çekme hatası (Geçici):', error);
        // PULSE ERROR
        const pulseDot = document.getElementById('pulseDot');
        const pulseText = document.getElementById('pulseText');
        if (pulseDot) { pulseDot.classList.add('error'); }
        if (pulseText) { pulseText.innerText = 'VERİ KESİNTİSİ'; pulseText.style.color = '#ef4444'; }
    } finally {
        setTimeout(() => document.getElementById('spinner').classList.remove('active'), 1000);
    }
}

function computeCounts(list) {
    const now = Date.now();
    let active = 0;
    list.forEach(v => {
        if (isActive(v, now)) active++;
    });
    return { total: list.length, active, inactive: list.length - active };
}

function updateTopCounts(list) {
    const { total, active, inactive } = computeCounts(list);
    document.getElementById('count-all').textContent = total;
    document.getElementById('count-active').textContent = active;
    document.getElementById('count-inactive').textContent = inactive;
}

function updateSummaryCards(list) {
    const { total, active, inactive } = computeCounts(list);
    document.getElementById('totalVehicles').textContent = total;
    document.getElementById('activeVehicles').textContent = active;
    document.getElementById('inactiveVehicles').textContent = inactive;
}

function populateCompanyOptions(data) {
    const counts = {};
    data.forEach(v => {
        const name = mapCompanyName(v.operatorType || 'BİLİNMİYOR');
        if (!counts[name]) counts[name] = 0;
        counts[name]++;
    });
    const sortedKeys = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'tr'));
    const select = document.getElementById('companyFilter');
    const current = select.value;
    let html = `<option value="all">Tüm Şirketler (${data.length})</option>`;
    sortedKeys.forEach(name => {
        html += `<option value="${name}">${name} (${counts[name]})</option>`;
    });
    select.innerHTML = html;
    if (current !== 'all' && counts[current]) select.value = current;
    else currentCompany = 'all';
}

function handleCompanyChange(val) { currentCompany = val; filterVehicles(); }
function toggleStaleFilter() { staleOnly = !staleOnly; document.getElementById('staleBtn').classList.toggle('active', staleOnly); filterVehicles(); }
function handleSearch(value) { currentSearch = value.trim().toLowerCase(); filterVehicles(); }

function filterVehicles(type = currentFilter) {
    currentFilter = type || 'all';
    const now = Date.now();

    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === currentFilter);
    });

    let filtered = allVehicles;
    if (currentCompany !== 'all') filtered = filtered.filter(v => mapCompanyName(v.operatorType) === currentCompany);

    updateTopCounts(filtered);

    if (currentFilter === 'active') filtered = filtered.filter(v => isActive(v, now));
    else if (currentFilter === 'inactive') filtered = filtered.filter(v => !isActive(v, now));

    if (staleOnly) filtered = filtered.filter(v => isStale(v, now));

    if (currentSearch) {
        // Arama sorgusundaki özel karakterleri temizle (b-058 -> b058)
        const qClean = currentSearch.replace(/[^a-z0-9]/g, '');

        filtered = filtered.filter(v => {
            const doorRaw = (v.vehicleDoorCode || v.busDoorNumber || '').toLowerCase();
            const doorClean = doorRaw.replace(/[^a-z0-9]/g, ''); // Araçtaki tireyi de sil (b-058 -> b058)

            const op = mapCompanyName(v.operatorType).toLowerCase();

            // Hem normal halini hem temiz halini kontrol et
            return doorRaw.includes(currentSearch) ||
                doorClean.includes(qClean) ||
                op.includes(currentSearch);
        });
    }

    updateSummaryCards(filtered);

    // SORT: Favorites First
    filtered.sort((a, b) => {
        const doorA = a.vehicleDoorCode || a.busDoorNumber;
        const doorB = b.vehicleDoorCode || b.busDoorNumber;
        const isFavA = favoriteVehicles.includes(doorA);
        const isFavB = favoriteVehicles.includes(doorB);
        if (isFavA && !isFavB) return -1;
        if (!isFavA && isFavB) return 1;
        return 0; // Keep original order otherwise
    });

    let titleText = currentCompany === 'all' ? 'Tüm Şirketler' : currentCompany;
    document.getElementById('contentTitle').textContent = titleText;
    document.getElementById('listCount').textContent = `${filtered.length} Araç`;

    lastFiltered = filtered;
    renderVehicles(filtered);
}

function isActive(v, now) {
    if (!v.lastLocationDate || !v.lastLocationTime) return false;
    const ts = parseDateTime(v.lastLocationDate, v.lastLocationTime);
    const diff = (now - ts) / 1000;
    return diff < 300 && diff > -300;
}

function isStale(v, now) {
    if (!v.lastLocationDate || !v.lastLocationTime) return false;
    const ts = parseDateTime(v.lastLocationDate, v.lastLocationTime);
    const diff = (now - ts) / 1000;
    return diff >= 86400;
}

function toggleFavorite(door) {
    if (favoriteVehicles.includes(door)) {
        favoriteVehicles = favoriteVehicles.filter(d => d !== door);
    } else {
        favoriteVehicles.push(door);
    }
    localStorage.setItem('favVehicles', JSON.stringify(favoriteVehicles));
    filterVehicles(); // Re-render to sort
}

// --- VIRTUAL SCROLLING ---
let virtualData = [];
const ITEM_HEIGHT = 68; // 60px height + 8px gap
const BUFFER_SIZE = 5;
let isVirtualScrollInitialized = false;

function initVirtualScroll() {
    const container = document.getElementById('vehicleList');
    if (container && !isVirtualScrollInitialized) {
        container.addEventListener('scroll', () => {
            window.requestAnimationFrame(renderVisibleItems);
        });
        isVirtualScrollInitialized = true;
    }
}

function renderVehicles(vehicles) {
    virtualData = vehicles;
    const container = document.getElementById('vehicleList');

    if (vehicles.length === 0) {
        container.innerHTML = '<div class="empty-state">Araç bulunamadı</div>';
        return;
    }

    // Initialize container structure if needed
    let shim = document.getElementById('virtual-shim');
    if (!shim) {
        container.innerHTML = '';
        shim = document.createElement('div');
        shim.id = 'virtual-shim';
        shim.style.position = 'relative';
        shim.style.width = '100%';
        container.appendChild(shim);
        initVirtualScroll(); // Ensure listener is attached
    }

    shim.style.height = (vehicles.length * ITEM_HEIGHT) + 'px';
    renderVisibleItems();
}

function renderVisibleItems() {
    const container = document.getElementById('vehicleList');
    const shim = document.getElementById('virtual-shim');
    if (!container || !shim) return;

    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;

    const startIndex = Math.floor(scrollTop / ITEM_HEIGHT);
    const endIndex = Math.min(virtualData.length, Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + BUFFER_SIZE);
    const start = Math.max(0, startIndex - BUFFER_SIZE);

    let html = '';
    const now = Date.now();

    for (let i = start; i < endIndex; i++) {
        if (i >= virtualData.length) break;
        html += generateVehicleHTML(virtualData[i], i * ITEM_HEIGHT, now);
    }
    shim.innerHTML = html;
}

function generateVehicleHTML(v, top, now) {
    const door = v.vehicleDoorCode || v.busDoorNumber || '---';
    const operator = mapCompanyName(v.operatorType);
    const date = v.lastLocationDate || '--/--/----';
    const time = v.lastLocationTime || '--:--:--';
    const active = isActive(v, now);
    const statusClass = active ? 'active' : 'inactive';
    const statusText = active ? 'AKTİF' : 'PASİF';

    const latVal = Number.isFinite(Number(v.latitude)) ? Number(v.latitude) : null;
    const lngVal = Number.isFinite(Number(v.longitude)) ? Number(v.longitude) : null;

    const googleMapLink = (latVal !== null && lngVal !== null)
        ? `https://www.google.com/maps?q=${latVal},${lngVal}`
        : '#';

    const esc = (str) => (str + '').replace(/"/g, '&quot;');

    // Height 60px (leaving 8px for gap/margin simulation)
    return `
                <div class="vehicle-item" style="position:absolute; top:${top}px; left:0; right:0; height:60px; margin:0; cursor:pointer;"
                    onclick="openMap(${esc(JSON.stringify(door))}, ${esc(JSON.stringify(operator))}, ${latVal !== null ? latVal : 'null'}, ${lngVal !== null ? lngVal : 'null'}, ${esc(JSON.stringify(date))}, ${esc(JSON.stringify(time))})">
                    <div class="vehicle-door">${door}</div>
                    <div class="vehicle-operator">${operator}</div>
                    <div class="vehicle-status ${statusClass}">
                        <span class="status-dot"></span>${statusText}
                    </div>
                    <div class="vehicle-meta">
                        <div class="vehicle-date">${date}</div>
                        <div class="vehicle-clock">${time}</div>
                    </div>
                    <div class="action-container">
                        <a href="${googleMapLink}" target="_blank" class="icon-btn map-google" title="Google Haritalar" onclick="event.stopPropagation()">
                            <i class="fas fa-map-marked-alt"></i>
                        </a>
                        <button class="icon-btn map-google" title="Canlı Harita / Rota" style="display:none;">
                            <i class="fas fa-route"></i>
                        </button>
                        <button class="icon-btn star ${favoriteVehicles.includes(door) ? 'active' : ''}" title="İzleme Listesine Ekle/Çıkar"
                            onclick="event.stopPropagation(); toggleFavorite(${esc(JSON.stringify(door))})">
                            <i class="fas fa-star"></i>
                        </button>
                    </div>
                </div>`;
}

// --- HARİTA İŞLEMLERİ ---
async function openMap(doorNumber, operator, currentLat, currentLng, lastDate, lastTime) {
    console.log('openMap', doorNumber, currentLat, currentLng);
    currentViewingDoor = doorNumber; // Şu an izlenen aracı kaydet
    cachedBackendHistory = []; // Reset cache for new vehicle
    fetchData(); // Force list refresh to sync timestamps

    // Görev Listesini Yükle
    loadVehicleTasks(doorNumber);
    const modal = document.getElementById('mapModal');
    if (!modal) {
        alert('Harita modali bulunamadı.');
        return;
    }
    document.getElementById('mapVehicleTitle').textContent = `${doorNumber} - Canlı Araç Konumu`;
    document.getElementById('mapDateBadge').textContent = lastDate || '--.--.----';
    document.getElementById('mapTimeBadge').textContent = lastTime || '--:--:--';

    modal.classList.add('active');

    // === YENI: DETAY PANELINI DOLDUR ===
    const v = allVehicles.find(x => (x.vehicleDoorCode || x.busDoorNumber) === doorNumber);
    if (v) {
        // Yardımcı fonksiyonlar
        const txt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '--'; };

        txt('d-plate', v.numberPlate);
        txt('d-brand', v.brandName);
        txt('d-year', (v.modelYear || '') + ' ' + (v.vehicleType || ''));
        txt('d-seat', v.seatingCapacity || 0);
        txt('d-total', v.fullCapacity || 0);

        // Hız
        const speedEl = document.getElementById('d-speed');
        if (speedEl) speedEl.innerHTML = `${v.speed || 0} <span style="font-size:12px">km/s</span>`;

        // Özellikler (Badge'leri güncelle)
        const setBadge = (id, condition) => {
            const el = document.getElementById(id);
            if (el) {
                if (condition) el.classList.add('active');
                else el.classList.remove('active');
            }
        };

        setBadge('f-usb', v.hasUsbCharger);
        setBadge('f-wifi', v.hasWifi);
        // isAirConditioned bazen null geliyor, True ise göster
        setBadge('f-air', v.isAirConditioned === true || v.isAirConditioned === 'true');
        setBadge('f-access', v.accessibility);
    }

    // Harita ilk kez oluşturuluyorsa
    if (!map) {
        const lightMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
        const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });

        map = L.map('map', {
            zoomControl: false,
            preferCanvas: true,
            layers: [lightMap] // Default
        }).setView([41.0082, 28.9784], 12);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Fix: Use 'topleft' to avoid overlap with 'Yol Tarifi' (topright)
        const overlayMaps = { "🛰️ Uydu Görünümü": satelliteMap };
        L.control.layers(null, overlayMaps, { position: 'topleft' }).addTo(map);
    }

    // Haritayı temizle
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    const directionsBtn = document.getElementById('directionsBtn');
    if (directionsBtn && Number.isFinite(currentLat) && Number.isFinite(currentLng)) {
        directionsBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${currentLat},${currentLng}`;
    }

    // Harita boyutunu güncelle ve geçmişi çiz
    setTimeout(() => map.invalidateSize(), 150);
    await updateMapDisplay(doorNumber, currentLat, currentLng, lastDate, lastTime, true);
}





function closeMap() {
    currentViewingDoor = null; // İzlemeyi bırak

    // Harita katmanlarını temizle
    if (polyline) {
        map.removeLayer(polyline);
        polyline = null;
    }
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    document.getElementById('mapModal').classList.remove('active');

    // Haritayı sıfırla (bellek yönetimi için opsiyonel, mevcut yapıda kalsın)
}

// Harita verilerini çekip ekrana basan ana fonksiyon
async function updateMapDisplay(doorNumber, currentLat, currentLng, lastDate, lastTime, fitBounds = false, skipBackend = false) {
    if (!map) return;

    // Badges güncelle (Senkronize)
    if (lastDate && lastTime) {
        const dBadge = document.getElementById('mapDateBadge');
        const tBadge = document.getElementById('mapTimeBadge');
        if (dBadge) dBadge.textContent = lastDate;
        if (tBadge) tBadge.textContent = lastTime;
    }

    // Mevcut katmanları temizle
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    try {
        // 1. Backend'den 5 dakikalık veri çek (Eğer cache yoksa veya skipBackend false ise)
        // Amaç: Map ilk açıldığında geçmişi al, sonra sadece frontend cache ile devam et

        if (!skipBackend) {
            try {
                const res = await fetch(`/api/history/${doorNumber}?minutes=5`);
                const data = await res.json();
                cachedBackendHistory = Array.isArray(data) ? data : [];
            } catch (e) {
                console.warn("Backend history fetch failed", e);
                cachedBackendHistory = [];
            }
        }

        let backendHistory = cachedBackendHistory;

        // 2. Frontend Cache verisini al
        const frontendHistory = localVehicleHistory[doorNumber] || [];

        // 3. Birleştir ve Sırala (Eskiden yeniye)
        // Basit birleştirme (Duplicate kontrolü yapmıyoruz, çizimde çok sorun olmaz)
        let history = [...backendHistory, ...frontendHistory];

        // Tarihe göre sırala
        history.sort((a, b) => a.timestamp - b.timestamp);

        if (!history || history.length === 0) {
            // Veri yoksa son konuma fallback
            if (currentLat && currentLng) {
                const fallbackMarker = L.marker([currentLat, currentLng], { icon: busIcon }).addTo(map);
                const fallbackLabel = L.marker([currentLat, currentLng], {
                    icon: L.divIcon({
                        className: 'time-label-end',
                        html: `<div style="background:#fff; padding:6px 10px; border:2px solid #dc2626; border-radius:8px; font-weight:800; white-space:nowrap; font-size:14px; color:#000; box-shadow: 0 4px 6px rgba(0,0,0,0.3); margin-top:-60px; transform: translateX(-50%);">
                                        SON KONUM <br> <span style="font-weight:400; font-size:12px;">${lastTime || '--:--:--'}</span>
                                       </div>`
                    })
                }).addTo(map);
                markers.push(fallbackMarker, fallbackLabel);
                if (fitBounds) map.setView([currentLat, currentLng], 15);

                const directionsBtn = document.getElementById('directionsBtn');
                if (directionsBtn) {
                    directionsBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${currentLat},${currentLng}`;
                }
            }
            return;
        }
        // 2. ÇİZGİYİ ÇİZ
        const latlngs = history.map(h => [h.lat, h.lng]);
        polyline = L.polyline(latlngs, {
            color: '#ef4444',
            weight: 4,
            opacity: 0.8,
            smoothFactor: 1
        }).addTo(map);

        // Ara noktalar
        // Ara noktalar (Her güncellemeyi göster)
        const startTime = history[0].timestamp;
        const endTime = history[history.length - 1].timestamp;

        history.forEach((h, index) => {
            if (index === 0 || index === history.length - 1) return;

            // Küçük beyaz nokta
            const m = L.circleMarker([h.lat, h.lng], {
                radius: 4, fillColor: "#fff", color: "#3b82f6", weight: 2, opacity: 0.8, fillOpacity: 0.8
            });

            // Çakışmayı önlemek için Başlangıç ve Bitiş'e yakın olanların SAATİNİ gizle (Nokta kalsın)
            // 60 saniye (1 dakika) tampon bölge
            if (Math.abs(h.timestamp - startTime) > 5 && Math.abs(endTime - h.timestamp) > 5) {
                m.bindTooltip(h.time, {
                    permanent: true,
                    direction: 'right',
                    className: 'time-tooltip',
                    offset: [10, 0]
                });
            }

            m.addTo(map);
            markers.push(m);
        });

        // Başlangıç - Minimal yeşil nokta + zaman
        const start = history[0];
        const startMarker = L.circleMarker([start.lat, start.lng], {
            radius: 12,
            fillColor: "#10b981",
            color: "#fff",
            weight: 4,
            opacity: 1,
            fillOpacity: 1
        }).addTo(map);

        const startLabel = L.marker([start.lat, start.lng], {
            icon: L.divIcon({
                className: 'time-label-start',
                html: `<div style="background: linear-gradient(to bottom, #ffffff 0%, #f0fdf4 100%); padding:10px 14px; border:2px solid #10b981; border-radius:12px; font-size:11px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); white-space: nowrap; text-align:center; margin-left: -40px;">
                                <div style="color:#10b981; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">▲ BAŞLANGIÇ</div>
                                <div style="color:#1f2937; font-weight:700; font-size:13px;">${start.time}</div>
                               </div>`,
                iconSize: [140, 60],
                iconAnchor: [40, 66]
            })
        }).addTo(map);

        // Bitiş (Güncel Konum) - Otobüs ikonu + minimal zaman
        const end = history[history.length - 1];
        const endMarker = L.marker([end.lat, end.lng], { icon: busIcon }).addTo(map);
        const endLabel = L.marker([end.lat, end.lng], {
            icon: L.divIcon({
                className: 'time-label-end',
                html: `<div style="background: linear-gradient(to bottom, #ffffff 0%, #fef2f2 100%); padding:10px 14px; border:2px solid #ef4444; border-radius:12px; font-size:11px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); white-space: nowrap; text-align:center; margin-left: -40px;">
                                <div style="color:#ef4444; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">● SON KONUM</div>
                                <div style="color:#1f2937; font-weight:700; font-size:13px;">${end.time}</div>
                               </div>`,
                iconSize: [140, 60],
                iconAnchor: [40, 66]
            })
        }).addTo(map);

        markers.push(startMarker, endMarker, startLabel, endLabel);

        if (fitBounds) {
            map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
        }
        // Badges güncelle (En güncel veriye göre - History son nokta)
        if (end) {
            const dBadge = document.getElementById('mapDateBadge');
            const tBadge = document.getElementById('mapTimeBadge');
            // Tarih formatı genelde DD-MM-YYYY geliyor, gerekirse parse edilebilir ama şimdilik doğrudan basıyoruz
            // History objesinde tarih yoksa lastDate kullan
            if (dBadge) dBadge.textContent = lastDate;
            if (tBadge) tBadge.textContent = end.time;
        } else if (lastDate && lastTime) {
            // Fallback
            const dBadge = document.getElementById('mapDateBadge');
            const tBadge = document.getElementById('mapTimeBadge');
            if (dBadge) dBadge.textContent = lastDate;
            if (tBadge) tBadge.textContent = lastTime;
        }

    } catch (err) {
        console.error("Map Update Error:", err);
    }
}

// --- GÖREV LİSTESİ (GERÇEK VERİ) ---
async function loadVehicleTasks(doorNumber) {
    const bodies = ['taskTableBody', 'mapTaskTableBody']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    if (bodies.length === 0) return;

    const loadingRow = '<tr><td colspan="3" style="text-align:center; color:#6b7280; padding:20px;">Yükleniyor...</td></tr>';
    bodies.forEach(body => body.innerHTML = loadingRow);

    try {
        const res = await fetch(`/api/tasks/${doorNumber}`);
        const data = await res.json();

        // Şoför Bilgisini Güncelle (İlk görevden al)
        const driverEl = document.getElementById('d-driver');
        if (driverEl) {
            if (data && data.length > 0 && data[0].driverRegisterNo) {
                driverEl.textContent = data[0].driverRegisterNo;
            } else {
                driverEl.textContent = '--';
            }
        }

        if (!data || data.length === 0) {
            const emptyRow = '<tr><td colspan="3" style="text-align:center; color:#ef4444; padding:20px;">Bugün için görev bulunamadı.</td></tr>';
            bodies.forEach(body => body.innerHTML = emptyRow);
            return;
        }

        const html = data.map(t => `
            <tr>
                <td style="font-weight:700; color:#60a5fa;">${t.code}</td>
                <td>${t.dest}</td>
                <td style="font-family:monospace; font-weight:600;">${t.time}</td>
            </tr>
        `).join('');

        bodies.forEach(body => body.innerHTML = html);

        document.querySelectorAll('.task-table-container').forEach(container => container.scrollTop = 0);

    } catch (err) {
        console.error("Task Fetch Error:", err);
        const errorRow = '<tr><td colspan="3" style="text-align:center; color:red;">Hata oluştu.</td></tr>';
        bodies.forEach(body => body.innerHTML = errorRow);
    }
}

// --- EXCEL DÜZELTME (OTOMATİK GENİŞLİK) ---
function downloadExcel() {
    const data = (lastFiltered && lastFiltered.length) ? lastFiltered : allVehicles;
    if (!data.length) return;

    const headers = ['KAPI_NO', 'SIRKET', 'DURUM', 'TARIH', 'SAAT'];
    const now = Date.now();

    const sorted = data.slice(0, 5000).sort((a, b) => {
        const tA = parseDateTime(a.lastLocationDate, a.lastLocationTime);
        const tB = parseDateTime(b.lastLocationDate, b.lastLocationTime);
        return tB - tA;
    });

    const rows = sorted.map(v => [
        v.vehicleDoorCode || v.busDoorNumber || '',
        mapCompanyName(v.operatorType),
        isActive(v, now) ? 'AKTIF' : 'PASIF',
        v.lastLocationDate || '',
        v.lastLocationTime || ''
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    // Sütun Genişliklerini Ayarla
    const wscols = headers.map((h, i) => {
        let maxLen = h.length;
        rows.forEach(r => {
            const cellVal = (r[i] || '').toString();
            if (cellVal.length > maxLen) maxLen = cellVal.length;
        });
        return { wch: maxLen + 5 };
    });
    ws['!cols'] = wscols;

    XLSX.utils.book_append_sheet(wb, ws, 'Veriler');
    XLSX.writeFile(wb, 'IETT-PC-VERI.xlsx');
}

function parseDateTime(d, t) {
    if (!d || !t) return 0;
    try {
        const [day, month, year] = d.split('-');
        const [hour, min, sec] = t.split(':');
        return new Date(year, month - 1, day, hour, min, sec).getTime();
    } catch { return 0; }
}


// --- ADMIN PANEL FUNCTIONS ---
async function openAdminPanel() {
    document.getElementById('adminModal').classList.add('active');
    fetchUsers();
}

function closeAdminPanel() {
    document.getElementById('adminModal').classList.remove('active');
}

async function fetchUsers() {
    const tbody = document.getElementById('userTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:10px;">Yükleniyor...</td></tr>';

    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error('Yetkisiz işlem');
        const users = await res.json();

        let html = '';
        users.forEach(u => {
            html += `
                <tr>
                    <td><span style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #9ca3af; font-size: 12px;">#${u.id}</span></td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #374151 0%, #1f2937 100%); display: flex; align-items: center; justify-content: center; font-size: 10px; color: #d1d5db;">
                                <i class="fas fa-user"></i>
                            </div>
                            <span style="font-weight: 500; letter-spacing: 0.01em;">${u.username}</span>
                            <button class="admin-action-btn btn-edit" onclick="changeUsername('${u.id}', '${u.username}')" title="Kullanıcı Adını Değiştir" style="color: #6b7280;">
                                <i class="fas fa-pen" style="font-size: 12px;"></i>
                            </button>
                        </div>
                    </td>
                    <td style="text-align: right;">
                        <div style="display: inline-flex; gap: 4px;">
                            <button class="admin-action-btn btn-pass" onclick="changePassword('${u.id}', '${u.username}')" title="Şifre Değiştir" style="color: #d97706;">
                                <i class="fas fa-key" style="font-size: 13px;"></i>
                            </button>
                            <button class="admin-action-btn btn-delete" onclick="deleteUser('${u.id}')" title="Kullanıcıyı Sil" style="color: #ef4444;">
                                <i class="fas fa-trash-alt" style="font-size: 13px;"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html || '<tr><td colspan="3" style="text-align:center; padding:20px; color: #6b7280;">Kullanıcı bulunamadı</td></tr>';
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:red; padding:10px;">Hata oluştu!</td></tr>';
    }
}

async function addUser() {
    const usernameInput = document.getElementById('newUsername');
    const passwordInput = document.getElementById('newPassword');
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        alert('Lütfen tüm alanları doldurun');
        return;
    }

    try {
        const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        usernameInput.value = '';
        passwordInput.value = '';
        fetchUsers(); // Refresh list
    } catch (err) {
        alert('Hata: ' + err.message);
    }
}

async function changePassword(id, username) {
    const newPass = prompt(`${username} kullanıcısı için yeni şifreyi girin:`);
    if (!newPass) return; // İptal edildi

    try {
        const res = await fetch(`/api/admin/users/${id}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPass })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        alert('Şifre başarıyla güncellendi.');
    } catch (err) {
        alert('Şifre güncelleme hatası: ' + err.message);
    }
}


async function changeUsername(id, currentUsername) {
    const newUsername = prompt(`"${currentUsername}" için yeni kullanıcı adı girin:`, currentUsername);
    if (!newUsername || newUsername === currentUsername) return;

    try {
        const res = await fetch(`/api/admin/users/${id}/username`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newUsername })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        alert('Kullanıcı adı başarıyla güncellendi.');
        fetchUsers(); // Listeyi yenile
    } catch (err) {
        alert('Hata: ' + err.message);
    }
}

async function deleteUser(id) {
    if (!confirm('Bu kullanıcıyı silmek istediğinize emin misiniz?')) return;

    try {
        const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        fetchUsers();
    } catch (err) {
        alert('Silme işlemi başarısız: ' + err.message);
    }
}

// --- ARAÇ GÖREVLERİ MODAL İŞLEMLERİ ---
function openTasks(door, operator, date, time) {
    currentViewingDoor = door;
    document.getElementById('modalVehicleTitle').textContent = `${door} - ${operator}`;
    document.getElementById('modalDateBadge').textContent = date;
    document.getElementById('modalTimeBadge').textContent = time;

    document.getElementById('taskModal').classList.add('active');

    // Görevleri çek
    loadVehicleTasks(door);
}

function closeTasks() {
    currentViewingDoor = null;
    document.getElementById('taskModal').classList.remove('active');
}

// Start Application
document.addEventListener('DOMContentLoaded', () => {
    console.log("App starting...");
    fetchData(); // Initial fetch
    setInterval(fetchData, 2000); // Poll every 2 seconds
});