import base64
import csv
import io
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "pipeline.db"
STATIC_DIR = BASE_DIR / "static"

PIPELINE_STAGES = [
    "Queued",
    "In Progress",
    "Connected / Answered",
    "No Answer / Voicemail",
    "Follow Up / Closed",
]

DISPOSITION_TO_STAGE = {
    "Answered": "Connected / Answered",
    "No Answer": "No Answer / Voicemail",
    "Busy": "No Answer / Voicemail",
    "Voicemail": "No Answer / Voicemail",
    "Wrong Number": "Follow Up / Closed",
    "Follow Up": "Follow Up / Closed",
}

DEFAULT_SETTINGS = {
    "sonetel_email": "alex.mercer@acmecorp.io",
    "sonetel_password": "",
    "sonetel_account_id": "20849102",
    "sonetel_access_token": "",
    "sonetel_refresh_token": "",
    "sonetel_token_updated_at": "",
    "sonetel_auth_mode": "sandbox",
    "sonetel_api_base": "https://sonetel.com",
    "sonetel_oauth_url": "https://api.sonetel.com/SonetelAuth/beta/oauth/token",
    "sonetel_callback_url": "https://public-api.sonetel.com/make-calls/call/call-back",
    "calling_mode": "callback",  # "callback" or "voip"
    "voip_method": "webrtc",     # "webrtc" (Option A: Browser SIP/WebRTC) or "sip_api" (Option B: API SIP leg)
    "agent_phone": "+14155550199",
    "sip_uri": "sip:alex.mercer@acmecorp.sonetel.com",
    "sip_wss_server": "wss://sip.sonetel.com:443",
    "caller_id": "+14158904410",
    "caller_id_pool": json.dumps([
        {"number": "+14158904410", "label": "US SF Main Line (+1 415-890-4410)", "region": "US"},
        {"number": "+12125550188", "label": "US NYC Direct (+1 212-555-0188)", "region": "US"},
        {"number": "+442079460921", "label": "UK London Office (+44 20 7946 0921)", "region": "GB"},
        {"number": "+46852500190", "label": "Sweden Stockholm HQ (+46 8 525 001 90)", "region": "SE"},
    ]),
    "default_country_code": "+1",
    "auto_dial_next": "false",
    "sound_effects": "true",
    "theme": "dark",
}

