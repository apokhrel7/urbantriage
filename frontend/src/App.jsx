import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
//  DATABRICKS CONNECTION CONFIG
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
//  DATABRICKS FETCH — ready to wire up
//  Returns rows keyed by exact column names from the schema.
// ============================================================
async function fetchTickets(limit = 20) {
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
  const submitRes = await fetch(`${DATABRICKS_CONFIG.host}/api/2.0/sql/statements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DATABRICKS_CONFIG.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: DATABRICKS_CONFIG.warehouseId, statement: sql, wait_timeout: "10s" }),
  });
  let result = await submitRes.json();
  while (result.status?.state === "RUNNING" || result.status?.state === "PENDING") {
    await new Promise(r => setTimeout(r, 800));
    const poll = await fetch(`${DATABRICKS_CONFIG.host}/api/2.0/sql/statements/${result.statement_id}`,
      { headers: { Authorization: `Bearer ${DATABRICKS_CONFIG.token}` } });
    result = await poll.json();
  }
  const cols = result.manifest?.schema?.columns?.map(c => c.name) ?? [];
  return (result.result?.data_array ?? []).map(row => Object.fromEntries(cols.map((col, i) => [col, row[i]])));
}

// ============================================================
//  FIELD LABELS  —  exact column_name → "Display Name"
// ============================================================
const FIELD_LABELS = {
  service_request_id: "Request ID",
  requested_date:     "Requested Date",
  status_description: "Status",
  source:             "Source",
  service_name:       "Service Name",
  agency_responsible: "Agency Responsible",
  address:            "Address",
  comm_name:          "Community",
  latitude:           "Latitude",
  longitude:          "Longitude",
  transcription:      "Transcription",
  predicted_category: "Predicted Category",
  priority:           "Priority",
};

// ============================================================
//  MOCK DATA — real rows from 311_enriched_tickets
// ============================================================
const ACTIVE_TICKET = {
  service_request_id: "26-00152823",
  requested_date:     "2026/03/10 12:00:00 AM",
  status_description: "Open",
  source:             "Other",
  service_name:       "WATS - Sewage Back-up",
  agency_responsible: "OS - Water Services",
  address:            null,
  comm_name:          "HILLHURST",
  latitude:           51.05727753236,
  longitude:          -114.09364601409,
  transcription:      "Hi I am calling because I've got a pretty nasty sewage back-up in my basement in Hillhurst and I'm not sure what to do about it. There's water everywhere and it's really smelly, so I'm hoping someone can come take a look as soon as possible. I'm worried it might be a bigger issue with the sewer lines or something.",
  predicted_category: "WATS - Sewage Back-up",
  priority:           "HIGH",
};

const INITIAL_QUEUE = [
  { service_request_id:"26-00153435", service_name:"WATS - Sewage Back-up",        priority:"HIGH",   comm_name:"TARADALE",      requested_date:"14:18", status_description:"Open", latitude:51.11794, longitude:-113.93400 },
  { service_request_id:"26-00151312", service_name:"Roads - Snow and Ice Control",  priority:"HIGH",   comm_name:"RICHMOND",      requested_date:"14:11", status_description:"Open", latitude:51.02971, longitude:-114.11842 },
  { service_request_id:"26-00153629", service_name:"Corporate - Graffiti Concerns", priority:"MEDIUM", comm_name:"VARSITY",       requested_date:"13:57", status_description:"Open", latitude:51.09605, longitude:-114.16251 },
  { service_request_id:"26-00151289", service_name:"Bylaw - Noise Concerns",        priority:"MEDIUM", comm_name:"TEMPLE",        requested_date:"13:44", status_description:"Open", latitude:51.08880, longitude:-113.94677 },
  { service_request_id:"26-00153277", service_name:"WRS - Cart Management",         priority:"LOW",    comm_name:"HARVEST HILLS", requested_date:"13:31", status_description:"Open", latitude:51.14768, longitude:-114.05278 },
];

const TRANSCRIPT_WORDS = ACTIVE_TICKET.transcription.split(" ");

const REASONING_STEPS = [
  { delay: 3000, text: `Keywords detected: "sewage back-up", "basement", "water everywhere"`,           status: "done"    },
  { delay: 4000, text: `Predicted category → ${ACTIVE_TICKET.predicted_category}  ·  confidence 0.93`, status: "done"    },
  { delay: 4900, text: `Community extracted: ${ACTIVE_TICKET.comm_name}`,                               status: "done"    },
  { delay: 5700, text: `Geo coords: ${ACTIVE_TICKET.latitude.toFixed(4)}, ${ACTIVE_TICKET.longitude.toFixed(4)}`, status: "done" },
  { delay: 6500, text: `MLflow priority model scoring…`,                                                status: "loading" },
  { delay: 7800, text: `Priority → HIGH  ·  score 0.96  ·  18× baseline for area this week`,           status: "done"    },
  { delay: 8500, text: `Agency routing → ${ACTIVE_TICKET.agency_responsible}`,                         status: "done"    },
  { delay: 9200, text: `Agent auto-dispatched. Ticket active. Awaiting completion.`,                   status: "alert"   },
];

const PRIORITY_COLOR = { HIGH:"#ff3b3b", MEDIUM:"#ffaa00", MED:"#ffaa00", LOW:"#00c896" };

// ============================================================
//  LEAFLET MAP COMPONENT — loads Leaflet from CDN
// ============================================================
function LeafletMap({ lat, lng, label, active }) {
  const mapRef    = useRef(null);
  const leafletRef = useRef(null);
  const markerRef  = useRef(null);
  const mapId = useRef(`map-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    // Inject Leaflet CSS if not already present
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id   = "leaflet-css";
      link.rel  = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    // Load Leaflet JS if not already loaded
    const initMap = () => {
      if (leafletRef.current) return;
      const L = window.L;
      if (!L) return;

      const map = L.map(mapId.current, { zoomControl: true, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      leafletRef.current = map;

      if (active && lat && lng) {
        map.setView([lat, lng], 15);
        const icon = L.divIcon({
          html: `<div style="width:14px;height:14px;background:#ff3b3b;border:2px solid #fff;border-radius:50%;box-shadow:0 0 12px #ff3b3b99;"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7], className: ""
        });
        markerRef.current = L.marker([lat, lng], { icon }).addTo(map)
          .bindPopup(`<b style="font-size:11px">${label}</b><br/><span style="font-size:10px">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>`, { maxWidth: 180 })
          .openPopup();
      } else {
        map.setView([51.0447, -114.0719], 11); // Calgary center
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
  }, []);

  // Update marker when ticket becomes active
  useEffect(() => {
    const L = window.L;
    if (!L || !leafletRef.current) return;
    if (active && lat && lng) {
      leafletRef.current.setView([lat, lng], 15, { animate: true });
      if (markerRef.current) markerRef.current.remove();
      const icon = L.divIcon({
        html: `<div style="width:14px;height:14px;background:#ff3b3b;border:2px solid #fff;border-radius:50%;box-shadow:0 0 12px #ff3b3b99;"></div>`,
        iconSize: [14, 14], iconAnchor: [7, 7], className: ""
      });
      markerRef.current = L.marker([lat, lng], { icon }).addTo(leafletRef.current)
        .bindPopup(`<b style="font-size:11px">${label}</b><br/><span style="font-size:10px">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>`, { maxWidth: 180 })
        .openPopup();
    }
  }, [active, lat, lng]);

  return (
    <div id={mapId.current} ref={mapRef} style={{ width:"100%", height:"100%", background:"#0d1018" }} />
  );
}

// ============================================================
//  MAIN COMPONENT
// ============================================================
export default function App() {
  const [phase, setPhase]                   = useState("idle");
  const [wordIndex, setWordIndex]           = useState(0);
  const [reasoningSteps, setReasoningSteps] = useState([]);
  const [ticketVisible, setTicketVisible]   = useState(false);
  const [completed, setCompleted]           = useState(false);
  const [elapsed, setElapsed]               = useState(0);
  const [clock, setClock]                   = useState(new Date());
  const [queue, setQueue]                   = useState(INITIAL_QUEUE);
  const timerRef      = useRef(null);
  const transcriptRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const startDemo = () => {
    setPhase("calling"); setWordIndex(0); setReasoningSteps([]);
    setTicketVisible(false); setCompleted(false); setElapsed(0);
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);

    let i = 0;
    const wt = setInterval(() => {
      i++; setWordIndex(i);
      if (i >= TRANSCRIPT_WORDS.length) { clearInterval(wt); setPhase("processing"); }
    }, 110);

    REASONING_STEPS.forEach((step, idx) => {
      setTimeout(() => {
        setReasoningSteps(prev => [...prev, { ...step, id: idx }]);
        if (idx === REASONING_STEPS.length - 1)
          setTimeout(() => { setTicketVisible(true); setPhase("ready"); clearInterval(timerRef.current); }, 500);
      }, step.delay);
    });
  };

  const handleComplete = () => {
    setCompleted(true);
    setTimeout(() => {
      setPhase("idle"); setWordIndex(0); setReasoningSteps([]);
      setTicketVisible(false); setCompleted(false); setElapsed(0);
    }, 1800);
  };

  const completeQueueItem = (id) => setQueue(q => q.filter(t => t.service_request_id !== id));

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [wordIndex]);

  const isLive = phase === "calling" || phase === "processing";

  // All 13 columns displayed in ticket
  const ticketFields = [
    { col:"service_request_id",  value: ACTIVE_TICKET.service_request_id },
    { col:"service_name",        value: ACTIVE_TICKET.service_name, hl: true },
    { col:"predicted_category",  value: ACTIVE_TICKET.predicted_category, hl: true },
    { col:"priority",            value: ACTIVE_TICKET.priority, color: "#ff5050" },
    { col:"agency_responsible",  value: ACTIVE_TICKET.agency_responsible },
    { col:"status_description",  value: "Open — Auto-Dispatched" },
    { col:"comm_name",           value: ACTIVE_TICKET.comm_name },
    { col:"address",             value: ACTIVE_TICKET.address || "Extracted from transcript" },
    { col:"source",              value: "AI_AGENT" },
    { col:"requested_date",      value: ACTIVE_TICKET.requested_date },
    { col:"latitude",            value: ACTIVE_TICKET.latitude.toFixed(6) },
    { col:"longitude",           value: ACTIVE_TICKET.longitude.toFixed(6) },
  ];

  return (
    <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#0a0c0f", color:"#c8d0d8", minHeight:"100vh", display:"flex", flexDirection:"column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Barlow:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#0f1215}
        ::-webkit-scrollbar-thumb{background:#2a3040;border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes blink{0%,49%,100%{opacity:1}50%{opacity:0}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.97)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes alertPulse{0%,100%{background:#150a08}50%{background:#1c0d0a}}
        @keyframes completePulse{0%,100%{background:#081510}50%{background:#0c1e14}}
        .step-enter{animation:slideIn .3s ease forwards}
        .ticket-enter{animation:fadeUp .5s ease forwards}
        .ticket-exit{animation:fadeOut .5s ease forwards}
        .btn-complete{background:#00c896;color:#001a12;border:none;padding:10px 28px;font-family:'Barlow',sans-serif;font-weight:800;font-size:12px;letter-spacing:.08em;cursor:pointer;border-radius:3px;transition:all .2s;text-transform:uppercase}
        .btn-complete:hover{background:#00e6ad;transform:translateY(-1px);box-shadow:0 6px 18px #00c89644}
        .btn-edit{background:transparent;color:#6a7a8a;border:1px solid #2a3240;padding:10px 18px;font-family:'Barlow',sans-serif;font-weight:600;font-size:11px;letter-spacing:.08em;cursor:pointer;border-radius:3px;transition:all .15s;text-transform:uppercase}
        .btn-edit:hover{border-color:#4a5870;color:#9aaabb}
        .btn-start{background:#1a6fff;color:white;border:none;padding:12px 0;width:100%;font-family:'Barlow',sans-serif;font-weight:800;font-size:13px;letter-spacing:.06em;cursor:pointer;border-radius:3px;transition:all .2s;text-transform:uppercase}
        .btn-start:hover{background:#2278ff;box-shadow:0 6px 20px #1a6fff44}
        .live-dot{width:7px;height:7px;background:#ff3b3b;border-radius:50%;animation:pulse 1s ease-in-out infinite;display:inline-block}
        .qrow:hover{background:#0f1520 !important;cursor:pointer}
        .leaflet-popup-content-wrapper{background:#0d1520 !important;border:1px solid #2a3a50 !important;border-radius:4px !important;box-shadow:0 4px 16px #00000088 !important}
        .leaflet-popup-content{color:#a0b8cc !important;margin:8px 10px !important}
        .leaflet-popup-tip{background:#0d1520 !important}
        .leaflet-popup-close-button{color:#4a6a8a !important}
        .leaflet-tile{filter:brightness(.7) saturate(.4) hue-rotate(180deg)}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background:"#0d1018", borderBottom:"1px solid #1c2230", padding:"10px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:30, height:30, background:"#1a6fff11", border:"1px solid #1a6fff44", borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>📡</div>
            <div>
              <div style={{ fontFamily:"'Barlow',sans-serif", fontWeight:800, fontSize:14, color:"#e8f0f8", letterSpacing:".05em" }}>CALGARY 311</div>
              <div style={{ fontSize:8, color:"#2a3a50", letterSpacing:".12em" }}>AI DISPATCH AGENT · DATABRICKS</div>
            </div>
          </div>
          <div style={{ width:1, height:26, background:"#1c2230" }}/>
          {[{l:"CALLS TODAY",v:"312"},{l:"AVG HANDLE",v:"8.4s"},{l:"ACTIVE",v:queue.length + (ticketVisible&&!completed?1:0)}].map(s=>(
            <div key={s.l}><div style={{ fontSize:8, color:"#2a3a50", letterSpacing:".1em" }}>{s.l}</div><div style={{ fontSize:14, fontWeight:500, color:"#7ab0e0" }}>{s.v}</div></div>
          ))}
          <div style={{ width:1, height:26, background:"#1c2230" }}/>
          <div style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 9px", background:"#0d1520", border:"1px solid #1a3050", borderRadius:3 }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:"#1a6fff", boxShadow:"0 0 5px #1a6fff" }}/>
            <span style={{ fontSize:8, color:"#2a5070", letterSpacing:".09em" }}>{DATABRICKS_CONFIG.catalog}.{DATABRICKS_CONFIG.schema}.{DATABRICKS_CONFIG.table}</span>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          {isLive && <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:9, color:"#ff6060", letterSpacing:".1em" }}><span className="live-dot"/>LIVE · {elapsed}s</div>}
          {phase==="ready" && !completed && <div style={{ fontSize:9, color:"#00c896", letterSpacing:".1em" }}>✓ AUTO-DISPATCHED IN {elapsed}s</div>}
          <div style={{ fontSize:9, color:"#2a3a50" }}>{clock.toLocaleTimeString("en-CA",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</div>
        </div>
      </div>

      {/* ── ALERT BANNER ── */}
      {ticketVisible && !completed && (
        <div style={{ background:"#150a08", borderBottom:"1px solid #ff3b3b33", padding:"8px 20px", display:"flex", alignItems:"center", gap:10, animation:"alertPulse 2s ease-in-out infinite", flexShrink:0 }}>
          <span style={{ fontSize:12 }}>⚠️</span>
          <span style={{ fontFamily:"'Barlow',sans-serif", fontWeight:700, fontSize:10, color:"#ff6060", letterSpacing:".08em" }}>
            HIGH PRIORITY · {ACTIVE_TICKET.predicted_category.toUpperCase()} · {ACTIVE_TICKET.comm_name} · AUTO-DISPATCHED — AWAITING COMPLETION
          </span>
          <span style={{ marginLeft:"auto", fontSize:8, color:"#ff3b3b44", letterSpacing:".1em" }}>{ACTIVE_TICKET.service_request_id}</span>
        </div>
      )}
      {completed && (
        <div style={{ background:"#081510", borderBottom:"1px solid #00c89633", padding:"8px 20px", flexShrink:0, animation:"completePulse 1.5s ease-in-out infinite" }}>
          <span style={{ fontFamily:"'Barlow',sans-serif", fontWeight:700, fontSize:10, color:"#00c896", letterSpacing:".08em" }}>
            ✓ {ACTIVE_TICKET.service_request_id} MARKED COMPLETE — REMOVING FROM ACTIVE QUEUE
          </span>
        </div>
      )}

      {/* ── 3-COLUMN LAYOUT ── */}
      <div style={{ display:"grid", gridTemplateColumns:"268px 1fr 1fr", flex:1, overflow:"hidden", minHeight:0 }}>

        {/* LEFT — QUEUE */}
        <div style={{ borderRight:"1px solid #1c2230", display:"flex", flexDirection:"column", overflow:"hidden" }}>
          <div style={{ padding:"11px 14px 8px", borderBottom:"1px solid #1c2230", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
            <span style={{ fontSize:9, color:"#3a5070", letterSpacing:".12em" }}>ACTIVE TICKETS</span>
            <span style={{ fontSize:8, color:"#1a3050", letterSpacing:".08em" }}>OPEN ONLY</span>
          </div>

          {phase!=="idle" && (
            <div style={{ margin:"10px 10px 4px", padding:"10px", background:"#0f1520", border:`1px solid ${ticketVisible&&!completed?"#ff3b3b55":"#1a6fff33"}`, borderRadius:4, position:"relative", overflow:"hidden", flexShrink:0 }}>
              {ticketVisible && !completed && <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:"#ff3b3b" }}/>}
              {completed && <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:"#00c896" }}/>}
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ fontSize:9, color:"#6a9ac0", fontWeight:500 }}>{ACTIVE_TICKET.service_request_id}</span>
                <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                  {!ticketVisible && <span className="live-dot" style={{ width:5, height:5 }}/>}
                  <span style={{ fontSize:8, letterSpacing:".1em", color:completed?"#00c896":ticketVisible?"#ff6060":"#3a6a9a" }}>
                    {completed?"DONE":ticketVisible?"ACTIVE":"LIVE"}
                  </span>
                </div>
              </div>
              <div style={{ fontSize:11, color:"#c0d0e0", marginBottom:2 }}>{ticketVisible?ACTIVE_TICKET.predicted_category:"Classifying…"}</div>
              <div style={{ fontSize:9, color:"#2a3a50" }}>{ticketVisible?`${ACTIVE_TICKET.comm_name}  ·  Water Services`:"Transcribing call…"}</div>
              {ticketVisible && !completed && <div style={{ marginTop:6, padding:"2px 7px", background:"#ff3b3b22", borderRadius:2, display:"inline-block" }}><span style={{ fontSize:8, color:"#ff6060", letterSpacing:".1em" }}>HIGH · AUTO-DISPATCHED</span></div>}
            </div>
          )}

          <div style={{ flex:1, overflowY:"auto" }}>
            {queue.map(t=>(
              <div key={t.service_request_id} className="qrow" style={{ padding:"9px 14px", borderBottom:"1px solid #0f1520", transition:"background .1s", position:"relative" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                  <span style={{ fontSize:9, color:"#3a5070" }}>{t.service_request_id}</span>
                  <span style={{ fontSize:8, color:"#252f40" }}>{t.requested_date}</span>
                </div>
                <div style={{ fontSize:11, color:"#7a8a9a", marginBottom:2 }}>{t.service_name}</div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:9, color:"#252f40" }}>{t.comm_name}</span>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:8, color:PRIORITY_COLOR[t.priority]||"#6a8aaa", letterSpacing:".08em" }}>{t.priority}</span>
                    <button onClick={()=>completeQueueItem(t.service_request_id)} style={{ background:"#0d2018", border:"1px solid #00c89633", borderRadius:2, padding:"1px 6px", fontSize:8, color:"#00a870", cursor:"pointer", letterSpacing:".06em", fontFamily:"'Barlow',sans-serif" }}>DONE</button>
                  </div>
                </div>
              </div>
            ))}
            {queue.length===0&&phase==="idle"&&<div style={{ padding:"20px 14px", fontSize:10, color:"#1a2535", fontStyle:"italic" }}>No active tickets</div>}
          </div>

          <div style={{ padding:"12px", borderTop:"1px solid #1c2230", flexShrink:0 }}>
            {phase==="idle"  && <button className="btn-start" onClick={startDemo}>▶ Run Demo Call</button>}
            {phase==="ready" && !completed && <button className="btn-start" style={{ background:"#0d1a28", fontSize:11 }} onClick={startDemo}>▶ Run Another Call</button>}
            {isLive          && <div style={{ textAlign:"center", fontSize:9, color:"#2a3a50", letterSpacing:".1em", padding:"10px 0" }}>PROCESSING…</div>}
            <div style={{ marginTop:10, padding:"8px 10px", background:"#0d1018", border:"1px solid #111820", borderRadius:3 }}>
              <div style={{ fontSize:8, color:"#1a3050", letterSpacing:".1em", marginBottom:4 }}>DATABRICKS</div>
              <div style={{ fontSize:8, lineHeight:1.7, color:"#243040" }}>
                <div>catalog  <span style={{ color:"#2a5070" }}>{DATABRICKS_CONFIG.catalog}</span></div>
                <div>schema   <span style={{ color:"#2a5070" }}>{DATABRICKS_CONFIG.schema}</span></div>
                <div>table    <span style={{ color:"#2a5070" }}>{DATABRICKS_CONFIG.table}</span></div>
                <div>api      <span style={{ color:"#2a5070" }}>/api/2.0/sql/statements</span></div>
              </div>
              <div style={{ marginTop:6, padding:"2px 7px", background:"#0a1020", border:"1px solid #1a2a3a", borderRadius:2, display:"inline-block" }}>
                <span style={{ fontSize:7, color:"#ff404055", letterSpacing:".08em" }}>● DEMO MODE</span>
              </div>
            </div>
          </div>
        </div>

        {/* CENTER — TRANSCRIPT + TICKET */}
        <div style={{ display:"flex", flexDirection:"column", overflow:"hidden", borderRight:"1px solid #1c2230" }}>
          {/* Transcript */}
          <div style={{ flex:phase==="ready"?"0 0 155px":"1", borderBottom:"1px solid #1c2230", display:"flex", flexDirection:"column", transition:"flex .4s ease", minHeight:0 }}>
            <div style={{ padding:"10px 16px 6px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
              <span style={{ fontSize:9, color:"#3a5070", letterSpacing:".12em" }}>CALL TRANSCRIPT</span>
              <span style={{ fontSize:8, color:"#1a2e48", letterSpacing:".08em" }}>col: <span style={{ color:"#243c5a" }}>transcription</span></span>
              {isLive && <div style={{ display:"flex", alignItems:"center", gap:4, fontSize:8, color:"#ff6060" }}><span className="live-dot" style={{ width:5, height:5 }}/>LIVE</div>}
              {!isLive && wordIndex>0 && <span style={{ fontSize:8, color:"#00c896", letterSpacing:".08em" }}>✓ COMPLETE</span>}
            </div>
            <div ref={transcriptRef} style={{ flex:1, overflowY:"auto", padding:"4px 16px 12px", fontSize:12, lineHeight:"1.85", color:"#6a7a8a" }}>
              {phase==="idle"
                ? <div style={{ color:"#1a2535", fontStyle:"italic", fontSize:11 }}>Awaiting incoming call…</div>
                : <>{TRANSCRIPT_WORDS.slice(0,wordIndex).join(" ")}{isLive&&wordIndex<TRANSCRIPT_WORDS.length&&<span style={{ borderLeft:"2px solid #1a6fff", marginLeft:2, animation:"blink 1s infinite" }}/>}</>
              }
            </div>
          </div>

          {/* Ticket */}
          {ticketVisible && (
            <div className={completed?"ticket-exit":"ticket-enter"} style={{ flex:1, overflowY:"auto", padding:"12px 16px", display:"flex", flexDirection:"column", gap:10, minHeight:0 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <span style={{ fontFamily:"'Barlow',sans-serif", fontSize:11, fontWeight:700, color:"#dce8f4", letterSpacing:".06em" }}>ACTIVE TICKET</span>
                  <div style={{ padding:"2px 8px", background:"#ff3b3b22", border:"1px solid #ff3b3b55", borderRadius:2, fontSize:8, color:"#ff6060", letterSpacing:".1em" }}>🔴 HIGH</div>
                  <div style={{ padding:"2px 8px", background:"#00c89611", border:"1px solid #00c89633", borderRadius:2, fontSize:8, color:"#00a870", letterSpacing:".08em" }}>✓ AUTO-DISPATCHED</div>
                </div>
                <span style={{ fontSize:8, color:"#1a3050" }}>AI CONFIDENCE <span style={{ color:"#2a5080" }}>96%</span></span>
              </div>

              {/* All 13 columns in grid (transcription shown separately below) */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, flexShrink:0 }}>
                {ticketFields.map(f=>(
                  <div key={f.col} style={{ padding:"7px 9px", background:"#0d1018", border:`1px solid ${f.hl?"#1a3a5a":"#111820"}`, borderRadius:3 }}>
                    <div style={{ fontSize:7, letterSpacing:".1em", marginBottom:2 }}>
                      <span style={{ color:"#2a4060" }}>{FIELD_LABELS[f.col]}</span>
                      <span style={{ color:"#162030", marginLeft:4 }}>({f.col})</span>
                    </div>
                    <div style={{ fontSize:10, color:f.color||(f.hl?"#7ab0e0":"#9ab0c0"), fontWeight:f.hl?500:400 }}>{f.value}</div>
                  </div>
                ))}
              </div>

              {/* Transcription field */}
              <div style={{ padding:"9px 10px", background:"#0d1018", border:"1px solid #111820", borderRadius:3, flexShrink:0 }}>
                <div style={{ fontSize:7, color:"#2a4060", letterSpacing:".1em", marginBottom:3 }}>
                  AI SUMMARY <span style={{ color:"#162030" }}>(from: transcription)</span>
                </div>
                <div style={{ fontSize:11, color:"#7a9ab0", lineHeight:1.6 }}>
                  Active sewage back-up in residential basement, Hillhurst. Water present throughout, strong odour confirmed. Possible mainline blockage. Immediate inspection required — health and structural risk if unresolved.
                </div>
              </div>

              {/* Complete button only */}
              <div style={{ flexShrink:0, display:"flex", gap:8, paddingBottom:4 }}>
                <button className="btn-complete" onClick={handleComplete}>✓ Mark Complete</button>
                <button className="btn-edit">✏ Edit Ticket</button>
              </div>
            </div>
          )}

          {phase==="idle" && (
            <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:"#1a2535" }}>
              <div style={{ fontSize:34 }}>🗂️</div>
              <div style={{ fontSize:11, letterSpacing:".08em" }}>NO ACTIVE CALL</div>
              <div style={{ fontSize:9 }}>Press Run Demo Call to begin</div>
            </div>
          )}
        </div>

        {/* RIGHT — REASONING + MAP */}
        <div style={{ display:"flex", flexDirection:"column", overflow:"hidden" }}>

          {/* Reasoning */}
          <div style={{ flex:"0 0 auto", maxHeight:"40%", borderBottom:"1px solid #1c2230", display:"flex", flexDirection:"column" }}>
            <div style={{ padding:"10px 14px 6px", display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
              <span style={{ fontSize:9, color:"#3a5070", letterSpacing:".12em" }}>AGENT REASONING</span>
              {phase==="processing" && <div style={{ width:8, height:8, border:"1.5px solid #1a6fff", borderTopColor:"transparent", borderRadius:"50%", animation:"spin .8s linear infinite" }}/>}
            </div>
            <div style={{ flex:1, overflowY:"auto", padding:"2px 14px 10px" }}>
              {reasoningSteps.length===0 && <div style={{ fontSize:9, color:"#1a2535", fontStyle:"italic" }}>Awaiting call…</div>}
              {reasoningSteps.map(step=>(
                <div key={step.id} className="step-enter" style={{ display:"flex", gap:7, alignItems:"flex-start", marginBottom:8 }}>
                  <div style={{
                    width:13, height:13, flexShrink:0, borderRadius:"50%", marginTop:1,
                    background:step.status==="alert"?"#ff3b3b22":step.status==="loading"?"#1a6fff22":"#00c89622",
                    border:`1px solid ${step.status==="alert"?"#ff3b3b66":step.status==="loading"?"#1a6fff66":"#00c89666"}`,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:6
                  }}>
                    {step.status==="done"?"✓":step.status==="alert"?"!":(
                      <div style={{ width:4, height:4, border:"1px solid #1a6fff", borderTopColor:"transparent", borderRadius:"50%", animation:"spin .8s linear infinite" }}/>
                    )}
                  </div>
                  <div style={{ fontSize:9.5, lineHeight:1.5, color:step.status==="alert"?"#ff8080":step.status==="loading"?"#3a6a9a":"#5a7a9a" }}>
                    {step.text}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* REAL LEAFLET MAP */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minHeight:0 }}>
            <div style={{ padding:"10px 14px 6px", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
              <span style={{ fontSize:9, color:"#3a5070", letterSpacing:".12em" }}>LOCATION</span>
              {ticketVisible && (
                <span style={{ fontSize:8, color:"#2a4060" }}>
                  lat <span style={{ color:"#3a5a7a" }}>{ACTIVE_TICKET.latitude.toFixed(4)}</span>
                  {"  "}lng <span style={{ color:"#3a5a7a" }}>{ACTIVE_TICKET.longitude.toFixed(4)}</span>
                  {"  "}col: <span style={{ color:"#243c5a" }}>latitude / longitude</span>
                </span>
              )}
            </div>
            <div style={{ flex:1, margin:"0 10px 10px", borderRadius:4, overflow:"hidden", border:"1px solid #111820", minHeight:0, position:"relative" }}>
              <LeafletMap
                lat={ACTIVE_TICKET.latitude}
                lng={ACTIVE_TICKET.longitude}
                label={`${ACTIVE_TICKET.predicted_category} · ${ACTIVE_TICKET.comm_name}`}
                active={ticketVisible && !completed}
              />
              {!ticketVisible && (
                <div style={{ position:"absolute", inset:0, background:"#0a0c0f99", display:"flex", alignItems:"center", justifyContent:"center", pointerEvents:"none", zIndex:999 }}>
                  <span style={{ fontSize:9, color:"#1a2535", letterSpacing:".08em" }}>{phase==="idle"?"NO LOCATION":"AWAITING COORDS…"}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
