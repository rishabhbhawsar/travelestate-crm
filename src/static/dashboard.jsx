import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

const WS_URL = "ws://localhost:8000/ws/dashboard";
const API_URL = "http://localhost:8000/api/v1/leads";
const ROW_HEIGHT = 64;
const OVERSCAN = 6;

const CATEGORY_STYLES = {
  BUY: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  RENT: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  INVESTMENT: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  PARTNERSHIP: "bg-violet-500/10 text-violet-400 border-violet-500/30",
  SPAM: "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

const STATUS_STYLES = {
  PENDING: "bg-slate-700 text-slate-300",
  CLASSIFIED: "bg-emerald-500/15 text-emerald-400",
  FAILED: "bg-rose-500/15 text-rose-400",
};

function formatBudget(value) {
  if (value === null || value === undefined) return "—";
  return `₹${value.toLocaleString("en-IN")}`;
}

function UrgencyMeter({ score }) {
  if (!score) return <span className="text-slate-600">—</span>;
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((tier) => (
        <span
          key={tier}
          className={`h-3 w-1.5 rounded-sm ${
            tier <= score ? "bg-emerald-500" : "bg-slate-700"
          }`}
        />
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-500 ${STATUS_STYLES[status]}`}
    >
      {status === "PENDING" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
      )}
      {status}
    </span>
  );
}

function CategoryBadge({ category }) {
  if (!category) return null;
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${CATEGORY_STYLES[category]}`}
    >
      {category}
    </span>
  );
}

function LeadRow({ lead, style }) {
  const justClassified = lead.status === "CLASSIFIED" && lead._fresh;

  return (
    <div
      style={style}
      className={`absolute left-0 right-0 flex items-center gap-4 border-b border-slate-800/60 px-5 transition-colors duration-700 ${
        justClassified ? "bg-emerald-500/5" : "bg-transparent"
      }`}
    >
      <div className="w-40 shrink-0">
        <p className="truncate text-sm font-medium text-slate-200">{lead.full_name}</p>
        <p className="truncate text-xs text-slate-500">{lead.email}</p>
      </div>

      <div className="w-24 shrink-0">
        <StatusBadge status={lead.status} />
      </div>

      <div className="w-28 shrink-0">
        <CategoryBadge category={lead.classification?.category} />
      </div>

      <div className="w-32 shrink-0 text-sm text-slate-300">
        {formatBudget(lead.classification?.estimated_budget_inr)}
      </div>

      <div className="w-36 shrink-0 truncate text-sm text-slate-400">
        {lead.classification?.preferred_location ?? "—"}
      </div>

      <div className="w-24 shrink-0">
        <UrgencyMeter score={lead.classification?.urgency_score} />
      </div>

      <div className="flex-1 truncate text-sm text-slate-400">
        {lead.classification?.summary ?? (
          <span className="italic text-slate-600">Awaiting classification…</span>
        )}
      </div>
    </div>
  );
}

function VirtualizedLeadList({ leads }) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const resize = () => setViewportHeight(node.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback((e) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const totalHeight = leads.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(leads.length, startIndex + visibleCount);

  const visibleRows = useMemo(
    () => leads.slice(startIndex, endIndex),
    [leads, startIndex, endIndex]
  );

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="relative h-full overflow-y-auto"
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleRows.map((lead, i) => (
          <LeadRow
            key={lead.id}
            lead={lead}
            style={{ top: (startIndex + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
          />
        ))}
      </div>
    </div>
  );
}

function IngestPanel({ onSubmitted, connectionStatus }) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    raw_inquiry_text: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const update = (field) => (e) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, metadata: { source: "dashboard_demo" } }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const created = await res.json();
      onSubmitted(created);
      setForm({ full_name: "", email: "", phone: "", raw_inquiry_text: "" });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Simulate Inquiry</h2>
        <span
          className={`flex items-center gap-1.5 text-xs ${
            connectionStatus === "connected" ? "text-emerald-400" : "text-slate-500"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connectionStatus === "connected" ? "bg-emerald-400" : "bg-slate-600"
            }`}
          />
          {connectionStatus}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-3">
        <input
          required
          value={form.full_name}
          onChange={update("full_name")}
          placeholder="Full name"
          className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/50"
        />
        <input
          required
          type="email"
          value={form.email}
          onChange={update("email")}
          placeholder="Email"
          className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/50"
        />
        <input
          required
          value={form.phone}
          onChange={update("phone")}
          placeholder="Phone"
          className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/50"
        />
        <textarea
          required
          value={form.raw_inquiry_text}
          onChange={update("raw_inquiry_text")}
          placeholder="Raw inquiry text, e.g. 'Looking to invest in a 2BHK near Pune, budget around 80 lakhs, want to move fast.'"
          rows={6}
          className="flex-1 resize-none rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-emerald-500/50"
        />

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Ingesting…" : "Submit Inquiry"}
        </button>
      </form>
    </div>
  );
}

export default function CrmDashboard() {
  const [leads, setLeads] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => setConnectionStatus("connected");
    socket.onclose = () => setConnectionStatus("disconnected");
    socket.onerror = () => setConnectionStatus("error");

    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.event !== "lead_classified") return;

      setLeads((prev) =>
        prev.map((lead) =>
          lead.id === payload.lead_id
            ? {
                ...lead,
                status: payload.status,
                classification: payload.classification,
                _fresh: true,
              }
            : lead
        )
      );
    };

    return () => socket.close();
  }, []);

  const handleSubmitted = useCallback((createdLead) => {
    setLeads((prev) => [{ ...createdLead, _fresh: false }, ...prev]);
  }, []);

  const stats = useMemo(() => {
    const total = leads.length;
    const classified = leads.filter((l) => l.status === "CLASSIFIED").length;
    const pending = total - classified;
    return { total, classified, pending };
  }, [leads]);

  return (
    <div className="flex h-screen w-full flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            TravelEstate <span className="text-emerald-400">CRM</span>
          </h1>
          <p className="text-xs text-slate-500">AI-Agentic Lead Intelligence Engine</p>
        </div>
        <div className="flex gap-6 text-sm">
          <div className="text-right">
            <p className="text-xs text-slate-500">Total</p>
            <p className="font-semibold text-slate-200">{stats.total}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Classified</p>
            <p className="font-semibold text-emerald-400">{stats.classified}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Pending</p>
            <p className="font-semibold text-slate-400">{stats.pending}</p>
          </div>
        </div>
      </header>

      <main className="flex flex-1 gap-5 overflow-hidden p-5">
        <section className="flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
          <div className="flex items-center gap-4 border-b border-slate-800 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <div className="w-40 shrink-0">Customer</div>
            <div className="w-24 shrink-0">Status</div>
            <div className="w-28 shrink-0">Category</div>
            <div className="w-32 shrink-0">Budget</div>
            <div className="w-36 shrink-0">Location</div>
            <div className="w-24 shrink-0">Urgency</div>
            <div className="flex-1">Summary</div>
          </div>

          <div className="flex-1 overflow-hidden">
            {leads.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-600">
                No leads yet — submit an inquiry to begin the demo.
              </div>
            ) : (
              <VirtualizedLeadList leads={leads} />
            )}
          </div>
        </section>

        <aside className="w-96 shrink-0">
          <IngestPanel onSubmitted={handleSubmitted} connectionStatus={connectionStatus} />
        </aside>
      </main>
    </div>
  );
}