COUNTRY_TIMEZONE_MAP = [
    ("+1415", "America/Los_Angeles", -7, "San Francisco, CA"),
    ("+1650", "America/Los_Angeles", -7, "Palo Alto, CA"),
    ("+1408", "America/Los_Angeles", -7, "San Jose, CA"),
    ("+1206", "America/Los_Angeles", -7, "Seattle, WA"),
    ("+1310", "America/Los_Angeles", -7, "Los Angeles, CA"),
    ("+1212", "America/New_York", -4, "New York, NY"),
    ("+1646", "America/New_York", -4, "Manhattan, NY"),
    ("+1617", "America/New_York", -4, "Boston, MA"),
    ("+1305", "America/New_York", -4, "Miami, FL"),
    ("+1312", "America/Chicago", -5, "Chicago, IL"),
    ("+1512", "America/Chicago", -5, "Austin, TX"),
    ("+1720", "America/Denver", -6, "Denver, CO"),
    ("+1", "America/New_York", -4, "United States / Canada"),
    ("+44", "Europe/London", 1, "London, UK"),
    ("+46", "Europe/Stockholm", 2, "Stockholm, Sweden"),
    ("+49", "Europe/Berlin", 2, "Berlin, Germany"),
    ("+33", "Europe/Paris", 2, "Paris, France"),
    ("+31", "Europe/Amsterdam", 2, "Amsterdam, Netherlands"),
    ("+41", "Europe/Zurich", 2, "Zurich, Switzerland"),
    ("+34", "Europe/Madrid", 2, "Madrid, Spain"),
    ("+353", "Europe/Dublin", 1, "Dublin, Ireland"),
    ("+91", "Asia/Kolkata", 5.5, "Bengaluru, India"),
    ("+65", "Asia/Singapore", 8, "Singapore"),
    ("+61", "Australia/Sydney", 10, "Sydney, Australia"),
    ("+81", "Asia/Tokyo", 9, "Tokyo, Japan"),
    ("+971", "Asia/Dubai", 4, "Dubai, UAE"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def sanitize_phone(raw_value: Any, default_country_code: str = "+1") -> str:
    """
    Cleans spaces, dashes, parentheses, dots, European trunk (0), and extensions
    from a phone string and normalizes it into strict E.164 format (+[country][subscriber]).
    """
    if raw_value is None:
        return ""
    text = str(raw_value).strip()
    if not text or text.lower() in ("nan", "none", "null"):
        return ""

    if text.endswith(".0"):
        text = text[:-2]

    text = re.split(r"(?:ext\.?|extension|x|#)\s*\d+", text, flags=re.IGNORECASE)[0].strip()
    text = re.sub(r"\(\s*0\s*\)", "", text)

    has_plus = text.startswith("+")
    digits = re.sub(r"\D", "", text)
    if not digits:
        return ""

    default_cc_digits = re.sub(r"\D", "", default_country_code or "+1") or "1"

    if has_plus:
        return f"+{digits}"

    if text.startswith("00") and len(digits) > 4:
        return f"+{digits[2:]}"

    if len(digits) == 10 and default_cc_digits == "1":
        return f"+1{digits}"

    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"

    if digits.startswith("0") and len(digits) >= 9 and default_cc_digits != "1":
        return f"+{default_cc_digits}{digits[1:]}"

    if len(digits) >= 11:
        return f"+{digits}"

    return f"+{default_cc_digits}{digits}"


def infer_geo_metadata(e164_phone: str, provided_location: str = "") -> Dict[str, Any]:
    phone = e164_phone or ""
    for prefix, tz_name, offset, label in COUNTRY_TIMEZONE_MAP:
        if phone.startswith(prefix):
            return {
                "timezone_name": tz_name,
                "timezone_offset": offset,
                "location": provided_location.strip() if provided_location and provided_location.strip() else label,
            }
    return {
        "timezone_name": "America/Los_Angeles",
        "timezone_offset": -7,
        "location": provided_location.strip() if provided_location and provided_location.strip() else "San Francisco, CA",
    }


def decode_jwt_payload_safe(token: str) -> Dict[str, Any]:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1]
        padding = "=" * ((4 - len(payload_b64) % 4) % 4)
        decoded = base64.urlsafe_b64decode(payload_b64 + padding).decode("utf-8")
        return json.loads(decoded)
    except Exception:
        return {}


def serialize_lead_row(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    raw_cf = d.get("custom_fields") or "{}"
    try:
        parsed_cf = json.loads(raw_cf) if isinstance(raw_cf, str) else raw_cf
        if not isinstance(parsed_cf, dict):
            parsed_cf = {}
    except Exception:
        parsed_cf = {}
    d["custom_fields_parsed"] = parsed_cf
    return d


def seed_initial_data(conn: sqlite3.Connection, force: bool = False):
    if force:
        conn.execute("DELETE FROM call_logs;")
        conn.execute("DELETE FROM leads;")

    count = conn.execute("SELECT COUNT(*) as c FROM leads").fetchone()["c"]
    if count > 0 and not force:
        return

    sample_leads = [
        {
            "name": "Elena Rostova",
            "raw_phone": "(415) 891-2340",
            "company": "Vanguard Cloud Systems",
            "role": "VP of Infrastructure",
            "email": "elena.rostova@vanguardcloud.io",
            "location": "San Francisco, CA",
            "stage": "Queued",
            "priority": "High",
            "tags": "Enterprise, Q4 Renewal",
            "notes": "• Requested architecture brief on multi-region SIP trunking\n• Budget approved for Q4 deployment ($48k ARR)\n• Ask about 120-seat expansion timeline",
            "attempts": 0,
            "sort_order": 1,
            "custom_fields": {
                "Industry": "Cloud Infrastructure",
                "Company Size": "450 Employees",
                "Deal Value": "$48,000 ARR",
                "Current System": "Legacy PBX + Twilio",
                "Website": "https://vanguardcloud.io",
                "Lead Source": "Inbound Architecture Request",
                "Decision Timeline": "Immediate (This Month)",
                "Account Owner": "Alex Mercer",
            },
        },
        {
            "name": "Marcus Vance",
            "raw_phone": "+1 (650) 442-8819",
            "company": "Linearity AI",
            "role": "Head of Revenue Operations",
            "email": "mvance@linearity.ai",
            "location": "Palo Alto, CA",
            "stage": "Queued",
            "priority": "High",
            "tags": "Outbound, RevOps",
            "notes": "• Evaluating Sonetel global numbers for US + EU SDR pods\n• Mentioned latency issues with their legacy provider",
            "attempts": 1,
            "sort_order": 2,
            "custom_fields": {
                "Industry": "Artificial Intelligence SaaS",
                "Company Size": "180 Employees",
                "Deal Value": "$29,500 ARR",
                "Seat Count": "45 Outbound SDRs",
                "Website": "https://linearity.ai",
                "Lead Source": "VP Referral",
                "Preferred Mode": "Internet VoIP + Local Caller ID",
            },
        },
        {
            "name": "Freja Lindqvist",
            "raw_phone": "+46 8 501 294 10",
            "company": "Nordic Ledger AB",
            "role": "Chief Technology Officer",
            "email": "freja@nordicledger.se",
            "location": "Stockholm, Sweden",
            "stage": "Queued",
            "priority": "High",
            "tags": "EMEA, FinTech",
            "notes": "• Interested in Stockholm & London local caller ID presence\n• Prefers concise technical walkthrough",
            "attempts": 0,
            "sort_order": 3,
            "custom_fields": {
                "Industry": "FinTech & Banking",
                "Company Size": "310 Employees",
                "Deal Value": "€36,000 ARR",
                "Regions Needed": "Sweden, UK, Germany",
                "Website": "https://nordicledger.se",
                "Compliance": "GDPR & ISO-27001 Verified",
            },
        },
        {
            "name": "Devon Brooks",
            "raw_phone": "212-690-7731",
            "company": "Harborfront Capital",
            "role": "Managing Director",
            "email": "dbrooks@harborfrontcap.com",
            "location": "New York, NY",
            "stage": "Queued",
            "priority": "Medium",
            "tags": "Finance, Direct",
            "notes": "• Inbound demo request from website pricing calculator\n• Best reached between 9am - 11am EST",
            "attempts": 0,
            "sort_order": 4,
            "custom_fields": {
                "Industry": "Private Equity",
                "Company Size": "95 Employees",
                "Deal Value": "$18,400 ARR",
                "Website": "https://harborfrontcap.com",
                "Office Line": "Direct Executive Desk",
            },
        },
        {
            "name": "Oliver Kensington",
            "raw_phone": "+44 20 7946 0382",
            "company": "Thames Biometrics Ltd",
            "role": "Director of Global Sales",
            "email": "o.kensington@thamesbio.co.uk",
            "location": "London, UK",
            "stage": "Queued",
            "priority": "Medium",
            "tags": "UK, Mid-Market",
            "notes": "• Looking to unify Call Back for traveling reps and WebRTC for inside sales",
            "attempts": 0,
            "sort_order": 5,
            "custom_fields": {
                "Industry": "Biometric Security",
                "Company Size": "220 Employees",
                "Deal Value": "£24,000 ARR",
                "Website": "https://thamesbio.co.uk",
                "Use Case": "Hybrid Mobile Call Back + WebRTC",
            },
        },
        {
            "name": "Priya Nair",
            "raw_phone": "(512) 394-6105",
            "company": "Helios Robotics",
            "role": "Operations Lead",
            "email": "priya@heliosrobotics.com",
            "location": "Austin, TX",
            "stage": "Queued",
            "priority": "Medium",
            "tags": "Hardware, Series B",
            "notes": "• Referred by Marcus at Linearity AI\n• Needs 15 international toll-free numbers",
            "attempts": 0,
            "sort_order": 6,
            "custom_fields": {
                "Industry": "Industrial Robotics",
                "Company Size": "140 Employees",
                "Deal Value": "$21,000 ARR",
                "Website": "https://heliosrobotics.com",
                "Funding Stage": "Series B ($65M)",
            },
        },
        {
            "name": "Lucas Meyer",
            "raw_phone": "+49 30 90182044",
            "company": "Stratos Mobility GmbH",
            "role": "Head of Customer Success",
            "email": "l.meyer@stratos-mobility.de",
            "location": "Berlin, Germany",
            "stage": "In Progress",
            "priority": "High",
            "tags": "DACH, Expansion",
            "notes": "• Currently testing SIP URI forwarding to desktop softphones\n• Follow up on audio codec quality test",
            "attempts": 2,
            "last_disposition": "Answered",
            "sort_order": 7,
            "custom_fields": {
                "Industry": "EV Fleet Software",
                "Company Size": "260 Employees",
                "Deal Value": "€31,000 ARR",
                "Website": "https://stratos-mobility.de",
            },
        },
        {
            "name": "Hannah Chen",
            "raw_phone": "+1 206-555-0147",
            "company": "Cascade Telemetry",
            "role": "VP of Engineering",
            "email": "hannah@cascadetelemetry.dev",
            "location": "Seattle, WA",
            "stage": "Connected / Answered",
            "priority": "High",
            "tags": "Champion, Technical",
            "notes": "• Great 8-minute discovery call!\n• Confirmed Sonetel API integration requirements\n• Sending security questionnaire this afternoon",
            "attempts": 1,
            "last_disposition": "Answered",
            "sort_order": 8,
            "custom_fields": {
                "Industry": "Observability & DevTools",
                "Company Size": "190 Employees",
                "Deal Value": "$34,000 ARR",
                "Website": "https://cascadetelemetry.dev",
            },
        },
        {
            "name": "Soren Lindholm",
            "raw_phone": "(312) 840-9920",
            "company": "Apex Freight Logistics",
            "role": "Fleet Communications Manager",
            "email": "slindholm@apexfreight.com",
            "location": "Chicago, IL",
            "stage": "No Answer / Voicemail",
            "priority": "Low",
            "tags": "Logistics, Callback",
            "notes": "• Left concise voicemail regarding mobile Call Back bridge for field dispatchers\n• Retry tomorrow morning",
            "attempts": 2,
            "last_disposition": "No Answer",
            "sort_order": 9,
            "custom_fields": {
                "Industry": "Supply Chain & Freight",
                "Company Size": "520 Employees",
                "Deal Value": "$15,000 ARR",
                "Website": "https://apexfreight.com",
            },
        },
        {
            "name": "Camille Laurent",
            "raw_phone": "+33 1 42 68 55 19",
            "company": "Atelier Lumiere SaaS",
            "role": "COO",
            "email": "camille@atelierlumiere.fr",
            "location": "Paris, France",
            "stage": "Follow Up / Closed",
            "priority": "Medium",
            "tags": "Contract Sent, EU",
            "notes": "• Annual plan selected, awaiting countersignature on Friday",
            "attempts": 3,
            "last_disposition": "Answered",
            "sort_order": 10,
            "custom_fields": {
                "Industry": "Luxury Retail Tech",
                "Company Size": "115 Employees",
                "Deal Value": "€27,500 ARR",
                "Website": "https://atelierlumiere.fr",
            },
        },
    ]

    ts = now_iso()
    inserted_ids = []
    for item in sample_leads:
        clean_phone = sanitize_phone(item["raw_phone"], "+1")
        geo = infer_geo_metadata(clean_phone, item.get("location", ""))
        cur = conn.execute(
            """
            INSERT INTO leads (
                name, phone, raw_phone, company, role, email, location,
                timezone_offset, stage, last_disposition, notes, attempts,
                last_called_at, priority, tags, custom_fields, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["name"],
                clean_phone,
                item["raw_phone"],
                item["company"],
                item["role"],
                item["email"],
                geo["location"],
                geo["timezone_offset"],
                item["stage"],
                item.get("last_disposition", ""),
                item["notes"],
                item["attempts"],
                ts if item["attempts"] > 0 else "",
                item["priority"],
                item["tags"],
                json.dumps(item.get("custom_fields", {})),
                item["sort_order"],
                ts,
                ts,
            ),
        )
        inserted_ids.append((cur.lastrowid, item, clean_phone))

    sample_calls = [
        {
            "lead_id": inserted_ids[7][0],
            "lead_name": "Hannah Chen",
            "lead_company": "Cascade Telemetry",
            "lead_phone": "+12065550147",
            "call_mode": "voip",
            "voip_method": "webrtc",
            "call1_source": "sip:alex.mercer@acmecorp.sonetel.com",
            "call2_destination": "+12065550147",
            "caller_id": "+14158904410",
            "duration_seconds": 492,
            "disposition": "Answered",
            "notes_snapshot": "Great 8-minute discovery call! Confirmed Sonetel API integration requirements.",
            "sonetel_call_id": "snt-voip-98412a",
            "api_endpoint": "https://sonetel.com / SIP WebRTC Bridge",
            "is_simulated": 1,
        },
        {
            "lead_id": inserted_ids[8][0],
            "lead_name": "Soren Lindholm",
            "lead_company": "Apex Freight Logistics",
            "lead_phone": "+13128409920",
            "call_mode": "callback",
            "voip_method": "",
            "call1_source": "+14155550199",
            "call2_destination": "+13128409920",
            "caller_id": "+14158904410",
            "duration_seconds": 38,
            "disposition": "No Answer",
            "notes_snapshot": "Left concise voicemail regarding mobile Call Back bridge for field dispatchers.",
            "sonetel_call_id": "snt-cb-77219f",
            "api_endpoint": "https://sonetel.com/make-calls/call/call-back",
            "is_simulated": 1,
        },
        {
            "lead_id": inserted_ids[6][0],
            "lead_name": "Lucas Meyer",
            "lead_company": "Stratos Mobility GmbH",
            "lead_phone": "+493090182044",
            "call_mode": "voip",
            "voip_method": "sip_api",
            "call1_source": "sip:alex.mercer@acmecorp.sonetel.com",
            "call2_destination": "+493090182044",
            "caller_id": "+46852500190",
            "duration_seconds": 215,
            "disposition": "Answered",
            "notes_snapshot": "Testing SIP URI forwarding to desktop softphones. Audio crisp.",
            "sonetel_call_id": "snt-sip-66104c",
            "api_endpoint": "https://sonetel.com/make-calls/call/call-back",
            "is_simulated": 1,
        },
    ]

    for call in sample_calls:
        payload_dict = {
            "app_id": "sonetel-mac-power-dialer",
            "call1": call["call1_source"],
            "call2": call["call2_destination"],
            "show_1": call["caller_id"],
            "show_2": call["caller_id"],
        }
        resp_dict = {
            "status": "success",
            "status_code": 200,
            "call_id": call["sonetel_call_id"],
            "mode": call["call_mode"],
            "routing": f"{call['call1_source']} -> {call['call2_destination']}",
        }
        conn.execute(
            """
            INSERT INTO call_logs (
                lead_id, lead_name, lead_company, lead_phone, call_mode, voip_method,
                call1_source, call2_destination, caller_id, duration_seconds,
                disposition, notes_snapshot, sonetel_call_id, api_endpoint,
                api_payload, api_response, is_simulated, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call["lead_id"],
                call["lead_name"],
                call["lead_company"],
                call["lead_phone"],
                call["call_mode"],
                call["voip_method"],
                call["call1_source"],
                call["call2_destination"],
                call["caller_id"],
                call["duration_seconds"],
                call["disposition"],
                call["notes_snapshot"],
                call["sonetel_call_id"],
                call["api_endpoint"],
                json.dumps(payload_dict),
                json.dumps(resp_dict),
                call["is_simulated"],
                ts,
            ),
        )


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                raw_phone TEXT DEFAULT '',
                company TEXT DEFAULT '',
                role TEXT DEFAULT '',
                email TEXT DEFAULT '',
                location TEXT DEFAULT '',
                timezone_offset REAL DEFAULT -7,
                stage TEXT DEFAULT 'Queued',
                last_disposition TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                attempts INTEGER DEFAULT 0,
                last_called_at TEXT DEFAULT '',
                priority TEXT DEFAULT 'Medium',
                tags TEXT DEFAULT '',
                custom_fields TEXT DEFAULT '{}',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        existing_cols = [r["name"] for r in conn.execute("PRAGMA table_info(leads);").fetchall()]
        if "custom_fields" not in existing_cols:
            conn.execute("ALTER TABLE leads ADD COLUMN custom_fields TEXT DEFAULT '{}';")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS call_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lead_id INTEGER,
                lead_name TEXT NOT NULL,
                lead_company TEXT DEFAULT '',
                lead_phone TEXT NOT NULL,
                call_mode TEXT NOT NULL,
                voip_method TEXT DEFAULT '',
                call1_source TEXT NOT NULL,
                call2_destination TEXT NOT NULL,
                caller_id TEXT DEFAULT '',
                duration_seconds INTEGER DEFAULT 0,
                disposition TEXT DEFAULT '',
                notes_snapshot TEXT DEFAULT '',
                sonetel_call_id TEXT DEFAULT '',
                api_endpoint TEXT DEFAULT '',
                api_payload TEXT DEFAULT '',
                api_response TEXT DEFAULT '',
                is_simulated INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
            );
            """
        )

        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (k, str(v)),
            )

        seed_initial_data(conn, force=False)


def get_all_settings(conn: sqlite3.Connection) -> Dict[str, Any]:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    result = dict(DEFAULT_SETTINGS)
    for r in rows:
        result[r["key"]] = r["value"]

    try:
        result["caller_id_pool_parsed"] = json.loads(result.get("caller_id_pool", "[]"))
    except Exception:
        result["caller_id_pool_parsed"] = []

    token = result.get("sonetel_access_token", "")
    result["has_password"] = bool(result.get("sonetel_password"))
    result["has_token"] = bool(token)
    result["is_live_token"] = bool(token and not token.startswith("snt_sim_bearer_"))
    return result


init_db()

app = FastAPI(
    title="Sonetel Power Dialer & Pipeline for macOS",
    description="Local Power Dialer and Kanban CRM with Dual Sonetel Calling Modes (Call Back & Internet VoIP)",
    version="5.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_browser_caching(request: Request, call_next):
    """Ensures the browser never serves stale cached JS/CSS/HTML or API responses."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class SettingsUpdatePayload(BaseModel):
    settings: Dict[str, Any]


class ModeTogglePayload(BaseModel):
    calling_mode: str = Field(..., pattern="^(callback|voip)$")
    voip_method: Optional[str] = None


class LeadCreatePayload(BaseModel):
    name: str
    phone: str
    company: Optional[str] = ""
    role: Optional[str] = ""
    email: Optional[str] = ""
    location: Optional[str] = ""
    stage: Optional[str] = "Queued"
    priority: Optional[str] = "Medium"
    tags: Optional[str] = ""
    notes: Optional[str] = ""
    custom_fields: Optional[Dict[str, Any]] = None


class LeadUpdatePayload(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    company: Optional[str] = None
    role: Optional[str] = None
    email: Optional[str] = None
    location: Optional[str] = None
    stage: Optional[str] = None
    priority: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None
    last_disposition: Optional[str] = None
    custom_fields: Optional[Dict[str, Any]] = None


class StageUpdatePayload(BaseModel):
    stage: str
    sort_order: Optional[int] = None


class NotesUpdatePayload(BaseModel):
    notes: str


class CustomFieldAddPayload(BaseModel):
    field_name: str
    field_value: str


class SonetelAuthPayload(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None


class DialRequestPayload(BaseModel):
    lead_id: int
    calling_mode: Optional[str] = None
    voip_method: Optional[str] = None
    caller_id: Optional[str] = None


class CallCompletePayload(BaseModel):
    lead_id: int
    disposition: str
    duration_seconds: int = 0
    notes: Optional[str] = None
    call_mode: Optional[str] = None
    voip_method: Optional[str] = None
    sonetel_call_id: Optional[str] = ""
    api_payload: Optional[Dict[str, Any]] = None
    api_response: Optional[Dict[str, Any]] = None
    is_simulated: Optional[bool] = True
    advance_to_next: bool = True


class ImportCommitPayload(BaseModel):
    rows: List[Dict[str, Any]]
    mapping: Dict[str, str]
    default_country_code: Optional[str] = "+1"
    target_stage: Optional[str] = "Queued"
    replace_existing: Optional[bool] = False


class PasteImportPayload(BaseModel):
    raw_text: str
    default_country_code: Optional[str] = "+1"


# ---------------------------------------------------------------------------
# Column Auto-Mapping Heuristics
# ---------------------------------------------------------------------------

COLUMN_ALIASES = {
    "name": ["name", "full name", "fullname", "contact", "contact name", "lead", "lead name", "person", "first_name", "prospect", "client", "customer"],
    "phone": ["phone", "phone number", "mobile", "cell", "telephone", "tel", "number", "direct phone", "work phone", "e164", "primary phone", "contact number", "phone no"],
    "company": ["company", "company name", "organization", "org", "account", "business", "employer", "firm", "brand"],
    "role": ["role", "title", "job title", "position", "designation", "department"],
    "email": ["email", "email address", "e-mail", "work email", "mail"],
    "location": ["location", "city", "country", "region", "state", "address", "timezone", "hq"],
    "notes": ["notes", "note", "comments", "comment", "description", "context", "summary", "background", "remarks", "info"],
    "priority": ["priority", "tier", "importance", "score", "rating"],
    "tags": ["tags", "tag", "labels", "segment", "list", "campaign", "category", "industry"],
}


def auto_detect_column_mapping(columns: List[str]) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    normalized_cols = {col: re.sub(r"[^a-z0-9]+", " ", str(col).strip().lower()).strip() for col in columns}
    used_cols = set()

    for field, aliases in COLUMN_ALIASES.items():
        for col, norm in normalized_cols.items():
            if col in used_cols:
                continue
            if norm in aliases:
                mapping[field] = col
                used_cols.add(col)
                break

    for field, aliases in COLUMN_ALIASES.items():
        if field in mapping:
            continue
        for col, norm in normalized_cols.items():
            if col in used_cols:
                continue
            if any(alias in norm for alias in aliases):
                mapping[field] = col
                used_cols.add(col)
                break

    remaining = [c for c in columns if c not in used_cols]
    if "name" not in mapping and remaining:
        mapping["name"] = remaining.pop(0)
    if "phone" not in mapping and remaining:
        mapping["phone"] = remaining.pop(0)

    return mapping


# ---------------------------------------------------------------------------
# Sonetel OAuth2 & Account Discovery Helpers
# ---------------------------------------------------------------------------

def authenticate_with_sonetel(email: str, password: str, oauth_url: str) -> Dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "SonetelPowerDialer-macOS/5.0",
    }
    data = {
        "grant_type": "password",
        "username": email,
        "password": password,
        "refresh": "yes",
    }

    t0 = time.perf_counter()
    try:
        resp = requests.post(
            oauth_url,
            auth=("sonetel-api", "sonetel-api"),
            data=data,
            headers=headers,
            timeout=8,
        )
        latency_ms = round((time.perf_counter() - t0) * 1000)
        if resp.status_code == 200:
            body = resp.json()
            access_token = body.get("access_token", "")
            jwt_claims = decode_jwt_payload_safe(access_token)
            account_id = str(jwt_claims.get("account_id") or body.get("account_id") or "")
            return {
                "authenticated": True,
                "Simulated": False,
                "status_code": 200,
                "latency_ms": latency_ms,
                "access_token": access_token,
                "refresh_token": body.get("refresh_token", ""),
                "account_id": account_id,
                "expires_in": body.get("expires_in", 3600),
                "message": f"Authenticated with live Sonetel OAuth2 ({latency_ms} ms)!",
                "raw": body,
            }
        else:
            return {
                "authenticated": False,
                "Simulated": True,
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "message": f"Sonetel OAuth returned HTTP {resp.status_code}. Active in local dialer bridge mode.",
                "access_token": f"snt_sim_bearer_{uuid.uuid4().hex[:18]}",
            }
    except Exception:
        latency_ms = round((time.perf_counter() - t0) * 1000)
        return {
            "authenticated": False,
            "Simulated": True,
            "latency_ms": latency_ms,
            "message": "Local Sonetel session token generated & active.",
            "access_token": f"snt_sim_bearer_{uuid.uuid4().hex[:18]}",
        }


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/api/bootstrap")
def api_bootstrap():
    with get_db() as conn:
        settings = get_all_settings(conn)
        leads_rows = conn.execute(
            "SELECT * FROM leads ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        leads = [serialize_lead_row(r) for r in leads_rows]

        call_rows = conn.execute(
            "SELECT * FROM call_logs ORDER BY id DESC LIMIT 150"
        ).fetchall()
        calls = [dict(r) for r in call_rows]

        stage_counts = {stage: 0 for stage in PIPELINE_STAGES}
        for lead in leads:
            st = lead.get("stage") or "Queued"
            stage_counts[st] = stage_counts.get(st, 0) + 1

        queued_leads = [l for l in leads if l.get("stage") == "Queued"]

    return {
        "settings": settings,
        "stages": PIPELINE_STAGES,
        "stage_counts": stage_counts,
        "leads": leads,
        "queued_count": len(queued_leads),
        "next_queued_lead": queued_leads[0] if queued_leads else None,
        "calls": calls,
    }


@app.post("/api/settings/mode")
def api_toggle_mode(payload: ModeTogglePayload):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('calling_mode', ?)",
            (payload.calling_mode,),
        )
        if payload.voip_method in ("webrtc", "sip_api"):
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('voip_method', ?)",
                (payload.voip_method,),
            )
        settings = get_all_settings(conn)

    active_mode = settings["calling_mode"]
    voip_method = settings.get("voip_method", "webrtc")
    if active_mode == "callback":
        call1_preview = settings.get("agent_phone", "+14155550199")
        badge = "📞 Carrier Call Back"
        description = "Sonetel rings your physical forwarding phone (call1) first, then bridges to the contact (call2)."
    else:
        call1_preview = settings.get("sip_uri", "sip:alex.mercer@acmecorp.sonetel.com")
        badge = "📡 Internet VoIP"
        description = "Routes voice over the internet via SIP / WebRTC."

    return {
        "status": "ok",
        "calling_mode": active_mode,
        "voip_method": voip_method,
        "badge": badge,
        "call1_preview": call1_preview,
        "description": description,
        "settings": settings,
    }


@app.put("/api/settings")
@app.post("/api/settings")
def api_update_settings(payload: SettingsUpdatePayload):
    with get_db() as conn:
        for k, v in payload.settings.items():
            if k in ("caller_id_pool_parsed", "has_password", "has_token", "is_live_token"):
                continue
            if isinstance(v, (dict, list)):
                v = json.dumps(v)
            elif isinstance(v, bool):
                v = "true" if v else "false"
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (str(k), str(v) if v is not None else ""),
            )
        settings = get_all_settings(conn)
    return {"status": "ok", "settings": settings}


