import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
//  DATABRICKS CONNECTION CONFIG
//  Values read from frontend/.env — requires VITE_ prefix
// ============================================================
const DATABRICKS_CONFIG = {
  host:        import.meta.env.VITE_DATABRICKS_HOST        ?? "",
  warehouseId: import.meta.env.VITE_DATABRICKS_WAREHOUSE_ID ?? "",
  token:       import.meta.env.VITE_DATABRICKS_TOKEN        ?? "",
  catalog:     "workspace",
  schema:      "default",
  table:       "311_live_tickets",
};

// ============================================================
//  DATABRICKS FETCH
//  Returns rows keyed by exact column names from the schema.
// ============================================================
async function fetchTickets(limit = 50) {
  const sql = `
    SELECT
      ticket_id, created_at, transcription, primary_category,
      secondary_category, priority, department_primary,
      department_secondary, reasoning, suggested_response, status
    FROM ${DATABRICKS_CONFIG.catalog}.${DATABRICKS_CONFIG.schema}.${DATABRICKS_CONFIG.table}
    WHERE status != 'Closed'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  // Requests go through the Vite dev proxy (/api/databricks → Databricks host)
  // to avoid CORS blocks on direct browser-to-Databricks calls.
  const submitRes = await fetch(`/api/databricks/api/2.0/sql/statements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DATABRICKS_CONFIG.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: DATABRICKS_CONFIG.warehouseId, statement: sql, wait_timeout: "10s" }),
  });
  let result = await submitRes.json();
  while (result.status?.state === "RUNNING" || result.status?.state === "PENDING") {
    await new Promise(r => setTimeout(r, 800));
    const poll = await fetch(`/api/databricks/api/2.0/sql/statements/${result.statement_id}`,
      { headers: { Authorization: `Bearer ${DATABRICKS_CONFIG.token}` } });
    result = await poll.json();
  }
  const cols = result.manifest?.schema?.columns?.map(c => c.name) ?? [];
  return (result.result?.data_array ?? []).map(row => Object.fromEntries(cols.map((col, i) => [col, row[i]])));
}

// ============================================================
//  CONSTANTS
// ============================================================
const FIELD_LABELS = {
  ticket_id:            "Ticket ID",
  created_at:           "Created At",
  status:               "Status",
  primary_category:     "Primary Category",
  secondary_category:   "Secondary Category",
  priority:             "Priority",
  department_primary:   "Primary Dept",
  department_secondary: "Secondary Dept",
  transcription:        "Transcription",
  reasoning:            "Reasoning",
  suggested_response:   "Suggested Response",
};

const PRIORITY_COLOR = { HIGH: "#ff3b3b", MEDIUM: "#ffaa00", MED: "#ffaa00", LOW: "#00c896" };

const AUTO_REFRESH_MS = 30_000;

// Hardcoded anchor: CITYSCAPE Community Centrepoint, Calgary
const BASE_COORD = { lat: 51.14703155697, lng: -113.96125803148 };

// Spread tickets randomly within ~1.5 km of the anchor so the map feels alive
function randomNearbyCoord() {
  const angle = Math.random() * 2 * Math.PI;
  const r     = Math.random() * 0.014; // ~0-1.5 km in degrees
  return { lat: BASE_COORD.lat + r * Math.cos(angle), lng: BASE_COORD.lng + r * Math.sin(angle) };
}

