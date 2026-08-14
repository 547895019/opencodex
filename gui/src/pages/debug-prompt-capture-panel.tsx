import { Fragment, useState } from "react";
import { useI18n } from "../i18n/shared";
import type { PromptCaptureEntry, PromptCaptureRedaction } from "./debug-shared";
import { formatClaudeInboundTime } from "./debug-shared";

export function DebugPromptCapturePanel({
  entries,
  redaction,
  maxEntries,
  busy,
  onSetOptions,
  onClear,
}: {
  entries: PromptCaptureEntry[];
  redaction: PromptCaptureRedaction;
  maxEntries: number;
  busy: boolean;
  onSetOptions: (opts: { redaction?: PromptCaptureRedaction; maxEntries?: number }) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div className="font-semibold" style={{ marginBottom: 4 }}>{t("debug.promptCapture.title")}</div>
      <div className="muted text-control" style={{ marginBottom: 10 }}>{t("debug.promptCapture.sub")}</div>
      <div style={{ border: "1px solid var(--danger, #d33)", borderRadius: 6, padding: "8px 10px", marginBottom: 12, background: "var(--danger-bg, rgba(221,51,51,0.08))" }}>
        <span style={{ color: "var(--danger, #d33)", fontWeight: 600 }}>⚠ {t("debug.promptCapture.warning")}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="text-control">{t("debug.promptCapture.redaction")}</span>
          <select
            value={redaction}
            disabled={busy}
            onChange={e => onSetOptions({ redaction: e.target.value as PromptCaptureRedaction })}
          >
            <option value="secrets">{t("debug.promptCapture.redactionSecrets")}</option>
            <option value="secrets-pii">{t("debug.promptCapture.redactionSecretsPii")}</option>
            <option value="none">{t("debug.promptCapture.redactionNone")}</option>
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="text-control">{t("debug.promptCapture.maxEntries")}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={maxEntries}
            disabled={busy}
            style={{ width: 72 }}
            onChange={e => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1 && v <= 200) onSetOptions({ maxEntries: Math.floor(v) });
            }}
          />
        </label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClear}>
          {t("debug.promptCapture.clear")}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="muted text-control">{t("debug.promptCapture.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table text-label">
            <thead>
              <tr>
                <th>{t("debug.promptCapture.time")}</th>
                <th>{t("debug.promptCapture.surface")}</th>
                <th>{t("debug.promptCapture.model")}</th>
                <th>{t("debug.promptCapture.bodySize")}</th>
                <th>{t("debug.promptCapture.redaction")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <Fragment key={`${entry.at}-${i}`}>
                  <tr>
                    <td className="muted mono">{formatClaudeInboundTime(entry.at)}</td>
                    <td className="mono">{entry.surface}</td>
                    <td className="mono" title={entry.resolvedModel}>
                      {entry.model}
                      {entry.resolvedModel && entry.resolvedModel !== entry.model && (
                        <span className="muted"> → {entry.resolvedModel}</span>
                      )}
                    </td>
                    <td className="mono">{entry.bodySize >= 0 ? entry.bodySize : "?"}</td>
                    <td className="mono">{entry.redaction}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setExpanded(expanded === i ? null : i)}
                      >
                        {expanded === i ? t("debug.promptCapture.hideBody") : t("debug.promptCapture.viewBody")}
                      </button>
                    </td>
                  </tr>
                  {expanded === i && (
                    <tr>
                      <td colSpan={6}>
                        <pre className="mono" style={{ maxHeight: 420, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, margin: 0 }}>
                          {(() => {
                            try { return JSON.stringify(entry.body, null, 2); } catch { return String(entry.body); }
                          })()}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