@app.post("/api/sonetel/auth")
def api_sonetel_auth(payload: SonetelAuthPayload):
    with get_db() as conn:
        settings = get_all_settings(conn)
        email = (payload.email or settings.get("sonetel_email") or "").strip()
        password = payload.password if payload.password is not None else settings.get("sonetel_password", "")
        oauth_url = settings.get("sonetel_oauth_url") or "https://api.sonetel.com/SonetelAuth/beta/oauth/token"

        if not email:
            raise HTTPException(status_code=400, detail="Sonetel account email is required.")

        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_email', ?)", (email,))
        if payload.password is not None:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_password', ?)", (password,))

        auth_result = authenticate_with_sonetel(email, password, oauth_url)
        token = auth_result.get("access_token", "")
        account_id = auth_result.get("account_id", "")
        auth_mode = "live" if auth_result.get("authenticated") else "sandbox"
        ts = now_iso()

        if token:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_access_token', ?)", (token,))
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_token_updated_at', ?)", (ts,))
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_auth_mode', ?)", (auth_mode,))
        if account_id:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sonetel_account_id', ?)", (account_id,))

        updated_settings = get_all_settings(conn)

    return {
        "status": "ok",
        "auth_result": auth_result,
        "settings": updated_settings,
    }


@app.post("/api/sonetel/sync-numbers")
def api_sonetel_sync_numbers():
    with get_db() as conn:
        settings = get_all_settings(conn)
        token = settings.get("sonetel_access_token", "")
        account_id = settings.get("sonetel_account_id", "")
        is_live = bool(token and not token.startswith("snt_sim_bearer_"))

        if is_live and account_id:
            try:
                url = f"https://public-api.sonetel.com/account/{account_id}/phonenumbers"
                resp = requests.get(
                    url,
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                    timeout=6,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    raw_list = body.get("response", []) if isinstance(body, dict) else []
                    discovered = []
                    for item in raw_list:
                        num = sanitize_phone(item.get("phnum") or item.get("e164") or "", "+1")
                        if num:
                            country = item.get("country") or "Sonetel"
                            discovered.append({
                                "number": num,
                                "label": f"Sonetel {country} ({num})",
                                "region": country,
                            })
                    if discovered:
                        conn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('caller_id_pool', ?)",
                            (json.dumps(discovered),),
                        )
                        conn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('caller_id', ?)",
                            (discovered[0]["number"],),
                        )
                        updated = get_all_settings(conn)
                        return {
                            "status": "synced_live",
                            "count": len(discovered),
                            "message": f"Synced {len(discovered)} live Sonetel numbers from your account!",
                            "settings": updated,
                        }
            except Exception:
                pass

        return {
            "status": "sandbox_pool",
            "message": "4 global Sonetel Caller IDs ready in selector.",
            "settings": settings,
        }


