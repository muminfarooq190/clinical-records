import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  FolderOpen,
  History,
  Layers3,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { api, json, Case, Detail, Fact, Change } from "./api";
import "./style.css";

function App() {
  const [cases, setCases] = useState<Case[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("local");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("timeline");
  const [source, setSource] = useState<{
    id: string;
    page: number;
    name: string;
    quote?: string;
  } | null>(null);
  const [editing, setEditing] = useState<Fact | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Change[] | null>(null);
  const [loading, setLoading] = useState(true);
  const activeCase = useRef(selected);
  activeCase.current = selected;
  const upload = useRef<HTMLInputElement>(null);

  async function loadCases() {
    const records = await api<Case[]>("/cases");
    setCases(records);
    return records;
  }
  async function refresh(id: string) {
    const next = await api<Detail>("/cases/" + id);
    if (activeCase.current === id) setDetail(next);
  }
  useEffect(() => {
    Promise.all([loadCases(), api<{ extraction: string }>("/config")])
      .then(([records, config]) => {
        setMode(config.extraction);
        if (records.length) setSelected(records[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    setDetail(null);
    setSource(null);
    setEditing(null);
    setHistory(null);
    setTab("timeline");
    async function poll() {
      try {
        const next = await api<Detail>("/cases/" + selected);
        if (!disposed) setDetail(next);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    void poll();
    const interval = setInterval(poll, 2500);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [selected]);

  async function createCase(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const record = await api<Case>("/cases", json("POST", { title }));
      await loadCases();
      setSelected(record.id);
      setCreating(false);
      setTitle("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sendFile(file: File) {
    if (!selected) return;
    const caseId = selected;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api<{ duplicate: boolean }>(
        "/cases/" + caseId + "/documents",
        { method: "POST", body: form },
      );
      setNotice(
        result.duplicate
          ? "This document is already in the case."
          : "Document uploaded. Processing will begin shortly.",
      );
      await refresh(caseId);
      await loadCases();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function addSample() {
    setError("");
    try {
      const response = await fetch("/api/sample");
      if (!response.ok) throw new Error("The sample could not be loaded.");
      await sendFile(
        new File([await response.blob()], "synthetic-discharge.pdf", {
          type: "application/pdf",
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function saveFact(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !selected) return;
    setBusy(true);
    setError("");
    try {
      await api(
        "/cases/" + selected + "/facts/" + editing.id,
        json("PATCH", { text: draft, revision: editing.revision }),
      );
      await refresh(selected);
      setEditing(null);
      setNotice(
        "Review saved. The original extraction is retained in the audit history.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function showHistory(fact: Fact) {
    try {
      setHistory(
        await api<Change[]>(
          "/cases/" + selected + "/facts/" + fact.id + "/history",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const facts = detail?.facts ?? [];
  const reviewed = facts.filter((f) => f.reviewed).length;
  const documents = detail?.documents ?? [];
  const processing = documents.filter((d) =>
    ["pending", "processing"].includes(d.status),
  ).length;
  const sourceUrl =
    source && selected
      ? "/api/cases/" +
        selected +
        "/documents/" +
        source.id +
        "/file#page=" +
        source.page
      : "";

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Activity size={22} />
          </span>
          <span>
            Clinical<span className="brand-light">Records</span>
          </span>
        </a>
        <div className="workspace">
          <span className="avatar">CR</span>
          <div>
            <strong>Review workspace</strong>
            <small>Local demonstration</small>
          </div>
          <ShieldCheck size={17} />
        </div>
        <div className="side-heading">
          CASES{" "}
          <button aria-label="Create case" onClick={() => setCreating(true)}>
            <Plus size={18} />
          </button>
        </div>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search cases"
            placeholder="Find a case…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav aria-label="Cases">
          {cases
            .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
            .map((c) => (
              <button
                className={"case-link " + (selected === c.id ? "active" : "")}
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setError("");
                  setNotice("");
                }}
              >
                <FolderOpen size={18} />
                <span>
                  {c.title}
                  <small>
                    {c.document_count} document
                    {c.document_count === 1 ? "" : "s"}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          {!loading && cases.length === 0 && (
            <p className="side-empty">Your cases will appear here.</p>
          )}
          {cases.length > 0 &&
            !cases.some((c) =>
              c.title.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="side-empty">No matching cases.</p>}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <div>
            <strong>Synthetic records only</strong>
            <small>Demo workspace · no sign-in</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={13} />{" "}
            <span>{detail?.record.title ?? "Cases"}</span>
          </div>
          <span className="version">
            PREVIEW <span>0.1</span>
          </span>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="banner error">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="banner notice">
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!selected ? (
            <section className="welcome">
              <span className="eyebrow">FROM DOCUMENTS TO CONTEXT</span>
              <h1>
                A clearer view
                <br />
                of every record.
              </h1>
              <p>
                Bring a case’s documents together. Review the extracted
                information, check its source, and keep a record of every
                correction.
              </p>
              <button className="primary" onClick={() => setCreating(true)}>
                <Plus size={17} /> Create your first case
              </button>
              <div className="welcome-grid">
                {[
                  [FileText, "Collect", "Upload text-based PDFs."],
                  [
                    Layers3,
                    "Understand",
                    "See information alongside its source.",
                  ],
                  [Check, "Review", "Save corrections with a history."],
                ].map(([Icon, label, description]) => {
                  const I = Icon as typeof FileText;
                  return (
                    <div key={String(label)}>
                      <I size={22} />
                      <strong>{String(label)}</strong>
                      <p>{String(description)}</p>
                    </div>
                  );
                })}
              </div>
              {loading && <p>Loading your workspace…</p>}
            </section>
          ) : !detail ? (
            <div className="loading">Loading case…</div>
          ) : (
            <>
              <section className="case-header">
                <div>
                  <span className="eyebrow">CASE WORKSPACE</span>
                  <h1>{detail.record.title}</h1>
                  <p>Every fact has a source. Every review leaves a trace.</p>
                </div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={17} />
                  {busy ? "Working…" : "Upload document"}
                </button>
              </section>
              <input
                ref={upload}
                type="file"
                accept="application/pdf"
                aria-label="Upload PDF"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void sendFile(file);
                }}
              />
              <section className="metrics">
                <div>
                  <FileText size={18} />
                  <span>
                    Documents
                    <strong>
                      {documents.length.toString().padStart(2, "0")}
                    </strong>
                  </span>
                </div>
                <div>
                  <Layers3 size={18} />
                  <span>
                    {mode === "local" ? "Source excerpts" : "Extracted facts"}
                    <strong>{facts.length.toString().padStart(2, "0")}</strong>
                  </span>
                </div>
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    Reviewed
                    <strong>
                      {reviewed.toString().padStart(2, "0")}
                      <small> / {facts.length}</small>
                    </strong>
                  </span>
                </div>
                <div>
                  <Clock3 size={18} />
                  <span>
                    Processing
                    <strong>{processing.toString().padStart(2, "0")}</strong>
                  </span>
                </div>
              </section>
              <div className="mode-note">
                <span className="status-dot" />
                {mode === "local"
                  ? "Local extraction · page excerpts are ready for manual review."
                  : "AI extraction · verify each fact against its source before accepting."}
              </div>
              <div className="tabs">
                <button
                  className={tab === "timeline" ? "selected" : ""}
                  onClick={() => setTab("timeline")}
                >
                  Review timeline <span>{facts.length}</span>
                </button>
                <button
                  className={tab === "documents" ? "selected" : ""}
                  onClick={() => setTab("documents")}
                >
                  Documents <span>{documents.length}</span>
                </button>
              </div>
              <div className={"review-layout " + (source ? "with-source" : "")}>
                <section className="review-list">
                  {tab === "timeline" && (
                    <>
                      <div className="list-heading">
                        <h2>Information to review</h2>
                        <span>Ordered by upload, then page</span>
                      </div>
                      {facts.map((fact) => (
                        <article className="fact-card" key={fact.id}>
                          <div className="fact-top">
                            <span className="fact-kind">{fact.kind}</span>
                            <span
                              className={
                                "review-tag " + (fact.reviewed ? "done" : "")
                              }
                            >
                              {fact.reviewed ? (
                                <>
                                  <Check size={12} /> Reviewed
                                </>
                              ) : (
                                "Needs review"
                              )}
                            </span>
                          </div>
                          <p className="fact-text">{fact.text}</p>
                          <button
                            className="source-link"
                            onClick={() =>
                              setSource({
                                id: fact.document_id,
                                page: fact.page,
                                name: fact.document_name,
                                quote: fact.quote,
                              })
                            }
                          >
                            <FileText size={14} />
                            {fact.document_name} · p. {fact.page}
                            <ArrowUpRight size={14} />
                          </button>
                          <div className="fact-footer">
                            <span>
                              {fact.provider === "local"
                                ? "Original page excerpt"
                                : "AI extracted"}
                              {fact.revision > 0 &&
                                " · revision " + fact.revision}
                            </span>
                            <div>
                              <button
                                onClick={() => void showHistory(fact)}
                                aria-label="View correction history"
                              >
                                <History size={15} />
                              </button>
                              <button
                                className="text-button"
                                onClick={() => {
                                  setEditing(fact);
                                  setDraft(fact.text);
                                }}
                              >
                                Review & edit
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                      {facts.length === 0 && (
                        <div className="empty">
                          <div className="empty-icon">
                            <Layers3 size={28} />
                          </div>
                          <h3>
                            {processing
                              ? "Building the case view"
                              : "Start with the original record"}
                          </h3>
                          <p>
                            {processing
                              ? "Your documents are being processed. This page updates automatically."
                              : documents.some((d) => d.status === "failed")
                                ? "A document needs attention. Open Documents to see the error and retry."
                                : documents.length
                                  ? "No facts were extracted. Open the document to review its contents."
                                  : "Upload a text-based PDF, or explore the workspace with a fictional discharge summary."}
                          </p>
                          {!documents.length && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() => void addSample()}
                            >
                              <Plus size={15} /> Try a synthetic record
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {tab === "documents" && (
                    <>
                      <div className="list-heading">
                        <h2>Original documents</h2>
                        <span>PDF · up to 10 MB each</span>
                      </div>
                      {documents.map((doc) => (
                        <article className="document-card" key={doc.id}>
                          <div className="document-icon">
                            <FileText size={24} />
                          </div>
                          <div className="document-info">
                            <strong>{doc.name}</strong>
                            <small>
                              {new Date(doc.created_at).toLocaleDateString()} ·{" "}
                              {doc.attempts} processing attempt
                              {doc.attempts === 1 ? "" : "s"}
                            </small>
                            {doc.error && (
                              <p className="document-error">{doc.error}</p>
                            )}
                          </div>
                          <div className="document-actions">
                            <span
                              className={
                                "review-tag " +
                                (doc.status === "ready" ? "done" : "")
                              }
                            >
                              {doc.status}
                            </span>
                            <button
                              className="text-button"
                              onClick={() =>
                                setSource({
                                  id: doc.id,
                                  page: 1,
                                  name: doc.name,
                                })
                              }
                            >
                              Open source
                            </button>
                            {doc.status === "failed" && (
                              <button
                                className="text-button"
                                onClick={async () => {
                                  try {
                                    await api(
                                      "/cases/" +
                                        selected +
                                        "/documents/" +
                                        doc.id +
                                        "/retry",
                                      { method: "POST" },
                                    );
                                    await refresh(selected);
                                  } catch (e) {
                                    setError((e as Error).message);
                                  }
                                }}
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                      {!documents.length && (
                        <div className="empty">
                          <FileText size={30} />
                          <h3>No documents yet</h3>
                          <p>Upload the first PDF to start this case.</p>
                        </div>
                      )}
                    </>
                  )}
                </section>
                {source ? (
                  <aside className="source-panel">
                    <div className="source-heading">
                      <div>
                        <span className="eyebrow">SOURCE DOCUMENT</span>
                        <strong>{source.name}</strong>
                      </div>
                      <button
                        aria-label="Close source"
                        onClick={() => setSource(null)}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    {source.quote && (
                      <blockquote>
                        <span>Original excerpt · page {source.page}</span>
                        {source.quote}
                      </blockquote>
                    )}
                    <a
                      className="source-open"
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PDF in new tab <ArrowUpRight size={14} />
                    </a>
                    <iframe
                      key={sourceUrl}
                      title="Original PDF"
                      src={sourceUrl}
                    />
                  </aside>
                ) : (
                  facts.length > 0 && (
                    <aside className="source-placeholder">
                      <FileText size={26} />
                      <h3>Keep the source in view</h3>
                      <p>
                        Select a document reference to compare the extracted
                        information with its original page.
                      </p>
                    </aside>
                  )
                )}
              </div>
            </>
          )}
          <footer>
            Clinical Records <span>Built for traceable review.</span>
          </footer>
        </div>
      </main>
      {creating && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
          >
            <button
              className="modal-close"
              aria-label="Close"
              onClick={() => setCreating(false)}
            >
              <X size={20} />
            </button>
            <span className="eyebrow">NEW WORKSPACE</span>
            <h2 id="new-title">Create a case</h2>
            <p>Give this collection of synthetic records a clear name.</p>
            <form onSubmit={createCase}>
              <label>
                Case title
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Alex Example · discharge review"
                />
              </label>
              <button className="primary" disabled={busy || !title.trim()}>
                {busy ? "Creating…" : "Create case"}
                <ChevronRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            className="modal wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
          >
            <button
              className="modal-close"
              aria-label="Close"
              onClick={() => setEditing(null)}
            >
              <X size={20} />
            </button>
            <span className="eyebrow">REVIEW INFORMATION</span>
            <h2 id="edit-title">Check and correct</h2>
            <blockquote>
              <span>Original source · page {editing.page}</span>
              {editing.quote}
            </blockquote>
            <form onSubmit={saveFact}>
              <label>
                Reviewed text
                <textarea
                  autoFocus
                  required
                  maxLength={4000}
                  rows={6}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              <p className="subtle">
                Saving marks this fact as reviewed and records the correction.
              </p>
              <button className="primary" disabled={busy || !draft.trim()}>
                <Check size={16} />
                {busy ? "Saving…" : "Save review"}
              </button>
            </form>
          </section>
        </div>
      )}
      {history !== null && (
        <div className="modal-backdrop">
          <section
            className="modal wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
          >
            <button
              className="modal-close"
              aria-label="Close"
              onClick={() => setHistory(null)}
            >
              <X size={20} />
            </button>
            <h2 id="history-title">Correction history</h2>
            {history.length === 0 ? (
              <p>No reviews have been saved for this fact.</p>
            ) : (
              history.map((change) => (
                <div className="history-item" key={change.revision}>
                  <strong>Revision {change.revision}</strong>
                  <small>{new Date(change.created_at).toLocaleString()}</small>
                  <p>
                    <span>Previous</span>
                    {change.previous_text}
                  </p>
                  <p>
                    <span>Saved</span>
                    {change.new_text}
                  </p>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
