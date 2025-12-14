
from flask import Flask, render_template, jsonify, make_response, request, session, redirect, url_for
from flask_cors import CORS
from functools import wraps
import requests
import sys
import pytz
from datetime import datetime, timedelta, timezone
import sqlite3
import urllib3
import base64
import orjson
import time
from Crypto.Cipher import AES, PKCS1_OAEP
from Crypto.PublicKey import RSA
from Crypto.Random import get_random_bytes
from Crypto.Hash import SHA256 

import sqlite3
import threading
from dotenv import load_dotenv
import os
from supabase import create_client, Client
from flask_compress import Compress
from waitress import serve

# Load environment variables
load_dotenv()

# SSL Uyarılarını Kapat
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

base_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.join(base_dir, '..', 'frontend')
app = Flask(__name__, template_folder=os.path.join(base_dir, '..'), static_folder=os.path.join(base_dir, '..', 'static'))
Compress(app)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'iett-default-secret-key-2025')
CORS(app, resources={r"/api/*": {"origins": ["https://source-dews.github.io", "https://source-dew.github.io", "http://127.0.0.1:5500", "http://localhost:5500"]}}, supports_credentials=True)

# Lokal geçmiş veritabanı yolu (Vercel için /tmp kullanıyoruz)
HISTORY_DB = "/tmp/vehicle_history.db" if os.getenv('VERCEL') else os.getenv('HISTORY_DB', 'vehicle_history.db')

# Initialize Supabase
supabase_url = os.getenv('SUPABASE_URL')
supabase_key = os.getenv('SUPABASE_KEY')
try:
    supabase: Client = create_client(supabase_url, supabase_key)
except:
    supabase = None
    print("Supabase init failed")

# --- İETT AYARLARI ---
PUBKEY_URL = "https://arac.iett.gov.tr/api/task/crypto/pubkey"
DATA_URL = "https://arac.iett.gov.tr/api/task/bus-fleet/buses"
TASK_URL_TMPL = "https://arac.iett.gov.tr/api/task/getCarTasks/{door_code}"

HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://arac.iett.gov.tr",
    "Referer": "https://arac.iett.gov.tr/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Connection": "keep-alive"
}

# --- HAFIZA AYARLARI ---
GLOBAL_CACHE = {
    "pubkey": None,
    "data": [],
    "last_update": 0
}

TASK_CACHE = {}
TASK_CACHE_DURATION = 600
CACHE_DURATION = 1.5

# Son bilinen konumları hafızada tutarak gereksiz DB yazımını engeller
LAST_KNOWN_LOCATIONS = {} 

# --- VERİTABANI İŞLEMLERİ (WAL Modu) ---
def init_db():
    try:
        with sqlite3.connect(HISTORY_DB) as conn:
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    door_number TEXT,
                    latitude REAL,
                    longitude REAL,
                    timestamp INTEGER
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_door_time ON history (door_number, timestamp)")
            conn.commit()
    except Exception as e:
        print(f"DB Init Error: {e}")

def save_data_to_db(vehicle_list):
    if not vehicle_list: return
    
    now = int(time.time())
    new_records = []
    
    for v in vehicle_list:
        door = v.get("vehicleDoorCode") or v.get("busDoorNumber")
        try:
            lat = float(v.get("latitude"))
            lng = float(v.get("longitude"))
            
            if door and lat and lng:
                # Kontrol: Araç konumu değişti mi?
                last_loc = LAST_KNOWN_LOCATIONS.get(door)
                
                # Eğer ilk kez görüyorsak veya konum değişmişse kaydet
                if not last_loc or (last_loc[0] != lat or last_loc[1] != lng):
                    new_records.append((door, lat, lng, now))
                    LAST_KNOWN_LOCATIONS[door] = (lat, lng)
                    
        except:
            continue
            
    if new_records:
        try:
            with sqlite3.connect(HISTORY_DB) as conn:
                cur = conn.cursor()
                cur.executemany("INSERT INTO history (door_number, latitude, longitude, timestamp) VALUES (?, ?, ?, ?)", new_records)
                conn.commit()
                # print(f"[DB] {len(new_records)} updates saved.") 
        except Exception as e:
            print(f"DB Write Error: {e}")