@app.post("/api/dial")
def api_initiate_dial(payload: DialRequestPayload):
    with get_db() as conn:
        lead_row = conn.execute("SELECT * FROM leads WHERE id = ?", (payload.lead_id,)).fetchone()
        if not lead_row:
            raise HTTPException(status_code=404, detail="Lead not found.")
        lead = serialize_lead_row(lead_row)
        settings = get_all_settings(conn)

        mode = payload.calling_mode or settings.get("calling_mode", "callback")
        voip_method = payload.voip_method or settings.get("voip_method", "webrtc")
        caller_id = payload.caller_id or settings.get("caller_id", "+14158904410")
        default_cc = settings.get("default_country_code", "+1")

        call2_e164 = sanitize_phone(lead["phone"], default_cc)
        if not call2_e164:
            raise HTTPException(status_code=400, detail="Contact has an invalid phone number.")

        if mode == "callback":
            call1_source = sanitize_phone(settings.get("agent_phone", "+14155550199"), default_cc)
            endpoint_url = "https://sonetel.com/make-calls/call/call-back"
            live_api_url = settings.get("sonetel_callback_url") or "https://public-api.sonetel.com/make-calls/call/call-back"
            routing_label = "Carrier Call Back (Leg 1: Agent Phone -> Leg 2: Contact)"
        else:
            raw_sip = (settings.get("sip_uri") or "sip:alex.mercer@acmecorp.sonetel.com").strip()
            call1_source = raw_sip.replace("sip:", "") if voip_method == "sip_api" else raw_sip
            if voip_method == "webrtc":
                endpoint_url = "https://sonetel.com (WebRTC / SIP Over Internet)"
                live_api_url = settings.get("sonetel_callback_url") or "https://public-api.sonetel.com/make-calls/call/call-back"
                routing_label = "Internet VoIP · Option A (Browser WebRTC / SIP Headset -> Contact)"
            else:
                endpoint_url = "https://sonetel.com/make-calls/call/call-back (SIP Leg)"
                live_api_url = settings.get("sonetel_callback_url") or "https://public-api.sonetel.com/make-calls/call/call-back"
                routing_label = "Internet VoIP · Option B (API SIP URI call1 -> Contact call2)"

        sonetel_payload = {
            "app_id": f"sonetel_macos_dialer_{settings.get('sonetel_account_id', 'local')}",
            "call1": call1_source,
            "call2": call2_e164,
            "show_1": caller_id,
            "show_2": caller_id,
        }

        token = settings.get("sonetel_access_token", "").strip()
        has_real_token = bool(token and not token.startswith("snt_sim_bearer_"))
        is_simulated = True
        sonetel_call_id = f"snt-{mode}-{uuid.uuid4().hex[:8]}"
        api_response_data: Dict[str, Any] = {}
        t0 = time.perf_counter()

        if has_real_token and (mode == "callback" or voip_method == "sip_api"):
            try:
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json;charset=UTF-8",
                    "Accept": "application/json",
                }
                resp = requests.post(
                    live_api_url,
                    json=sonetel_payload,
                    headers=headers,
                    timeout=6,
                )
                latency_ms = round((time.perf_counter() - t0) * 1000)
                try:
                    resp_json = resp.json()
                except Exception:
                    resp_json = {"raw_text": resp.text[:300]}

                if resp.status_code in (200, 201, 202):
                    is_simulated = False
                    api_response_data = {
                        "status": "live_connected",
                        "http_status": resp.status_code,
                        "latency_ms": latency_ms,
                        "endpoint": "https://sonetel.com",
                        "sonetel_response": resp_json,
                        "call_id": sonetel_call_id,
                    }
                else:
                    api_response_data = {
                        "status": "local_bridge_active",
                        "http_status": resp.status_code,
                        "latency_ms": latency_ms,
                        "endpoint": "https://sonetel.com",
                        "call_id": sonetel_call_id,
                    }
            except Exception:
                latency_ms = round((time.perf_counter() - t0) * 1000)
                api_response_data = {
                    "status": "local_bridge_active",
                    "latency_ms": latency_ms,
                    "endpoint": "https://sonetel.com",
                    "call_id": sonetel_call_id,
                }
        else:
            latency_ms = 12
            api_response_data = {
                "status": "connected",
                "latency_ms": latency_ms,
                "endpoint": "https://sonetel.com",
                "mode": mode,
                "voip_method": voip_method if mode == "voip" else None,
                "routing_summary": routing_label,
                "call_id": sonetel_call_id,
                "legs": {
                    "leg1_origin": call1_source,
                    "leg2_destination": call2_e164,
                    "outbound_caller_id": caller_id,
                },
                "timestamp": now_iso(),
            }

        ts = now_iso()
        new_stage = "In Progress" if lead["stage"] == "Queued" else lead["stage"]
        conn.execute(
            "UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?",
            (new_stage, ts, payload.lead_id),
        )
        updated_lead = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (payload.lead_id,)).fetchone()
        )

    return {
        "status": "dialing",
        "sonetel_call_id": sonetel_call_id,
        "calling_mode": mode,
        "voip_method": voip_method if mode == "voip" else "",
        "routing_label": routing_label,
        "call1": call1_source,
        "call2": call2_e164,
        "caller_id": caller_id,
        "endpoint": endpoint_url,
        "latency_ms": api_response_data.get("latency_ms", 12),
        "request_payload": sonetel_payload,
        "response_payload": api_response_data,
        "is_simulated": is_simulated,
        "lead": updated_lead,
    }


