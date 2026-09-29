# Sonetel Power Dialer & Pipeline for macOS (v5.0)

A local, privacy-first **Power Dialer and Kanban CRM** built with **FastAPI**, **SQLite (`pipeline.db`)**, and a **macOS-native Dark/Light Single-Page Application** (HTML5 + Tailwind CSS + Vanilla JS). Integrates directly with **Sonetel (`https://sonetel.com`)** and features a prominent **Single Slider Toggle** to switch between **Carrier Call Back** and **Internet (VoIP)** calling modes in real time.

---

## Key Features

1. **Dual Calling Method — Single Slider Toggle**:
   - **📞 Call Back Mode**: Issues a `POST` request to Sonetel with `call1` set to your registered physical forwarding number (e.g., mobile phone) and `call2` set to the contact's E.164 number. Sonetel rings your phone first and bridges to the prospect upon answer.
   - **📡 Internet (VoIP) Mode**: Routes voice data over the internet via **Option A (Browser WebRTC / SIP Headset)** or **Option B (API SIP Leg where `call1` is your Sonetel SIP URI)**.
   - Dynamic header badges (`📞 Carrier Call Back` vs `📡 Internet VoIP`) and a collapsible **Sonetel API Request Inspector**.

2. **Practical 3-Column Active Dialer Workspace**:
   - **Left Column (`Calling List`)**: Displays your uploaded contacts in a fixed `#1, #2, #3...` sequence with `All` / `To Call` / `Called` filters and instant search so contacts never jump or disappear mid-call.
   - **Center Column (`Complete Contact Dossier & Auto-Saving Notes`)**: Hard-locks the active contact on screen (`🔒 Info Locked on Screen`), displays **100% of uploaded spreadsheet columns** (`Phone (E.164)`, `Raw Phone`, `Company`, `Role`, `Email`, `Location`, `Deal Value`, `Industry`, `Company Size`, `Current System`, `Decision Timeline`, etc.), allows inline custom field addition (`+ Save Info`), and auto-saves Call Notes to `pipeline.db`.
   - **Right Column (`macOS Phone Handset & Outcome Logger`)**: Features a soft crystal **"Ting" chime** (`🔔 Ting Sound: ON/OFF` — no repeating ringback loop), live call timer, touch-tone DTMF keypad, audio memo recorder, native macOS `tel:` handoff, and one-click outcome logging (`Answered`, `No Answer`, `Busy`, `Wrong Number`) with `Save Outcome & Load Next Person →`.

3. **Smart CSV / Excel & Copy-Paste Pipeline Importer**:
   - Drag-and-drop `.csv`, `.xlsx`, or `.xls` files, **paste rows directly from Excel / Google Sheets**, or click **"Load Sample Calling List"**.
   - Preserves **every column** from your spreadsheet and automatically sanitizes phone numbers into strict E.164 format.

4. **5-Stage Kanban Pipeline Board & Call History Exports**:
   - Drag-and-drop contacts across `"Queued"`, `"In Progress"`, `"Connected / Answered"`, `"No Answer / Voicemail"`, and `"Follow Up / Closed"`, and export full CSV reports at any time.

---

## Step-by-Step macOS Terminal Setup & Launch Commands

Open **Terminal.app** (or iTerm2) on your Mac and run:

```bash
# 1. Navigate into the project directory
cd crm

# 2. Create an isolated Python 3 virtual environment
python3 -m venv .venv

# 3. Activate the virtual environment
source .venv/bin/activate

# 4. Upgrade pip and install required packages
pip install --upgrade pip
pip install -r requirements.txt

# 5. Start the local FastAPI server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Then open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** in Safari, Arc, or Chrome (or simply run `./start_mac.sh`).