# --- İETT FONKSİYONLARI ---
def fix_timezone_data(data_list):
    """API'den gelen UTC verileri UTC+3 (Istanbul) saatine çevirir."""
    if not data_list: return []
    fixed = []
    for item in data_list:
        v = item.copy()
        date_str = v.get('lastLocationDate')
        time_str = v.get('lastLocationTime')
        
        if date_str and time_str:
            try:
                # Formatlar: 2025-12-14T00:00:00 ve 15:03:11
                clean_date = date_str[:10] 
                full_str = f"{clean_date} {time_str}"
                
                # UTC varsayarak parse et
                dt_utc = datetime.strptime(full_str, "%Y-%m-%d %H:%M:%S")
                # 3 saat ekle
                dt_tr = dt_utc + timedelta(hours=3)
                
                # geri yaz
                v['lastLocationDate'] = dt_tr.strftime("%Y-%m-%dT00:00:00")
                v['lastLocationTime'] = dt_tr.strftime("%H:%M:%S")
            except:
                pass
        fixed.append(v)
    return fixed

def get_pubkey(session):
    if GLOBAL_CACHE["pubkey"]: return GLOBAL_CACHE["pubkey"]
    try:
        resp = session.get(PUBKEY_URL, timeout=4, verify=False)
        if resp.status_code != 200: return None
        key_data = resp.json().get("key")
        if "-----BEGIN" not in key_data:
            key_data = f"-----BEGIN PUBLIC KEY-----\n{key_data}\n-----END PUBLIC KEY-----"
        
        GLOBAL_CACHE["pubkey"] = key_data
        return key_data
    except Exception as e:
        print(f"Pubkey Error: {e}")
        return None

def fetch_from_iett_internal():
    try:
        with requests.Session() as session:
            pub_key = get_pubkey(session)
            if not pub_key: return []

            # Şifreleme
            aes_key = get_random_bytes(32)
            rsa_key = RSA.import_key(pub_key)
            cipher = PKCS1_OAEP.new(rsa_key, hashAlgo=SHA256)
            enc_key_b64 = base64.b64encode(cipher.encrypt(aes_key)).decode("ascii")

            # İstek
            payload = {"encKey": enc_key_b64}
            resp = session.post(DATA_URL, headers=HEADERS, json=payload, timeout=8, verify=False)
            
            if resp.status_code != 200:
                GLOBAL_CACHE["pubkey"] = None
                return []

            data_json = resp.json()

            # Çözme
            iv = base64.b64decode(data_json.get("iv"))
            full_data = base64.b64decode(data_json.get("data"))
            tag = full_data[-16:]      
            ciphertext = full_data[:-16] 
            
            cipher_aes = AES.new(aes_key, AES.MODE_GCM, nonce=iv)
            plaintext = cipher_aes.decrypt_and_verify(ciphertext, tag)
            
            try:
                # OPTIMIZATION: Use orjson
                final_data = orjson.loads(plaintext)
            except:
                return []
            
            result_list = []
            if isinstance(final_data, dict):
                result_list = final_data.get('data') or final_data.get('buses') or []
            else:
                result_list = final_data
                
            # Saat Düzeltmesi (UTC -> TRT)
            result_list = fix_timezone_data(result_list)
            
            return result_list

    except Exception as e:
        print(f"Fetch Error: {e}")
        return []

def background_worker():
    print("Background fetcher started (Optimized)...")
    error_count = 0 
    while True:
        try:
            data = fetch_from_iett_internal()
            if data:
                GLOBAL_CACHE["data"] = data
                GLOBAL_CACHE["last_update"] = time.time()
                save_data_to_db(data)
                error_count = 0 # Sıfırla
                time.sleep(1.5)
            else:
                # Backoff Logic
                error_count += 1
                wait_time = min(30, 5 + error_count * 2) 
                print(f"Data empty. Waiting {wait_time}s...")
                time.sleep(wait_time)
        except Exception as e:
            print(f"Background Loop Error: {e}")
            error_count += 1
            time.sleep(10)