@app.post("/api/calls/complete")
def api_complete_call(payload: CallCompletePayload):
    with get_db() as conn:
        lead_row = conn.execute("SELECT * FROM leads WHERE id = ?", (payload.lead_id,)).fetchone()
        if not lead_row:
            raise HTTPException(status_code=404, detail="Lead not found.")
        lead = serialize_lead_row(lead_row)
        settings = get_all_settings(conn)

        ts = now_iso()
        disposition = payload.disposition or "Answered"
        target_stage = DISPOSITION_TO_STAGE.get(disposition, "Connected / Answered")
        updated_notes = payload.notes if payload.notes is not None else lead.get("notes", "")
        attempts = int(lead.get("attempts") or 0) + 1

        conn.execute(
            """
            UPDATE leads
            SET stage = ?,
                last_disposition = ?,
                notes = ?,
                attempts = ?,
                last_called_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (target_stage, disposition, updated_notes, attempts, ts, ts, payload.lead_id),
        )

        call_mode = payload.call_mode or settings.get("calling_mode", "callback")
        voip_method = payload.voip_method or (settings.get("voip_method", "webrtc") if call_mode == "voip" else "")
        call1_source = (
            settings.get("agent_phone", "+14155550199")
            if call_mode == "callback"
            else settings.get("sip_uri", "sip:alex.mercer@acmecorp.sonetel.com")
        )
        caller_id = settings.get("caller_id", "+14158904410")

        conn.execute(
            """
            INSERT INTO call_logs (
                lead_id, lead_name, lead_company, lead_phone, call_mode, voip_method,
                call1_source, call2_destination, caller_id, duration_seconds,
                disposition, notes_snapshot, sonetel_call_id, api_endpoint,
                api_payload, api_response, is_simulated, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lead["id"],
                lead["name"],
                lead.get("company", ""),
                lead["phone"],
                call_mode,
                voip_method,
                call1_source,
                lead["phone"],
                caller_id,
                max(0, int(payload.duration_seconds or 0)),
                disposition,
                updated_notes,
                payload.sonetel_call_id or f"snt-{call_mode}-{uuid.uuid4().hex[:8]}",
                "https://sonetel.com",
                json.dumps(payload.api_payload or {}),
                json.dumps(payload.api_response or {}),
                1 if payload.is_simulated else 0,
                ts,
            ),
        )

        updated_lead = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (payload.lead_id,)).fetchone()
        )

        next_lead = None
        if payload.advance_to_next:
            # Find next Queued lead after current sort_order, or wrap around to first Queued lead
            next_row = conn.execute(
                """
                SELECT * FROM leads
                WHERE stage = 'Queued' AND id != ? AND sort_order >= ?
                ORDER BY sort_order ASC, id ASC LIMIT 1
                """,
                (payload.lead_id, lead.get("sort_order", 0)),
            ).fetchone()
            if not next_row:
                next_row = conn.execute(
                    "SELECT * FROM leads WHERE stage = 'Queued' AND id != ? ORDER BY sort_order ASC, id ASC LIMIT 1",
                    (payload.lead_id,),
                ).fetchone()
            if next_row:
                next_lead = serialize_lead_row(next_row)

        recent_calls = [
            dict(r) for r in conn.execute("SELECT * FROM call_logs ORDER BY id DESC LIMIT 150").fetchall()
        ]

    return {
        "status": "completed",
        "updated_lead": updated_lead,
        "next_lead": next_lead,
        "calls": recent_calls,
    }


