const { useState, useEffect, useRef, useMemo, useCallback } = React;

// -----------------------------------------------------------------------
// Global constants
// -----------------------------------------------------------------------

// Dynamically read whatever host domain name the user loaded in their browser window
const HOST_URL = window.location.host; 

const API_URL = `${window.location.protocol}//${HOST_URL}/api/v1/leads`;
const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${HOST_URL}/ws/dashboard`;

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

// -----------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------

function formatBudget(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  return "₹" + value.toLocaleString("en-IN");
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return "—";
  }
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    return "—";
  }
}

// -----------------------------------------------------------------------
// UrgencyMeter
// -----------------------------------------------------------------------

function UrgencyMeter({ score }) {
  if (!score) {
    return <span className="text-slate-600 text-xs">—</span>;
  }

  return (
    <div className="flex items-center gap-0.5" title={"Urgency: " + score + "/5"}>
      {[1, 2, 3, 4, 5].map((tier) => (
        <span
          key={tier}
          className={
            "h-3 w-1.5 rounded-sm transition-colors duration-300 " +
            (tier <= score ? "bg-emerald-500" : "bg-slate-700")
          }
        />
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------
// StatusBadge
// -----------------------------------------------------------------------

function StatusBadge({ status }) {
  const className = STATUS_STYLES[status] || STATUS_STYLES.PENDING;

  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-500 " +
        className
      }
    >
      {status === "PENDING" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
      )}
      {status}
    </span>
  );
}

// -----------------------------------------------------------------------
// CategoryBadge
// -----------------------------------------------------------------------

function CategoryBadge({ category }) {
  if (!category) {
    return <span className="text-xs text-slate-600">—</span>;
  }

  const className = CATEGORY_STYLES[category] || CATEGORY_STYLES.SPAM;

  return (
    <span
      className={
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide " +
        className
      }
    >
      {category}
    </span>
  );
}

// -----------------------------------------------------------------------
// LeadRow
// -----------------------------------------------------------------------

function LeadRow({ lead, style }) {
  const justClassified = lead.status === "CLASSIFIED" && lead._fresh;
  const classification = lead.classification || null;

  return (
    <div
      style={style}
      className={
        "absolute left-0 right-0 flex items-center gap-4 border-b border-slate-800/60 px-5 transition-colors duration-700 " +
        (justClassified ? "bg-emerald-500/5" : "bg-transparent")
      }
    >
      <div className="w-40 shrink-0">
        <p className="truncate text-sm font-medium text-slate-200">{lead.full_name}</p>
        <p className="truncate text-xs text-slate-500">{lead.email}</p>
      </div>

      <div className="w-24 shrink-0">
        <StatusBadge status={lead.status} />
      </div>

      <div className="w-28 shrink-0">
        <CategoryBadge category={classification ? classification.category : null} />
      </div>

      <div className="w-32 shrink-0 text-sm text-slate-300">
        {formatBudget(classification ? classification.estimated_budget_inr : null)}
      </div>

      <div className="w-36 shrink-0 truncate text-sm text-slate-400">
        {classification && classification.preferred_location ? classification.preferred_location : "—"}
      </div>

      <div className="w-24 shrink-0">
        <UrgencyMeter score={classification ? classification.urgency_score : null} />
      </div>

      <div className="flex-1 truncate text-sm text-slate-400">
        {classification && classification.summary ? (
          classification.summary
        ) : (
          <span className="italic text-slate-600">Awaiting classification…</span>
        )}
      </div>

      <div className="w-16 shrink-0 text-right text-xs text-slate-600">
        {formatTimestamp(lead.created_at)}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// VirtualizedLeadList
// -----------------------------------------------------------------------

function VirtualizedLeadList({ leads }) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const resize = () => setViewportHeight(node.clientHeight);
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback((event) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const totalHeight = leads.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(leads.length, startIndex + visibleCount);

  const visibleRows = useMemo(() => {
    return leads.slice(startIndex, endIndex);
  }, [leads, startIndex, endIndex]);

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

// -----------------------------------------------------------------------
// IngestPanel
// -----------------------------------------------------------------------

function IngestPanel({ onSubmitted, connectionStatus }) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    raw_inquiry_text: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const update = (field) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: form.full_name,
          email: form.email,
          phone: form.phone,
          raw_inquiry_text: form.raw_inquiry_text,
          metadata: { source: "dashboard_demo" },
        }),
      });

      if (!response.ok) {
        throw new Error("Request failed with status " + response.status);
      }

      const created = await response.json();
      onSubmitted(created);

      setForm({
        full_name: "",
        email: "",
        phone: "",
        raw_inquiry_text: "",
      });
    } catch (err) {
      setError(err.message || "Failed to submit inquiry.");
    } finally {
      setSubmitting(false);
    }
  };

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Simulate Inquiry</h2>
        <span
          className={
            "flex items-center gap-1.5 text-xs " +
            (isConnected ? "text-emerald-400" : "text-slate-500")
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (isConnected ? "bg-emerald-400" : "bg-slate-600")
            }
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
          placeholder="Looking to invest in a 2BHK near Pune, budget around 80 lakhs, want to move fast."
          rows={7}
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

      <p className="text-[11px] leading-relaxed text-slate-600">
        Submitting persists the lead as <span className="text-slate-400">PENDING</span> and
        schedules background AI classification. The row above updates live over the
        WebSocket the instant classification completes — no refresh required.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------
// CrmDashboard
// -----------------------------------------------------------------------

function CrmDashboard() {
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
      } catch (err) {
        return;
      }

      if (payload.event !== "lead_classified") {
        return;
      }

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

    return () => {
      socket.close();
    };
  }, []);

  const handleSubmitted = useCallback((createdLead) => {
    setLeads((prev) => [{ ...createdLead, _fresh: false }, ...prev]);
  }, []);

  const stats = useMemo(() => {
    const total = leads.length;
    const classified = leads.filter((lead) => lead.status === "CLASSIFIED").length;
    const failed = leads.filter((lead) => lead.status === "FAILED").length;
    const pending = total - classified - failed;
    return { total, classified, pending, failed };
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
          <div className="text-right">
            <p className="text-xs text-slate-500">Failed</p>
            <p className="font-semibold text-rose-400">{stats.failed}</p>
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
            <div className="w-16 shrink-0 text-right">Time</div>
          </div>

          <div className="flex-1 overflow-hidden">
            {leads.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
                <span>No leads yet.</span>
                <span>Submit an inquiry from the panel to begin the demo.</span>
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

// -----------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<CrmDashboard />);