def cleanup_worker():
    print("DB Cleanup worker started (Runs every 5 min, keeps last 10 min)...")
    while True:
        try:
            time.sleep(300) # 5 Dakika (Daha sık temizle)
            
            # Sadece son 10 dakikayı tut (600 saniye)
            cutoff = int(time.time()) - 600
            
            with sqlite3.connect(HISTORY_DB) as conn:
                cur = conn.cursor()
                cur.execute("DELETE FROM history WHERE timestamp < ?", (cutoff,))
                deleted = cur.rowcount
                conn.commit()
                if deleted > 0:
                    print(f"[CLEANUP] Deleted {deleted} old records.")
                    # Veritabanı boyutunu fiziksel olarak küçült
                    if deleted > 5000:
                        cur.execute("VACUUM")

        except Exception as e:
            print(f"Cleanup Error: {e}")
            time.sleep(60)


# Wrapper for external calls if needed, keeps compatibility
def fetch_from_iett():
    return fetch_from_iett_internal()


def get_history_points(door_number: str, minutes: int = 15, max_points: int = 180):
    """Geçmiş veritabanından belirtilen araç için son N dakikalık konumları getirir."""
    if not os.path.exists(HISTORY_DB):
        return []

    minutes = max(1, min(minutes, 240))
    cutoff_ts = int((datetime.now().timestamp()) - minutes * 60)

    try:
        with sqlite3.connect(HISTORY_DB) as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT latitude, longitude, timestamp
                FROM history
                WHERE door_number = ? AND timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (door_number, cutoff_ts),
            )
            rows = cur.fetchall()




    except Exception as e:
        print(f"History query error: {e}")
        return []

    history = []
    # ŞİMDİ (Türkiye Saati)
    tz = pytz.timezone('Europe/Istanbul')
    now = datetime.now(tz)
    current_date_str = now.strftime("%d-%m-%Y")
    current_time_str = now.strftime("%H:%M:%S")
    for lat, lng, ts in rows:
        try:
            # UTC Timestamp -> Turkey Time
            dt = datetime.fromtimestamp(ts, pytz.timezone('Europe/Istanbul'))
            time_str = dt.strftime("%H:%M:%S")
        except Exception:
            time_str = "--:--:--"

        history.append(
            {
                "lat": float(lat),
                "lng": float(lng),
                "timestamp": int(ts),
                "time": time_str,
            }
        )

    return history

def fetch_vehicle_tasks(door_code):
    """Belirtilen kapı numarası için görevleri çeker."""
    try:
        with requests.Session() as session:
            pub_key = get_pubkey(session)
            if not pub_key: return []

            # Şifreleme
            aes_key = get_random_bytes(32)
            rsa_key = RSA.import_key(pub_key)
            cipher = PKCS1_OAEP.new(rsa_key, hashAlgo=SHA256)
            enc_key_b64 = base64.b64encode(cipher.encrypt(aes_key)).decode("ascii")

            # İstek
            url = TASK_URL_TMPL.format(door_code=door_code)
            payload = {"encKey": enc_key_b64}
            resp = session.post(url, headers=HEADERS, json=payload, timeout=8, verify=False)
            
            if resp.status_code != 200: return []

            data_json = resp.json()
            if not data_json or "data" not in data_json: return []

            # Çözme
            iv = base64.b64decode(data_json.get("iv"))
            full_data = base64.b64decode(data_json.get("data"))
            
            tag = full_data[-16:]      
            ciphertext = full_data[:-16] 
            
            cipher_aes = AES.new(aes_key, AES.MODE_GCM, nonce=iv)
            plaintext = cipher_aes.decrypt_and_verify(ciphertext, tag)
            
            final_data = orjson.loads(plaintext)
            if isinstance(final_data, list):
                return final_data
            
            return []

    except Exception as e:
        print(f"Task Fetch Error: {e}")
        return []