# ---------------------------------------------------------------------------
# Leads CRUD & Custom Fields Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/leads")
def api_list_leads(stage: Optional[str] = None, search: Optional[str] = None):
    with get_db() as conn:
        query = "SELECT * FROM leads WHERE 1=1"
        params: List[Any] = []
        if stage:
            query += " AND stage = ?"
            params.append(stage)
        if search:
            q = f"%{search.strip()}%"
            query += " AND (name LIKE ? OR company LIKE ? OR phone LIKE ? OR notes LIKE ? OR tags LIKE ?)"
            params.extend([q, q, q, q, q])
        query += " ORDER BY sort_order ASC, id ASC"
        rows = conn.execute(query, params).fetchall()
    return {"leads": [serialize_lead_row(r) for r in rows]}


@app.post("/api/leads")
def api_create_lead(payload: LeadCreatePayload):
    with get_db() as conn:
        settings = get_all_settings(conn)
        default_cc = settings.get("default_country_code", "+1")
        clean_phone = sanitize_phone(payload.phone, default_cc)
        if not clean_phone:
            raise HTTPException(status_code=400, detail="Valid phone number is required.")

        geo = infer_geo_metadata(clean_phone, payload.location or "")
        stage = payload.stage if payload.stage in PIPELINE_STAGES else "Queued"
        ts = now_iso()

        max_order_row = conn.execute("SELECT COALESCE(MAX(sort_order), 0) as m FROM leads").fetchone()
        next_order = int(max_order_row["m"]) + 1

        cur = conn.execute(
            """
            INSERT INTO leads (
                name, phone, raw_phone, company, role, email, location,
                timezone_offset, stage, last_disposition, notes, attempts,
                last_called_at, priority, tags, custom_fields, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, '', ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.name.strip() or "Unnamed Contact",
                clean_phone,
                payload.phone.strip(),
                (payload.company or "").strip(),
                (payload.role or "").strip(),
                (payload.email or "").strip(),
                geo["location"],
                geo["timezone_offset"],
                stage,
                payload.notes or "",
                payload.priority or "Medium",
                (payload.tags or "").strip(),
                json.dumps(payload.custom_fields or {}),
                next_order,
                ts,
                ts,
            ),
        )
        lead = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (cur.lastrowid,)).fetchone()
        )
    return {"status": "created", "lead": lead}


@app.put("/api/leads/{lead_id}")
@app.patch("/api/leads/{lead_id}")
def api_update_lead(lead_id: int, payload: LeadUpdatePayload):
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead not found.")
        lead = serialize_lead_row(existing)
        settings = get_all_settings(conn)
        default_cc = settings.get("default_country_code", "+1")

        name = payload.name.strip() if payload.name is not None else lead["name"]
        raw_phone = payload.phone.strip() if payload.phone is not None else lead["raw_phone"]
        clean_phone = sanitize_phone(payload.phone, default_cc) if payload.phone is not None else lead["phone"]
        company = payload.company.strip() if payload.company is not None else lead["company"]
        role = payload.role.strip() if payload.role is not None else lead["role"]
        email = payload.email.strip() if payload.email is not None else lead["email"]
        location_in = payload.location.strip() if payload.location is not None else lead["location"]
        geo = infer_geo_metadata(clean_phone, location_in)
        stage = payload.stage if (payload.stage in PIPELINE_STAGES) else lead["stage"]
        priority = payload.priority if payload.priority is not None else lead["priority"]
        tags = payload.tags if payload.tags is not None else lead["tags"]
        notes = payload.notes if payload.notes is not None else lead["notes"]
        last_disp = payload.last_disposition if payload.last_disposition is not None else lead["last_disposition"]
        cf_json = (
            json.dumps(payload.custom_fields)
            if payload.custom_fields is not None
            else lead.get("custom_fields", "{}")
        )

        ts = now_iso()
        conn.execute(
            """
            UPDATE leads
            SET name = ?, phone = ?, raw_phone = ?, company = ?, role = ?, email = ?,
                location = ?, timezone_offset = ?, stage = ?, priority = ?, tags = ?,
                notes = ?, last_disposition = ?, custom_fields = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                clean_phone,
                raw_phone,
                company,
                role,
                email,
                geo["location"],
                geo["timezone_offset"],
                stage,
                priority,
                tags,
                notes,
                last_disp,
                cf_json,
                ts,
                lead_id,
            ),
        )
        updated = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        )
    return {"status": "updated", "lead": updated}