// ============================================================
//  LEAFLET MAP COMPONENT — loads Leaflet from CDN
// ============================================================
function LeafletMap({ lat, lng, label }) {
  const mapRef     = useRef(null);
  const leafletRef = useRef(null);
  const markerRef  = useRef(null);
  const mapId      = useRef(`map-${Math.random().toString(36).slice(2)}`);

  const placeMarker = (L, map, latVal, lngVal, labelVal) => {
    if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
    const icon = L.divIcon({
      html: `<div style="width:13px;height:13px;background:#ff3b3b;border:2px solid #fff;border-radius:50%;box-shadow:0 0 10px #ff3b3b99;"></div>`,
      iconSize: [13, 13], iconAnchor: [6, 6], className: "",
    });
    markerRef.current = L.marker([latVal, lngVal], { icon })
      .addTo(map)
      .bindPopup(`<b style="font-size:11px">${labelVal || "Incident"}</b>`, { maxWidth: 180 })
      .openPopup();
  };

  useEffect(() => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id   = "leaflet-css";
      link.rel  = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    const initMap = () => {
      if (leafletRef.current) return;
      const L = window.L;
      if (!L) return;
      const map = L.map(mapId.current, { zoomControl: true, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      leafletRef.current = map;
      if (lat && lng) {
        map.setView([lat, lng], 15);
        placeMarker(L, map, lat, lng, label);
      } else {
        map.setView([BASE_COORD.lat, BASE_COORD.lng], 13);
      }
    };

    if (window.L) {
      initMap();
    } else {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      script.onload = initMap;
      document.head.appendChild(script);
    }

    return () => {
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; markerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly to new location whenever the selected ticket changes
  useEffect(() => {
    const L = window.L;
    if (!L || !leafletRef.current) return;
    if (lat && lng) {
      leafletRef.current.flyTo([lat, lng], 15, { animate: true, duration: 0.8 });
      placeMarker(L, leafletRef.current, lat, lng, label);
    } else {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
      leafletRef.current.flyTo([BASE_COORD.lat, BASE_COORD.lng], 13, { animate: true, duration: 0.8 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  return (
    <div id={mapId.current} ref={mapRef} style={{ width: "100%", height: "100%", background: "#0d1018" }} />
  );
}

// ============================================================
//  MAIN COMPONENT
// ============================================================
export default function App() {
  const [clock, setClock]                   = useState(new Date());
  const [queue, setQueue]                   = useState([]);
  const [queueLoading, setQueueLoading]     = useState(true);
  const [queueError, setQueueError]         = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [refreshing, setRefreshing]         = useState(false);
  const [lastRefreshed, setLastRefreshed]   = useState(null);
  // Stable coordinate per ticket_id — generated once and reused across refreshes
  const ticketCoordsRef = useRef(new Map());

  const getCoord = useCallback((ticket_id) => {
    if (!ticketCoordsRef.current.has(ticket_id)) {
      ticketCoordsRef.current.set(ticket_id, randomNearbyCoord());
    }
    return ticketCoordsRef.current.get(ticket_id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadTickets = useCallback(async (silent = false) => {
    if (!silent) setQueueLoading(true);
    else setRefreshing(true);
    try {
      const rows = await fetchTickets(50);
      setQueue(rows);
      setQueueError(null);
      setLastRefreshed(new Date());
      // Keep selected ticket data fresh if it still exists in the new results
      setSelectedTicket(prev =>
        prev ? (rows.find(r => r.ticket_id === prev.ticket_id) ?? prev) : null
      );
    } catch (err) {
      setQueueError(err.message);
    } finally {
      setQueueLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadTickets(false); }, [loadTickets]);

  // Auto-refresh every 30 seconds silently (no loading spinner, just background update)
  useEffect(() => {
    const id = setInterval(() => loadTickets(true), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadTickets]);

  const completeQueueItem = (id) => {
    setQueue(q => q.filter(t => t.ticket_id !== id));
    if (selectedTicket?.ticket_id === id) setSelectedTicket(null);
  };

  const secondsSinceRefresh = lastRefreshed
    ? Math.floor((clock - lastRefreshed) / 1000)
    : null;

  return (
    <div style={{ fontFamily: "'DM Mono','Courier New',monospace", background: "#0a0c0f", color: "#c8d0d8", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Barlow:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#0f1215}
        ::-webkit-scrollbar-thumb{background:#2a3040;border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes rowSelect{from{background:#0f1a2a}to{background:#0d1520}}
        .live-dot{width:7px;height:7px;background:#ff3b3b;border-radius:50%;animation:pulse 1s ease-in-out infinite;display:inline-block}
        .qrow{transition:background .12s;cursor:pointer}
        .qrow:hover{background:#0f1520 !important}
        .qrow-selected{background:#0d1a2a !important;border-left:2px solid #1a6fff !important}
        .btn-complete{background:#00c896;color:#001a12;border:none;padding:10px 28px;font-family:'Barlow',sans-serif;font-weight:800;font-size:12px;letter-spacing:.08em;cursor:pointer;border-radius:3px;transition:all .2s;text-transform:uppercase}
        .btn-complete:hover{background:#00e6ad;transform:translateY(-1px);box-shadow:0 6px 18px #00c89644}
        .btn-edit{background:transparent;color:#6a7a8a;border:1px solid #2a3240;padding:10px 18px;font-family:'Barlow',sans-serif;font-weight:600;font-size:11px;letter-spacing:.08em;cursor:pointer;border-radius:3px;transition:all .15s;text-transform:uppercase}
        .btn-edit:hover{border-color:#4a5870;color:#9aaabb}
        .ticket-enter{animation:fadeUp .35s ease forwards}
        .leaflet-popup-content-wrapper{background:#0d1520 !important;border:1px solid #2a3a50 !important;border-radius:4px !important;box-shadow:0 4px 16px #00000088 !important}
        .leaflet-popup-content{color:#a0b8cc !important;margin:8px 10px !important}
        .leaflet-popup-tip{background:#0d1520 !important}
        .leaflet-popup-close-button{color:#4a6a8a !important}
        .leaflet-tile{filter:brightness(.7) saturate(.4) hue-rotate(180deg)}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background: "#0d1018", borderBottom: "1px solid #1c2230", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 30, height: 30, background: "#1a6fff11", border: "1px solid #1a6fff44", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>📡</div>
            <div>
              <div style={{ fontFamily: "'Barlow',sans-serif", fontWeight: 800, fontSize: 14, color: "#e8f0f8", letterSpacing: ".05em" }}>CALGARY 311</div>
              <div style={{ fontSize: 8, color: "#2a3a50", letterSpacing: ".12em" }}>AI DISPATCH AGENT · DATABRICKS</div>
            </div>
          </div>
          <div style={{ width: 1, height: 26, background: "#1c2230" }} />
          {[{ l: "ACTIVE TICKETS", v: queue.length }, { l: "TABLE", v: DATABRICKS_CONFIG.table }].map(s => (
            <div key={s.l}>
              <div style={{ fontSize: 8, color: "#2a3a50", letterSpacing: ".1em" }}>{s.l}</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#7ab0e0" }}>{s.v}</div>
            </div>
          ))}
          <div style={{ width: 1, height: 26, background: "#1c2230" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px", background: "#0d1520", border: "1px solid #1a3050", borderRadius: 3 }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#1a6fff", boxShadow: "0 0 5px #1a6fff" }} />
            <span style={{ fontSize: 8, color: "#2a5070", letterSpacing: ".09em" }}>{DATABRICKS_CONFIG.catalog}.{DATABRICKS_CONFIG.schema}.{DATABRICKS_CONFIG.table}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {refreshing && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "#3a6a9a", letterSpacing: ".1em" }}>
              <div style={{ width: 7, height: 7, border: "1.5px solid #1a6fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
              REFRESHING
            </div>
          )}
          <div style={{ fontSize: 9, color: "#2a3a50" }}>{clock.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
        </div>
      </div>

      {/* ── 3-COLUMN LAYOUT ── */}
      <div style={{ display: "grid", gridTemplateColumns: "268px 1fr 1fr", flex: 1, overflow: "hidden", minHeight: 0 }}>

        {/* LEFT — QUEUE */}
        <div style={{ borderRight: "1px solid #1c2230", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "11px 14px 8px", borderBottom: "1px solid #1c2230", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: "#3a5070", letterSpacing: ".12em" }}>ACTIVE TICKETS</span>
            <span style={{ fontSize: 8, color: "#1a3050", letterSpacing: ".08em" }}>OPEN ONLY</span>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {queue.map(t => (
              <div
                key={t.ticket_id}
                className={`qrow${selectedTicket?.ticket_id === t.ticket_id ? " qrow-selected" : ""}`}
                onClick={() => setSelectedTicket(t)}
                style={{ padding: "9px 14px", borderBottom: "1px solid #0f1520", position: "relative" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: "#3a5070" }}>{t.ticket_id}</span>
                  <span style={{ fontSize: 8, color: "#252f40" }}>
                    {t.created_at ? new Date(t.created_at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#7a8a9a", marginBottom: 2 }}>{t.primary_category}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 9, color: "#252f40" }}>{t.department_primary}</span>
                  <span style={{ fontSize: 8, color: PRIORITY_COLOR[t.priority] || "#6a8aaa", letterSpacing: ".08em" }}>{t.priority}</span>
                </div>
              </div>
            ))}
            {queueLoading && <div style={{ padding: "20px 14px", fontSize: 10, color: "#2a4a6a", fontStyle: "italic" }}>Loading from Databricks…</div>}
            {queueError   && <div style={{ padding: "20px 14px", fontSize: 10, color: "#ff4040", fontStyle: "italic" }}>Error: {queueError}</div>}
            {!queueLoading && !queueError && queue.length === 0 && (
              <div style={{ padding: "20px 14px", fontSize: 10, color: "#1a2535", fontStyle: "italic" }}>No active tickets</div>
            )}
          </div>

          {/* Footer info */}
          <div style={{ padding: "12px", borderTop: "1px solid #1c2230", flexShrink: 0 }}>
            <div style={{ padding: "8px 10px", background: "#0d1018", border: "1px solid #111820", borderRadius: 3 }}>
              <div style={{ fontSize: 8, color: "#1a3050", letterSpacing: ".1em", marginBottom: 4 }}>DATABRICKS</div>
              <div style={{ fontSize: 8, lineHeight: 1.7, color: "#243040" }}>
                <div>catalog  <span style={{ color: "#2a5070" }}>{DATABRICKS_CONFIG.catalog}</span></div>
                <div>schema   <span style={{ color: "#2a5070" }}>{DATABRICKS_CONFIG.schema}</span></div>
                <div>table    <span style={{ color: "#2a5070" }}>{DATABRICKS_CONFIG.table}</span></div>
                <div>refresh  <span style={{ color: "#2a5070" }}>every 30s</span></div>
              </div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ padding: "2px 7px", background: "#0a1020", border: "1px solid #1a2a3a", borderRadius: 2, display: "inline-block" }}>
                  <span style={{ fontSize: 7, letterSpacing: ".08em", color: queueLoading ? "#2a5a8a" : queueError ? "#ff4040" : "#00c89688" }}>
                    {queueLoading ? "● CONNECTING…" : queueError ? "● ERROR" : `● LIVE · ${queue.length} ROWS`}
                  </span>
                </div>
                {secondsSinceRefresh !== null && !queueLoading && (
                  <span style={{ fontSize: 7, color: "#1a2535", letterSpacing: ".06em" }}>
                    {secondsSinceRefresh}s ago
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* CENTER — TICKET DETAILS */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid #1c2230" }}>
          {selectedTicket ? (
            <div className="ticket-enter" style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Ticket header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontFamily: "'Barlow',sans-serif", fontSize: 11, fontWeight: 700, color: "#dce8f4", letterSpacing: ".06em" }}>TICKET DETAILS</span>
                  <div style={{ padding: "2px 8px", background: `${PRIORITY_COLOR[selectedTicket.priority] || "#6a8aaa"}22`, border: `1px solid ${PRIORITY_COLOR[selectedTicket.priority] || "#6a8aaa"}55`, borderRadius: 2, fontSize: 8, color: PRIORITY_COLOR[selectedTicket.priority] || "#6a8aaa", letterSpacing: ".1em" }}>
                    {selectedTicket.priority || "—"}
                  </div>
                  <div style={{ padding: "2px 8px", background: "#1a6fff11", border: "1px solid #1a6fff33", borderRadius: 2, fontSize: 8, color: "#5a9aff", letterSpacing: ".08em" }}>
                    {selectedTicket.status || "OPEN"}
                  </div>
                </div>
                <span style={{ fontSize: 8, color: "#1a3050", fontFamily: "'DM Mono',monospace" }}>{selectedTicket.ticket_id}</span>
              </div>

              {/* Core fields grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, flexShrink: 0 }}>
                {[
                  { col: "primary_category",     hl: true },
                  { col: "secondary_category" },
                  { col: "department_primary" },
                  { col: "department_secondary" },
                  { col: "created_at" },
                  { col: "status" },
                ].map(f => (
                  <div key={f.col} style={{ padding: "7px 9px", background: "#0d1018", border: `1px solid ${f.hl ? "#1a3a5a" : "#111820"}`, borderRadius: 3 }}>
                    <div style={{ fontSize: 7, letterSpacing: ".1em", marginBottom: 2 }}>
                      <span style={{ color: "#2a4060" }}>{FIELD_LABELS[f.col]}</span>
                    </div>
                    <div style={{ fontSize: 10, color: f.hl ? "#7ab0e0" : "#9ab0c0", fontWeight: f.hl ? 500 : 400 }}>
                      {f.col === "created_at"
                        ? (selectedTicket[f.col] ? new Date(selectedTicket[f.col]).toLocaleString("en-CA") : "—")
                        : selectedTicket[f.col] || "—"
                      }
                    </div>
                  </div>
                ))}
              </div>

              {/* Transcription */}
              <div style={{ padding: "9px 10px", background: "#0d1018", border: "1px solid #111820", borderRadius: 3, flexShrink: 0 }}>
                <div style={{ fontSize: 7, color: "#2a4060", letterSpacing: ".1em", marginBottom: 5 }}>TRANSCRIPTION</div>
                <div style={{ fontSize: 11, color: "#7a9ab0", lineHeight: 1.7 }}>
                  {selectedTicket.transcription || <span style={{ color: "#1a2535", fontStyle: "italic" }}>No transcription available</span>}
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ flexShrink: 0, display: "flex", gap: 8, paddingBottom: 4 }}>
                <button className="btn-complete" onClick={() => completeQueueItem(selectedTicket.ticket_id)}>✓ Mark Complete</button>
                <button className="btn-edit">✏ Edit Ticket</button>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#1a2535" }}>
              <div style={{ fontSize: 34 }}>🗂️</div>
              <div style={{ fontSize: 11, letterSpacing: ".08em" }}>NO TICKET SELECTED</div>
              <div style={{ fontSize: 9 }}>Click a ticket from the queue to view details</div>
            </div>
          )}
        </div>

        {/* RIGHT — REASONING + MAP */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Reasoning + Suggested Response */}
          <div style={{ flex: "0 0 auto", maxHeight: "45%", borderBottom: "1px solid #1c2230", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 14px 6px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: "#3a5070", letterSpacing: ".12em" }}>AI REASONING</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "2px 14px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
              {selectedTicket ? (
                <>
                  <div style={{ padding: "8px 10px", background: "#0d1018", border: "1px solid #111820", borderRadius: 3 }}>
                    <div style={{ fontSize: 7, color: "#2a5060", letterSpacing: ".1em", marginBottom: 4 }}>REASONING</div>
                    <div style={{ fontSize: 9.5, color: "#5a7a9a", lineHeight: 1.6 }}>
                      {selectedTicket.reasoning || <span style={{ color: "#1a2535", fontStyle: "italic" }}>No reasoning available</span>}
                    </div>
                  </div>
                  <div style={{ padding: "8px 10px", background: "#0d1018", border: "1px solid #00c89622", borderRadius: 3 }}>
                    <div style={{ fontSize: 7, color: "#00c89666", letterSpacing: ".1em", marginBottom: 4 }}>SUGGESTED RESPONSE</div>
                    <div style={{ fontSize: 9.5, color: "#4a8a7a", lineHeight: 1.6 }}>
                      {selectedTicket.suggested_response || <span style={{ color: "#1a2535", fontStyle: "italic" }}>No suggestion available</span>}
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 9, color: "#1a2535", fontStyle: "italic" }}>Select a ticket to view AI reasoning…</div>
              )}
            </div>
          </div>

          {/* MAP */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
            <div style={{ padding: "10px 14px 6px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: "#3a5070", letterSpacing: ".12em" }}>LOCATION</span>
              {selectedTicket && (
                <span style={{ fontSize: 8, color: "#243c5a" }}>{selectedTicket.department_primary}</span>
              )}
            </div>
            <div style={{ flex: 1, margin: "0 10px 10px", borderRadius: 4, overflow: "hidden", border: "1px solid #111820", minHeight: 0, position: "relative" }}>
              <LeafletMap
                lat={selectedTicket ? getCoord(selectedTicket.ticket_id).lat : null}
                lng={selectedTicket ? getCoord(selectedTicket.ticket_id).lng : null}
                label={selectedTicket?.primary_category ?? ""}
              />
              {!selectedTicket && (
                <div style={{ position: "absolute", inset: 0, background: "#0a0c0f99", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 999 }}>
                  <span style={{ fontSize: 9, color: "#1a2535", letterSpacing: ".08em" }}>SELECT A TICKET</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