def simplify_tasks(tasks):
    """Ham görev listesini Hat, Kalkış, Saat formatına çevirir (Sadece bugünü alır)."""
    today = datetime.now().date()
    
    simplified = []
    
    # Sıralama için yardımcı fonksiyon
    def get_time(t):
        for k in ("approximateStartTime", "updatedStartTime", "taskStartTime", "approximateEndTime", "plannedStartTime"):
            if t.get(k): return t.get(k)
        return 0

    sorted_tasks = sorted(tasks, key=get_time)

    for t in sorted_tasks:
        # Zaman parse et
        ts = get_time(t)
        if not ts: continue
        
        try:
            dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone()
            
            # TARIH FILTRESI KAPALI (Kullanıcının isteği üzerine tüm görevleri göster)
            # if dt.date() != today: continue
            
            time_str = dt.strftime("%H:%M")
        except: continue

        # Hat ve Kalkış Yeri
        line_code = (t.get("lineCode") or "").strip()
        line_name = (t.get("lineName") or "")
        direction = t.get("routeDirection")

        # Kalkış yeri parse (Örn: "15F - BEYKOZ / KADIKÖY")
        kalkis = line_name
        parts = line_name.split("-")
        if len(parts) >= 2:
            try:
                # Yön 1 ise ikinci parça (dönüş), 0 ise ilk parça (gidiş) gibi varsayım
                # Kodlardaki mantığı basitleştirerek alıyoruz:
                kalkis = parts[1].strip() if str(direction) == "1" else parts[0].strip()
            except: pass

        simplified.append({
            "code": line_code,
            "dest": kalkis,
            "time": time_str,
            "driverRegisterNo": t.get("driverRegisterNo")
        })
    
    return simplified



# --- AUTHENTICATION DISABLED ---
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Şifre kontrolünü iptal ettik, direkt geçiş izni ver
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Admin kontrolünü de devre dışı bırakıyoruz (veya herkese açık yapıyoruz)
        # Güvenlik gerekirse burayı açma, ama şimdilik request üzerine açıyoruz.
        return f(*args, **kwargs)
    return decorated_function

@app.route('/login', methods=['GET', 'POST'])
def login():
    # Login sayfasına gerek yok, direkt ana sayfaya gönder
    return redirect(url_for('home'))

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('home'))

@app.route('/')
@login_required
def home():
    # Username'i varsayılan olarak tanımla
    return render_template('index.html', username="Ziyaretçi")

@app.route('/monitor')
@login_required
def monitor():
    return render_template('monitor.html')

# --- BATCH ANALYSIS HELPER FUNCTIONS ---
def calculate_haversine_distance(lat1, lon1, lat2, lon2):
    import math
    R = 6371000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c

def get_history_points_internal(door_number: str, minutes: int = 5):
    """Internal helper to get history points without Flask context if needed."""
    if not os.path.exists(HISTORY_DB):
        return []

    cutoff_ts = int((datetime.now().timestamp()) - minutes * 60)
    try:
        with sqlite3.connect(HISTORY_DB) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT latitude, longitude, timestamp FROM history WHERE door_number = ? AND timestamp >= ? ORDER BY timestamp ASC",
                (door_number, cutoff_ts),
            )
            rows = cur.fetchall()
    except Exception as e:
        print(f"History Query Error: {e}")
        return []

    history = []
    for lat, lng, ts in rows:
        history.append({
            "lat": float(lat),
            "lng": float(lng),
            "timestamp": int(ts)
        })
    return history