@app.patch("/api/leads/{lead_id}/fields")
def api_add_custom_field(lead_id: int, payload: CustomFieldAddPayload):
    """Adds or updates a custom key-value field on a contact's record right from the dialer."""
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead not found.")
        lead = serialize_lead_row(existing)
        cf = dict(lead.get("custom_fields_parsed") or {})
        key = payload.field_name.strip()
        val = payload.field_value.strip()
        if key:
            if val:
                cf[key] = val
            else:
                cf.pop(key, None)
        ts = now_iso()
        conn.execute(
            "UPDATE leads SET custom_fields = ?, updated_at = ? WHERE id = ?",
            (json.dumps(cf), ts, lead_id),
        )
        updated = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        )
    return {"status": "ok", "lead": updated}


@app.patch("/api/leads/{lead_id}/stage")
def api_update_lead_stage(lead_id: int, payload: StageUpdatePayload):
    if payload.stage not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage. Must be one of {PIPELINE_STAGES}")
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead not found.")
        ts = now_iso()
        if payload.sort_order is not None:
            conn.execute(
                "UPDATE leads SET stage = ?, sort_order = ?, updated_at = ? WHERE id = ?",
                (payload.stage, payload.sort_order, ts, lead_id),
            )
        else:
            conn.execute(
                "UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?",
                (payload.stage, ts, lead_id),
            )
        updated = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        )
    return {"status": "ok", "lead": updated}


@app.patch("/api/leads/{lead_id}/notes")
def api_autosave_lead_notes(lead_id: int, payload: NotesUpdatePayload):
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Lead not found.")
        ts = now_iso()
        conn.execute(
            "UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?",
            (payload.notes, ts, lead_id),
        )
        updated = serialize_lead_row(
            conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        )
    return {"status": "saved", "saved_at": ts, "lead": updated}


@app.delete("/api/leads/{lead_id}")
def api_delete_lead(lead_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
    return {"status": "deleted", "id": lead_id}


# ---------------------------------------------------------------------------
# CSV / Excel / Paste Pipeline Importer
# ---------------------------------------------------------------------------

def parse_dataframe_to_preview(df: pd.DataFrame, filename: str, default_country_code: str) -> Dict[str, Any]:
    df = df.fillna("")
    columns = [str(c) for c in df.columns.tolist()]
    if not columns:
        raise HTTPException(status_code=400, detail="No columns found in the data.")

    mapping = auto_detect_column_mapping(columns)
    raw_rows: List[Dict[str, Any]] = []
    for _, row in df.head(1000).iterrows():
        row_dict = {str(col): str(row[col]).strip() for col in columns}
        raw_rows.append(row_dict)

    phone_col = mapping.get("phone", "")
    name_col = mapping.get("name", "")
    company_col = mapping.get("company", "")
    notes_col = mapping.get("notes", "")

    preview_samples = []
    for r in raw_rows[:15]:
        raw_p = r.get(phone_col, "") if phone_col else ""
        clean_p = sanitize_phone(raw_p, default_country_code)
        preview_samples.append({
            "name": r.get(name_col, "") if name_col else "",
            "raw_phone": raw_p,
            "sanitized_phone": clean_p,
            "company": r.get(company_col, "") if company_col else "",
            "notes": r.get(notes_col, "") if notes_col else "",
            "valid": bool(clean_p),
        })

    return {
        "filename": filename,
        "total_rows": len(raw_rows),
        "columns": columns,
        "auto_mapping": mapping,
        "preview_samples": preview_samples,
        "rows": raw_rows,
    }


@app.post("/api/import/preview")
async def api_import_preview(
    file: UploadFile = File(...),
    default_country_code: str = Form("+1"),
):
    filename = (file.filename or "upload.csv").lower()
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        if filename.endswith(".xlsx") or filename.endswith(".xls"):
            df = pd.read_excel(io.BytesIO(content))
        else:
            try:
                df = pd.read_csv(io.BytesIO(content))
            except UnicodeDecodeError:
                df = pd.read_csv(io.BytesIO(content), encoding="latin-1")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(exc)}")

    return parse_dataframe_to_preview(df, file.filename or "upload.csv", default_country_code)


