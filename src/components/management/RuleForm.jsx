import { useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { draftToPayload, validateRuleDraft } from "../../utils/notificationRules";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";
import { RecipientPicker } from "./RecipientPicker";

const SEVERITY_TEXT = { any: "Any severity", Informational: "Informational", Warning: "Warning", "High Risk": "High Risk" };

function FieldError({ id, message }) {
  return message ? (
    <p id={id} className="danger-text field-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function RuleForm({ draft: initial, catalog, onClose, onSaved }) {
  const { notify } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  // After the first attempt the messages follow the form, so a fixed problem clears.
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateRuleDraft(draft) : {};
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const setEscalation = (field, value) => setDraft((current) => ({ ...current, escalation: { ...current.escalation, [field]: value } }));
  const editing = Boolean(draft.id);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setAttempted(true);
    setServerError("");
    if (Object.keys(validateRuleDraft(draft)).length) return;
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      const saved = editing ? await api.updateNotificationRule(draft.id, payload) : await api.createNotificationRule(payload);
      notify(`Rule “${saved.name}” saved.`);
      onSaved(saved);
    } catch (error) {
      setServerError(error.message);
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit rule: ${initial.name}` : "New notification rule"} onClose={() => !saving && onClose()} wide>
      <form className="rule-form" onSubmit={submit} noValidate>
        <p className="muted">A rule only decides who is told. It never changes an expense or sends it for approval.</p>
        {serverError && (
          <p className="validation-errors" role="alert">
            {serverError}
          </p>
        )}
        <label className="field">
          Rule name
          <input
            value={draft.name}
            maxLength={120}
            required
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "rule-name-error" : undefined}
            onChange={(event) => set("name", event.target.value)}
          />
        </label>
        <FieldError id="rule-name-error" message={errors.name} />
        <label className="field">
          Description (optional)
          <input value={draft.description} maxLength={500} onChange={(event) => set("description", event.target.value)} />
        </label>

        <fieldset className="anomaly-picker" aria-describedby={errors.anomalyTypes ? "rule-types-error" : undefined}>
          <legend>Anomaly types</legend>
          <div className="anomaly-options">
            {catalog.anomalyTypes.map((type) => (
              <label key={type.id} className={`checkbox-label ${type.available ? "" : "is-unavailable"}`}>
                <input
                  type="checkbox"
                  checked={draft.anomalyTypes.includes(type.id)}
                  onChange={(event) =>
                    set("anomalyTypes", event.target.checked ? [...draft.anomalyTypes, type.id] : draft.anomalyTypes.filter((id) => id !== type.id))
                  }
                />
                <span>
                  {type.name}
                  {!type.available && <small>{type.unavailableReason}</small>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <FieldError id="rule-types-error" message={errors.anomalyTypes} />

        <div className="form-grid">
          <label className="field">
            Severity
            <select value={draft.severity} onChange={(event) => set("severity", event.target.value)}>
              {catalog.severities.map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_TEXT[severity] ?? severity}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Notify
            <select value={draft.trigger} onChange={(event) => set("trigger", event.target.value)}>
              {catalog.triggers.map((trigger) => (
                <option key={trigger.id} value={trigger.id}>
                  {trigger.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Channel
            <select value={draft.channel} onChange={(event) => set("channel", event.target.value)}>
              {catalog.channels.map((channel) => (
                <option key={channel.id} value={channel.id} disabled={!channel.available}>
                  {channel.label}
                  {channel.available ? "" : " (not connected)"}
                </option>
              ))}
            </select>
          </label>
        </div>

        <RecipientPicker
          idPrefix="rule-recipients"
          label="Recipients"
          recipients={draft.recipients}
          recipientTypes={catalog.recipientTypes}
          onChange={(value) => set("recipients", value)}
          describedBy={errors.recipients ? "rule-recipients-error" : undefined}
        />
        <FieldError id="rule-recipients-error" message={errors.recipients} />
        <p className="muted">People other than Finance see only the request number and the kind of finding. They can’t open another employee’s request.</p>

        <details className="additional-fields" open={draft.escalation.enabled}>
          <summary>Escalation (optional)</summary>
          <label className="checkbox-label">
            <input type="checkbox" checked={draft.escalation.enabled} onChange={(event) => setEscalation("enabled", event.target.checked)} />
            Tell more people if a notification stays unread
          </label>
          {draft.escalation.enabled && (
            <>
              <label className="field">
                Wait this many hours
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={draft.escalation.afterHours}
                  onChange={(event) => setEscalation("afterHours", Number(event.target.value))}
                />
              </label>
              <RecipientPicker
                idPrefix="rule-escalation"
                label="Escalate to"
                recipients={draft.escalation.recipients}
                recipientTypes={catalog.recipientTypes}
                onChange={(value) => setEscalation("recipients", value)}
              />
            </>
          )}
          <FieldError id="rule-escalation-error" message={errors.escalation} />
        </details>

        <label className="checkbox-label">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => set("enabled", event.target.checked)} />
          Enabled
        </label>
        <footer>
          <button type="button" className="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <Spinner />}
            {saving ? "Saving…" : "Save rule"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