@app.route('/api/batch-analyze', methods=['POST'])
@login_required
def batch_analyze():
    try:
        door_numbers = request.json.get('doors', [])
        results = []
        
        # Optimize: Get all current data map
        current_data_map = {v.get('vehicleDoorCode'): v for v in GLOBAL_CACHE.get("data", []) if v.get('vehicleDoorCode')}
        # Backup map by busDoorNumber
        current_data_map_bus = {v.get('busDoorNumber'): v for v in GLOBAL_CACHE.get("data", []) if v.get('busDoorNumber')}
        
        for door in door_numbers:
            door = door.strip().upper()
            if not door: continue
            
            # Decoupled Statuses
            task_status = "UNKNOWN" # VAR / YOK
            vehicle_status = "UNKNOWN" # HAREKETLİ / DURUYOR / SİNYAL KESİK / PC KAPALI / VERİ YOK
            detail = ""
            
            # 1. TASK CHECK (Independent)
            tasks = fetch_vehicle_tasks(door)
            simple_tasks = simplify_tasks(tasks)
            if len(simple_tasks) > 0:
                 task_status = "VAR"
            else:
                 task_status = "YOK"
            
            # 2. DATA & MOVEMENT CHECK (Independent of Task)
            vehicle = current_data_map.get(door) or current_data_map_bus.get(door)
            
            if not vehicle:
                vehicle_status = "PC KAPALI / VERİ YOK"
            else:
                try:
                    # Check Data Freshness
                    v_date = str(vehicle.get('lastLocationDate', '')).strip()
                    v_time = str(vehicle.get('lastLocationTime', '')).strip()
                    
                    if not v_date or not v_time:
                         vehicle_status = "PC KAPALI"
                         detail = "Tarih/Saat Yok"
                    else:
                        # Try multiple formats
                        v_dt = None
                        formats = [
                            "%d-%m-%Y %H:%M:%S",
                            "%d.%m.%Y %H:%M:%S",
                            "%Y-%m-%d %H:%M:%S",
                            "%d-%m-%Y %H:%M",
                            "%Y-%m-%dT%H:%M:%S"
                        ]
                        
                        v_dt_str = f"{v_date} {v_time}"
                        for fmt in formats:
                            try:
                                v_dt = datetime.strptime(v_dt_str, fmt)
                                break
                            except ValueError:
                                continue
                        
                        if not v_dt:
                             vehicle_status = "VERİ HATASI" 
                             detail = "Tarih Okunamadı"
                        else:
                            now = datetime.now()
                            diff_minutes = (now - v_dt).total_seconds() / 60.0
                            if diff_minutes < -1: diff_minutes = 0
                            
                            if diff_minutes > 10:
                                vehicle_status = "SİNYAL KESİK"
                                detail = f"{int(diff_minutes)} dk gecikme"
                            else:
                                # 3. MOVEMENT CHECK (Ghost Speed Logic)
                                speed = float(vehicle.get('speed', 0))
                                
                                history = get_history_points_internal(door, minutes=5)
                                displacement = 0
                                if history:
                                    oldest = history[0]
                                    newest = history[-1]
                                    displacement = calculate_haversine_distance(oldest['lat'], oldest['lng'], newest['lat'], newest['lng'])

                                if speed > 3:
                                    if displacement > 50:
                                        vehicle_status = "HAREKETLİ"
                                        detail = f"{speed} km/h"
                                    else:
                                        vehicle_status = "DURUYOR"
                                        detail = f"{speed} km/h (GPS Sapması)"
                                else:
                                    if displacement > 50:
                                        vehicle_status = "HAREKETLİ (Dur-Kalk)"
                                        detail = f"{int(displacement)}m Yer Değ."
                                    else:
                                        vehicle_status = "DURUYOR"
                                        detail = f"{int(displacement)}m Yer Değ."
                except Exception as e:
                    print(f"Analysis Error {door}: {e}")
                    vehicle_status = "VERİ HATASI"
                    detail = str(e)[:20]

            results.append({
                "door": door,
                "task_status": task_status,
                "vehicle_status": vehicle_status,
                "detail": detail
            })
            
        return jsonify(results)
    except Exception as e:
         return jsonify({"error": str(e)}), 500