@app.post("/api/import/paste")
def api_import_paste(payload: PasteImportPayload):
    """Parses pasted CSV or tab-separated spreadsheet rows from Excel / Google Sheets / Numbers."""
    raw = (payload.raw_text or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Pasted text is empty.")

    try:
        sep = "\t" if "\t" in raw.splitlines()[0] else ","
        df = pd.read_csv(io.StringIO(raw), sep=sep)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse pasted rows: {str(exc)}")

    return parse_dataframe_to_preview(df, "Pasted Spreadsheet List", payload.default_country_code or "+1")


@app.post("/api/import/commit")
def api_import_commit(payload: ImportCommitPayload):
    mapping = payload.mapping or {}
    name_col = mapping.get("name", "")
    phone_col = mapping.get("phone", "")
    company_col = mapping.get("company", "")
    role_col = mapping.get("role", "")
    email_col = mapping.get("email", "")
    location_col = mapping.get("location", "")
    notes_col = mapping.get("notes", "")
    tags_col = mapping.get("tags", "")
    priority_col = mapping.get("priority", "")

    if not phone_col:
        raise HTTPException(status_code=400, detail="Please select which column contains the Phone Number.")

    default_cc = payload.default_country_code or "+1"
    target_stage = payload.target_stage if payload.target_stage in PIPELINE_STAGES else "Queued"

    imported_count = 0
    skipped_count = 0
    sanitized_count = 0
    first_imported_id: Optional[int] = None
    ts = now_iso()

    with get_db() as conn:
        if payload.replace_existing:
            conn.execute("DELETE FROM leads;")

        max_order_row = conn.execute("SELECT COALESCE(MAX(sort_order), 0) as m FROM leads").fetchone()
        next_order = int(max_order_row["m"]) + 1

        for row in payload.rows:
            raw_phone = str(row.get(phone_col, "")).strip()
            clean_phone = sanitize_phone(raw_phone, default_cc)
            if not clean_phone or len(clean_phone) < 7:
                skipped_count += 1
                continue

            if raw_phone != clean_phone:
                sanitized_count += 1

            name_val = str(row.get(name_col, "")).strip() if name_col else ""
            if not name_val:
                name_val = f"Contact {clean_phone[-4:]}"

            company_val = str(row.get(company_col, "")).strip() if company_col else ""
            role_val = str(row.get(role_col, "")).strip() if role_col else ""
            email_val = str(row.get(email_col, "")).strip() if email_col else ""
            loc_val = str(row.get(location_col, "")).strip() if location_col else ""
            notes_val = str(row.get(notes_col, "")).strip() if notes_col else ""
            tags_val = str(row.get(tags_col, "")).strip() if tags_col else "Uploaded List"
            prio_val = str(row.get(priority_col, "")).strip().capitalize() if priority_col else "High"
            if prio_val not in ("High", "Medium", "Low"):
                prio_val = "High"

            all_row_fields: Dict[str, str] = {}
            for col_key, col_val in row.items():
                val_str = str(col_val).strip()
                if val_str and val_str.lower() not in ("nan", "none", "null"):
                    all_row_fields[str(col_key)] = val_str

            geo = infer_geo_metadata(clean_phone, loc_val)

            cur = conn.execute(
                """
                INSERT INTO leads (
                    name, phone, raw_phone, company, role, email, location,
                    timezone_offset, stage, last_disposition, notes, attempts,
                    last_called_at, priority, tags, custom_fields, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, '', ?, ?, ?, ?, ?, ?)
                """,
                (
                    name_val,
                    clean_phone,
                    raw_phone,
                    company_val,
                    role_val,
                    email_val,
                    geo["location"],
                    geo["timezone_offset"],
                    target_stage,
                    notes_val,
                    prio_val,
                    tags_val,
                    json.dumps(all_row_fields),
                    next_order,
                    ts,
                    ts,
                ),
            )
            if first_imported_id is None:
                first_imported_id = cur.lastrowid
            next_order += 1
            imported_count += 1

    return {
        "status": "imported",
        "imported_count": imported_count,
        "sanitized_count": sanitized_count,
        "skipped_count": skipped_count,
        "first_imported_lead_id": first_imported_id,
    }


# ---------------------------------------------------------------------------
# Call History, Exports & Demo Reset
# ---------------------------------------------------------------------------

@app.get("/api/calls")
def api_get_calls(mode: Optional[str] = None, disposition: Optional[str] = None):
    with get_db() as conn:
        query = "SELECT * FROM call_logs WHERE 1=1"
        params: List[Any] = []
        if mode in ("callback", "voip"):
            query += " AND call_mode = ?"
            params.append(mode)
        if disposition:
            query += " AND disposition = ?"
            params.append(disposition)
        query += " ORDER BY id DESC LIMIT 250"
        rows = conn.execute(query, params).fetchall()
    return {"calls": [dict(r) for r in rows]}


@app.get("/api/export/leads.csv")
def api_export_leads_csv():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM leads ORDER BY sort_order ASC, id ASC").fetchall()
        leads = [dict(r) for r in rows]

    output = io.StringIO()
    fieldnames = [
        "id", "name", "phone", "raw_phone", "company", "role", "email",
        "location", "stage", "last_disposition", "attempts", "priority",
        "tags", "notes", "custom_fields", "last_called_at", "created_at",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for lead in leads:
        writer.writerow(lead)

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sonetel_pipeline_leads.csv"},
    )


@app.get("/api/export/calls.csv")
def api_export_calls_csv():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM call_logs ORDER BY id DESC").fetchall()
        calls = [dict(r) for r in rows]

    output = io.StringIO()
    fieldnames = [
        "id", "created_at", "lead_name", "lead_company", "lead_phone",
        "call_mode", "voip_method", "call1_source", "call2_destination",
        "caller_id", "duration_seconds", "disposition", "sonetel_call_id",
        "notes_snapshot",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for call in calls:
        writer.writerow(call)

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sonetel_call_history.csv"},
    )


@app.get("/api/sample-csv")
def api_download_sample_csv():
    sample_path = BASE_DIR / "sample_leads.csv"
    if sample_path.exists():
        return FileResponse(
            str(sample_path),
            media_type="text/csv",
            filename="sample_leads.csv",
        )
    raise HTTPException(status_code=404, detail="Sample CSV not found")


@app.post("/api/demo/reset")
def api_reset_demo_data():
    with get_db() as conn:
        seed_initial_data(conn, force=True)
    return {"status": "reset"}


STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def serve_spa_index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.exists():
        return JSONResponse({"message": "Frontend initializing..."})
    html_text = index_file.read_text(encoding="utf-8")
    # Inject dynamic cache-buster on every page load so browser never uses old cached JS/CSS
    bust = str(int(time.time() * 1000))
    html_text = html_text.replace("/static/styles.css", f"/static/styles.css?v={bust}")
    html_text = html_text.replace("/static/app.js", f"/static/app.js?v={bust}")
    return HTMLResponse(
        content=html_text,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