@app.route('/api/veriler')
def veriler():
    try:
        current_time = time.time()
        
        if GLOBAL_CACHE["data"] and (current_time - GLOBAL_CACHE["last_update"] < CACHE_DURATION):
            data = GLOBAL_CACHE["data"]
        else:
            # Veri eskimişse veya yoksa çek
            new_data = fetch_from_iett()
            if new_data:
                GLOBAL_CACHE["data"] = new_data
                GLOBAL_CACHE["last_update"] = current_time
                data = new_data
                # Vercel'de background worker olmadığı için her istekte DB'ye yazmayı deneyebiliriz
                # Ancak bu performansı etkileyebilir. "History" özelliği kritik değilse atlanabilir.
                # Şimdilik "save_data_to_db" yi çağırıyoruz ki anlık history oluşsun.
                # Her istekte DB init kontrolü yapılması gerekebilir çünkü /tmp silinebilir.
                init_db()
                save_data_to_db(data)
            else:
                data = GLOBAL_CACHE["data"]

        # 2. Vercel CDN Cache Ayarı (TAMAMEN KAPALI - ANLIK)
        response = make_response(jsonify(data))
        
        # Tarayıcıya ve Vercel'e "Sakın hafızaya alma, her seferinde taze veri getir" diyoruz.
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        
        return response
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/tasks/<door_number>')
def get_tasks(door_number):
    """Canlı görev listesini döndürür."""
    raw_tasks = fetch_vehicle_tasks(door_number)
    simple_tasks = simplify_tasks(raw_tasks)
    return jsonify(simple_tasks)


@app.route('/api/history/<door_number>')
def get_history(door_number):
    """Belirtilen araç için son X dakikalık hareket geçmişini döndürür."""
    try:
        minutes = request.args.get('minutes', default=15, type=int)
    except Exception:
        minutes = 15




    history = get_history_points(door_number, minutes)
    return jsonify(history)

# --- ADMIN API ---
@app.route('/api/admin/users', methods=['GET'])
@admin_required
def get_users():
    if not supabase:
        return jsonify({"error": "Supabase not connected"}), 500
    try:
        response = supabase.table('users').select('id, username').execute()
        return jsonify(response.data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/users', methods=['POST'])
@admin_required
def add_user():
    if not supabase:
        return jsonify({"error": "Supabase not connected"}), 500
    
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({"error": "Missing fields"}), 400
        
    try:
        # Check if exists
        check = supabase.table('users').select('*').eq('username', username).execute()
        if check.data and len(check.data) > 0:
            return jsonify({"error": "User already exists"}), 400
            
        response = supabase.table('users').insert({
            "username": username,
            "password": password
        }).execute()
        return jsonify({"success": True, "data": response.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/users/<id>', methods=['DELETE'])
@admin_required
def delete_user(id):
    if not supabase:
        return jsonify({"error": "Supabase not connected"}), 500
    try:
        # Prevent deleting admin itself (optional safety)
        # if id == ... : return ...
        
        response = supabase.table('users').delete().eq('id', id).execute()
        return jsonify({"success": True, "data": response.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/users/<id>/password', methods=['PUT'])
@admin_required
def update_user_password(id):
    if not supabase:
        return jsonify({"error": "Supabase not connected"}), 500
    
    data = request.json
    new_password = data.get('password')
    
    if not new_password:
        return jsonify({"error": "Password required"}), 400
        
    try:
        response = supabase.table('users').update({
            "password": new_password
        }).eq('id', id).execute()
        return jsonify({"success": True, "data": response.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/users/<id>/username', methods=['PUT'])
@admin_required
def update_user_username(id):
    if not supabase:
        return jsonify({"error": "Supabase not connected"}), 500
    
    data = request.json
    new_username = data.get('username')
    
    if not new_username:
        return jsonify({"error": "Username required"}), 400
        
    try:
        # Check if username exists (excluding current user)
        # Supabase doesn't have a simple 'neq' for this logic in one query easily without filter
        # So strict approach: check if exists first
        check = supabase.table('users').select('*').eq('username', new_username).neq('id', id).execute()
        if check.data and len(check.data) > 0:
            return jsonify({"error": "Username already taken"}), 400

        response = supabase.table('users').update({
            "username": new_username
        }).eq('id', id).execute()
        return jsonify({"success": True, "data": response.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
